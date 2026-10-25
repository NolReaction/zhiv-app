import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  cacheDir: `/tmp/zhiv-v13-runtime-${process.pid}`, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const trade = await vite.ssrLoadModule("/features/economy/domain/trade-relations.ts");
const leaftail = await vite.ssrLoadModule("/features/economy/domain/leaftail-shop.ts");
const effort = await vite.ssrLoadModule("/features/economy/domain/order-effort.ts");
const journal = await vite.ssrLoadModule("/features/economy/sync/production-journal.ts");
const { worldRecipeGroups } = await vite.ssrLoadModule("/features/economy/ui/stations/world-recipe-groups.ts");
const { worldMaterialSource } = await vite.ssrLoadModule("/features/economy/ui/shared/world-stations.ts");
const { WorldExpeditionSector } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const catalog = model.economyCatalog;
const now = Date.parse("2026-10-26T12:00:00.000Z");
const iso = timestamp => new Date(timestamp).toISOString();
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
function developed() {
  const state = fresh();
  state.buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  state.progression.recipes = Object.fromEntries(catalog.recipes.map(recipe => [recipe.id, 100]));
  state.wallet = { coins: 100_000, pearls: 10_000 };
  return state;
}
const command = (action, targetId) => ({ requestId: crypto.randomUUID(), ownerPublicId: "TEST-TEST-TEST",
  expectedRevision: 0, action, targetId, quantity: 1, totalPrice: 0 });
const apply = (state, action, targetId, at = now, extra = {}) =>
  rules.applyEconomyCommand(state, { ...command(action, targetId), ...extra }, at, () => crypto.randomUUID(), {}, () => 0);
const view = state => ({ ...structuredClone(state), catalog: structuredClone(catalog), storage: rules.economyStorage(state),
  ownerPublicId: "TEST-TEST-TEST", serverTime: iso(now), revision: 0 });
const oldJob = (patch = {}) => ({ id: crypto.randomUUID(), kind: "exploration", actorId: "miner", targetId: "quarry_clay_night",
  recipeId: null, targetLevel: null, startedAt: iso(now - 8 * 3600000), finishesAt: iso(now),
  rewards: { clay: 48 }, cost: { coins: 0, items: {} }, catalogVersion: 12, ...patch });
const policy = () => ({ version: 1, coinsPerMinute: 10, constructionCoinsPerMinute: 10, orderBonusBps: 2500,
  baselineRecipes: { berries: "grow_berries" }, baselineExplorations: {}, externalPrices: {} });

test("catalog 13 preserves declared sources and all historic catalog/job versions remain readable", () => {
  const candidate = structuredClone(catalog);
  candidate.version = 13; candidate.timeEconomy = policy();
  assert.deepEqual(model.economyCatalogSchema.parse(candidate).timeEconomy, candidate.timeEconomy);
  delete candidate.timeEconomy;
  assert.equal(model.economyCatalogSchema.safeParse(candidate).success, false);
  for (const version of [10, 11, 12]) {
    candidate.version = version;
    assert.equal(model.economyCatalogSchema.parse(candidate).version, version);
  }
  for (const catalogVersion of [1, 6, 10, 11, 12, 13])
    assert.equal(model.economyJobSchema.parse(oldJob({ catalogVersion })).catalogVersion, catalogVersion);
});

test("price policy cannot resolve an unknown, retired, wrong-output or multiply priced source", () => {
  const candidate = structuredClone(catalog);
  candidate.version = 13; candidate.timeEconomy = policy();
  const invalid = change => {
    const value = structuredClone(candidate); change(value);
    assert.equal(model.economyCatalogSchema.safeParse(value).success, false);
  };
  invalid(value => { value.timeEconomy.baselineRecipes.berries = "missing_recipe"; });
  invalid(value => { value.timeEconomy.baselineRecipes.berries = "make_planks"; });
  invalid(value => { value.recipes.find(recipe => recipe.id === "grow_berries").retired = true; });
  invalid(value => { value.timeEconomy.externalPrices.berries = 10; });
  invalid(value => { value.timeEconomy.externalPrices.unknown = 10; });
});

test("retired production and mining reject direct starts without changing paid stock or progress", () => {
  const recipe = { ...structuredClone(catalog.recipes.find(recipe => recipe.id === "make_planks")), id: "compat_old_planks", retired: true };
  const route = { ...structuredClone(catalog.explorations.find(route => route.activity === "mining")), id: "compat_old_quarry", retired: true };
  catalog.recipes.push(recipe); catalog.explorations.push(route);
  try {
    for (const [action, source] of [["start_production", recipe], ["start_exploration", route]]) {
      const state = developed(); state.inventory = { wood: 5 };
      const before = structuredClone(state);
      assert.throws(() => apply(state, action, source.id), { code: "ECONOMY_SOURCE_RETIRED" });
      assert.deepEqual(state, before);
    }
  } finally { catalog.recipes.pop(); catalog.explorations.pop(); }
});

test("a historic eight-hour mining result retains its saved timer and 48 clay, exactly once", () => {
  const state = developed(); state.inventory = {};
  const job = oldJob(); state.jobs = [job];
  const before = structuredClone(state);
  assert.throws(() => apply(state, "claim_job", job.id, now - 1), { code: "ECONOMY_JOB_NOT_READY" });
  assert.deepEqual(state, before);
  apply(state, "claim_job", job.id);
  assert.equal(state.inventory.clay, 48);
  assert.equal(state.jobs.length, 0);
  assert.equal(state.progression.routes[job.targetId], 1);
  assert.throws(() => apply(state, "claim_job", job.id), { code: "ECONOMY_JOB_GONE" });
  assert.equal(state.inventory.clay, 48);
});

test("a saved production result is claimed from its snapshot even if today's recipe changed", () => {
  const state = developed(); state.inventory = {};
  const job = oldJob({ kind: "production", actorId: undefined, targetId: "workshop", recipeId: "make_planks", rewards: { planks: 7 },
    cost: { coins: 43, items: { wood: 3 } } });
  state.jobs = [job];
  apply(state, "claim_job", job.id);
  assert.deepEqual(state.inventory, { planks: 7 });
  assert.equal(state.progression.recipes.make_planks, 101, "one saved job counts as one completed recipe");
});

test("new one-unit mining uses the current definition and remains independent from the hero", () => {
  const state = developed(); state.inventory = {};
  const route = catalog.explorations.find(route => !route.retired && route.activity === "mining"
    && Object.values(route.rewards).reduce((sum, quantity) => sum + quantity, 0) === 1);
  assert(route);
  state.jobs = [oldJob({ actorId: "mochlik", targetId: "forest_walk", finishesAt: iso(now + 1000), rewards: { wood: 1 } })];
  apply(state, "start_exploration", route.id);
  const job = state.jobs.find(job => job.targetId === route.id);
  assert.equal(job.actorId, "miner");
  assert.equal(job.catalogVersion, catalog.version);
  assert.equal(Date.parse(job.finishesAt) - now, route.seconds * 1000);
  assert.deepEqual(job.rewards, route.rewards);
  assert.equal(model.economyJobSchema.parse(job).catalogVersion, catalog.version);
});

test("new orders keep whole-coin payouts while already accepted terms retain their old payment", () => {
  const template = { id: "compat_order", residentId: "builder", name: "Snapshot", items: { wood: 1 }, coins: 13, requiredHomeLevel: 1, requiredBuildings: {} };
  assert.equal(food.progressedResidentOrderTemplate(template, 1, { ...catalog, version: 13 }).coins, 13);
  assert.equal(food.progressedResidentOrderTemplate(template, 1, { ...catalog, version: 12 }).coins, 20);
  const state = developed();
  state.residentOrders = food.normalizedResidentOrders(state, now);
  const slot = state.residentOrders.slots.find(slot => slot.residentId === "builder" && slot.terms);
  assert(slot);
  slot.terms = { ...slot.terms, items: { wood: 2 }, coins: 77 };
  state.inventory = { wood: 2 };
  const offer = food.residentOrderBoard(state, now).offers.find(offer => offer.residentId === "builder");
  assert.equal(offer.coins, 77);
  const coins = state.wallet.coins;
  apply(state, "complete_resident_order", offer.id);
  assert.equal(state.wallet.coins - coins, 77);
  assert.equal(state.inventory.wood, undefined);
  assert.throws(() => apply(state, "complete_resident_order", offer.id));
  assert.equal(state.wallet.coins - coins, 77);
});

test("retired sources cannot unlock an item, appear as a production method or reserve an offline slot", () => {
  const state = view(developed());
  const recipe = { ...structuredClone(catalog.recipes.find(recipe => recipe.id === "make_planks")), id: "compat_old_planks", retired: true };
  state.catalog.recipes.push(recipe);
  assert.equal(worldRecipeGroups(state, [recipe], { includeFuture: true }).length, 0);
  assert.equal(journal.safeProductionRecipe(state, recipe.id), null);
  state.catalog.recipes = state.catalog.recipes.map(recipe => ({ ...recipe, retired: true }));
  state.catalog.explorations = state.catalog.explorations.map(route => ({ ...route, retired: true }));
  assert.equal(effort.obtainableResidentOrderItems(state, state.catalog).size, 0);
  assert.equal(worldMaterialSource(state, "clay"), null);
});

test("alternative production cycles cannot poison estimates for other ordered ingredients", () => {
  const state = developed();
  for (const [itemId, seconds] of [["charcoal", 480], ["ceramic_jar", 1140], ["packed_berries", 2748]]) {
    const first = effort.orderEffort(state, { wood: 1, [itemId]: 1 });
    const reversed = effort.orderEffort(state, { [itemId]: 1, wood: 1 });
    assert.deepEqual(first, reversed, `${itemId}: the target order cannot change the plan`);
    assert.equal(first.obtainable, true, itemId);
    assert.equal(first.effortSeconds, seconds, itemId);
  }
});

test("saved order promises survive retired sources and raised gates, while new cards require sustainable availability", () => {
  for (const change of ["retired", "source-gate", "resident-gate"]) {
    const state = developed();
    state.residentOrders = food.normalizedResidentOrders(state, now);
    const residentId = change === "resident-gate" ? "leaftail" : "builder";
    const slot = state.residentOrders.slots.find(slot => slot.residentId === residentId && slot.terms);
    assert(slot);
    slot.terms = { ...slot.terms, items: { clay: 2 }, coins: 77 };
    state.inventory = { clay: 2 };
    const offer = food.residentOrderBoard(state, now).offers.find(offer => offer.residentId === residentId);
    assert(offer);
    const sources = [...catalog.recipes, ...catalog.explorations].filter(source => source.rewards.clay > 0);
    const savedSources = sources.map(source => structuredClone(source));
    const oldResidentGate = catalog.leaftailShop.requiredHomeLevel;
    try {
      if (change === "retired") sources.forEach(source => { source.retired = true; });
      if (change === "source-gate") {
        state.buildings.home = 1;
        sources.forEach(source => { source.requiredHomeLevel = 5; });
      }
      if (change === "resident-gate") {
        state.buildings.home = 3;
        catalog.leaftailShop.requiredHomeLevel = 5;
      }
      if (change !== "resident-gate") {
        assert.equal(effort.obtainableResidentOrderItems(state).has("clay"), false);
        assert(food.eligibleResidentOrderTemplates(state).every(template => !template.items.clay));
      } else assert(food.eligibleResidentOrderTemplates(state).every(template => template.residentId !== "leaftail"));
      assert.deepEqual(food.residentOrderBoard(state, now).offers.find(current => current.id === offer.id), offer);
      const coins = state.wallet.coins;
      apply(state, "complete_resident_order", offer.id);
      assert.equal(state.wallet.coins - coins, 77);
      assert.equal(state.inventory.clay, undefined);
      assert.throws(() => apply(state, "complete_resident_order", offer.id));
      assert.equal(state.wallet.coins - coins, 77);
    } finally {
      sources.forEach((source, index) => {
        delete source.retired;
        Object.assign(source, savedSources[index]);
      });
      catalog.leaftailShop.requiredHomeLevel = oldResidentGate;
    }
  }
});

test("an accepted weekly delivery keeps its saved terms after a source is retired", () => {
  const state = developed();
  const candidate = trade.weeklyOrderBoard(state, now).offers.find(offer => offer.residentId === "builder");
  assert(candidate);
  trade.acceptWeeklyOrder(state, candidate, now);
  const saved = state.tradeRelations.weekly;
  saved.stages[0] = { ...saved.stages[0], items: { clay: 2 }, coins: 77 };
  state.inventory = { clay: 2 };
  const offer = trade.weeklyOrderBoard(state, now).active;
  const sources = [...catalog.recipes, ...catalog.explorations].filter(source => source.rewards.clay > 0);
  const retired = sources.map(source => source.retired);
  try {
    sources.forEach(source => { source.retired = true; });
    assert.equal(effort.obtainableResidentOrderItems(state).has("clay"), false);
    assert.deepEqual(trade.weeklyOrderBoard(state, now).active, offer);
    const coins = state.wallet.coins;
    apply(state, "complete_resident_order", offer.id);
    assert.equal(state.wallet.coins - coins, 77);
    assert.equal(state.inventory.clay, undefined);
    assert.equal(state.tradeRelations.weekly.stage, 1);
    assert.throws(() => apply(state, "complete_resident_order", offer.id));
    assert.equal(state.wallet.coins - coins, 77);
  } finally {
    sources.forEach((source, index) => {
      if (retired[index] === undefined) delete source.retired;
      else source.retired = retired[index];
    });
  }
});

test("commands reject injected catalogs and LeafTail validates today's price without resetting purchased stock", () => {
  const state = developed();
  const shop = leaftail.leaftailShopView({ ...state, ownerPublicId: "TEST-TEST-TEST" }, now);
  const offer = shop.offers.find(offer => offer.kind === "item" && offer.currency === "coins" && offer.unitPrice > 1 && offer.remaining > 1);
  assert(offer);
  state.leaftailShop = { cycle: shop.cycle, purchased: { [offer.id]: 1 } };
  const input = { ...command("buy_leaftail_item", offer.targetId), totalPrice: offer.unitPrice };
  assert.equal(model.economyCommandSchema.safeParse(input).success, true);
  assert.equal(model.economyCommandSchema.safeParse({ ...input, catalog: { version: 12 } }).success, false);
  const before = structuredClone(state);
  assert.throws(() => apply(state, "buy_leaftail_item", offer.targetId, now, { totalPrice: offer.unitPrice - 1 }),
    { code: "ECONOMY_LEAFTAIL_PRICE_CHANGED" });
  assert.deepEqual(state, before);
  apply(state, "buy_leaftail_item", offer.targetId, now, { totalPrice: offer.unitPrice });
  assert.equal(state.wallet.coins, before.wallet.coins - offer.unitPrice);
  assert.equal(state.leaftailShop.purchased[offer.id], 2);
  assert.equal(state.inventory[offer.itemId], (before.inventory[offer.itemId] ?? 0) + 1);
});

test("v13 mining offers products without legacy duration filters or retired bulk cards", () => {
  const state = view(developed()); state.catalog.version = 13;
  state.catalog.explorations.push({ ...structuredClone(catalog.explorations.find(route => route.activity === "mining")),
    id: "quarry_compat_old", name: "REMOVED BULK SHIFT", retired: true });
  const economy = { snapshot: state, now, busy: false, uncertain: false, retryAt: 0, act() {}, refresh() {}, error: null };
  const html = renderToStaticMarkup(createElement(WorldExpeditionSector, { sectorId: "caves", selectedRoute: null,
    onSelectRoute() {}, economy, state, exploring: false, onOpenPantry() {} }));
  assert.doesNotMatch(html, /data-mining-duration|REMOVED BULK SHIFT|quarry_compat_old/);
  assert.match(html, /Добыча по ресурсам/);
});

test("linear five-minute construction quote rounds once and charges only actual remaining time", () => {
  const config = { secondsPerPearl: 7500, priceStepPearls: 2,
    pricingPoints: [{ seconds: 300, pearls: 2 }, { seconds: 600, pearls: 4 }] };
  for (const [seconds, raw] of [[0, 0], [1, 2], [300, 2], [301, 4], [3600, 24], [86400, 576], [172800, 1152]])
    assert.equal(rules.constructionTimePearlPrice(seconds, config), raw);
  assert.equal(rules.constructionSpeedupPrice({ kind: "construction", finishesAt: iso(now + 300_001) }, now, config), 4);
  assert.equal(rules.constructionSpeedupPrice({ kind: "construction", finishesAt: iso(now + 300_001) }, now + 1, config), 2);
});
