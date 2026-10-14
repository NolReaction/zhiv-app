import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-10-14T09:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const read = (p, minutes = 0) => economy.getDevEconomy(p.token, now + minutes * 60000);
const player = () => {
  const p = identities.createDevIdentity("Второе хозяйство", crypto.randomUUID()); read(p);
  const state = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
  state.wallet = { coins: 50, pearls: 0 }; state.inventory = {};
  Object.assign(state.buildings, { home: 2, garden: 1, warehouse: 1, woodlot: 1, dryer: 1, workshop: 1, quarry: 0, kiln: 0 });
  state.tutorialOrder = { version: 2, step: 4, completed: true, ingredientsClaimed: true, terms: null };
  return p;
};
const send = (p, action, targetId, minutes = 0, extra = {}) => economy.commandDevEconomy(p.token, {
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, minutes).revision,
  action, targetId, quantity: 1, totalPrice: 0, ...extra,
}, now + minutes * 60000).state;
const recipe = id => model.economyCatalog.recipes.find(entry => entry.id === id);
const route = id => model.economyCatalog.explorations.find(entry => entry.id === id);

// A concrete feasible schedule, rather than a claim about the shortest possible route.
const secondStageSchedule = withWarehouse => {
  const events = []; let index = 0;
  const add = (minute, action, target) => events.push({ minute, action, target, index: index++ });
  const runs = (id, begin, count, duration, mining = false) => {
    for (let i = 0; i < count; i++) {
      add(begin + i * duration, mining ? "start_exploration" : "start_production", id);
      add(begin + (i + 1) * duration, "claim", id);
    }
  };
  runs("gather_fiber", 0, 2, 1); runs("gather_wood", 2, 1, 3);
  runs("gather_fiber", 5, 2, 1); runs("gather_wood", 7, 3, 3);
  runs("make_rope", 2, 1, 3); runs("make_rope", 7, 1, 3);
  runs("make_planks", 5, 1, 2); runs("make_planks", 10, 1, 2);
  runs("gather_fiber", 16, 4, 1); runs("gather_wood", 20, 3, 3);
  runs("make_planks", 24, 1, 2); runs("make_planks", 26, 1, 2); runs("make_planks", 29, 1, 2);
  runs("make_rope", 18, 2, 3);
  runs("gather_fiber", 29, 4, 1); runs("gather_wood", 33, 3, 3);
  runs("make_rope", 31, 2, 3);
  runs("make_planks", 37, 2, 2); runs("make_planks", 42, 1, 2);
  runs("gather_wood", 42, 8, 3);
  for (let i = 0; i < 8; i++) runs("make_planks", 45 + i * 3, 1, 2);
  runs("gather_fiber", 66, 8, 1); runs("make_rope", 68, 4, 3);
  runs("gather_wood", 74, 12, 3);
  runs("quarry_stone", 21, 11, 3, true);
  runs("quarry_clay", 65, 6, 3, true);
  runs("quarry_stone", 83, 8, 3, true);
  runs("quarry_clay", 107, 10, 3, true);
  runs("make_charcoal", 105, 12, 2); runs("fire_bricks", 129, 10, 3);
  for (const [id, begin, end] of [["quarry", 16, 21], ["quarry", 55, 65], ["kiln", 95, 105], ["home", 159, 179],
    ...(withWarehouse ? [["warehouse", 45, 55]] : [])]) { add(begin, "start_construction", id); add(end, "claim_building", id); }
  for (const [minute, id] of [[10, "stage2_rope_order"], [39, "stage2_stone_order"], [77, "stage2_clay_order"],
    [109, "stage2_charcoal_order"], [141, "stage2_bricks_order"]]) add(minute, "complete_resident_order", id);
  // Deliver inputs and orders before starting work at the same minute.
  const priority = action => ["claim", "claim_building"].includes(action) ? 0 : action === "complete_resident_order" ? 1 : 2;
  return events.sort((a, b) => a.minute - b.minute || priority(a.action) - priority(b.action) || a.index - b.index);
};

for (const withWarehouse of [true, false]) test(`a real 179-minute house-two route completes seven orders and house three ${withWarehouse ? "with the optional warehouse" : "in the original 50-place warehouse"}`, t => {
  const p = player(), produced = {}, raw = {}, costs = [], orders = [], caught = {}, sold = {};
  const events = secondStageSchedule(withWarehouse); let peak = 0, cast = 0, fishSaleCoins = 0, cooked = 0, previousMinute = 0;
  const check = state => {
    peak = Math.max(peak, state.storage.used);
    assert.ok(state.storage.used <= state.storage.capacity); assert.equal(state.wallet.pearls, 0); assert.deepEqual(state.productionSlots, {});
    assert.ok(state.jobs.filter(job => job.kind === "construction").length <= 1);
    for (const id of ["woodlot", "workshop", "kiln", "dryer"]) assert.ok(state.jobs.filter(job => job.kind === "production" && job.targetId === id).length <= 1);
    for (const actorId of ["miner", "mochlik"]) assert.ok(state.jobs.filter(job => job.kind === "exploration" && job.actorId === actorId).length <= 1);
    assert.ok(state.jobs.every(job => !job.meal));
  };
  const queue = (minute, action, target) => {
    events.push({ minute, action, target, index: events.length });
    const priority = action => ["claim", "claim_building", "claim_fish"].includes(action) ? 0 : action === "complete_resident_order" ? 1 : 2;
    events.sort((a, b) => a.minute - b.minute || priority(a.action) - priority(b.action) || a.index - b.index);
  };
  const fish = minute => {
    assert.ok(cast < 30, "the bounded schedule must obtain nine common fish from actual catches");
    // Fixed server entropy makes the fixture repeatable; every catch still uses the
    // normal class/species sampler. Seeds are sequential, never chosen for outcomes.
    globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state.fishingCastSeed =
      `00000000-0000-4000-8000-${String(++cast).padStart(12, "0")}`;
    const state = send(p, "start_fishing", "shore", minute); check(state);
    if (cast === 1) assert.ok(state.jobs.some(job => job.actorId === "miner"), "the mine and fishing use independent actor queues");
    const job = state.jobs.find(job => job.fishing);
    assert.equal(job.actorId, "mochlik"); assert.equal(job.fishing.rodId, "reed_rod"); assert.equal(job.fishing.baitId, null);
    queue((Date.parse(job.finishesAt) - now) / 60000, "claim_fish", job.id);
  };
  queue(21, "start_fish", "shore");
  while (events.length) {
    const event = events.shift(); assert.ok(event.minute >= previousMinute, "the route never rewinds its clock"); previousMinute = event.minute;
    let state;
    if (event.action === "start_fish") {
      fish(event.minute); state = read(p, event.minute);
    } else if (event.action === "claim_fish") {
      const before = read(p, event.minute); state = send(p, "claim_job", event.target, event.minute); check(state);
      // Decisions use only delivered public inventory, never an unclaimed private catch.
      for (const group of model.economyCatalog.fishing.classes) {
        const count = (state.inventory[group.itemId] ?? 0) - (before.inventory[group.itemId] ?? 0);
        if (count) caught[group.itemId] = (caught[group.itemId] ?? 0) + count;
        const surplus = group.itemId === "fish_common" ? Math.max(0, (caught.fish_common ?? 0) - 9) - (sold.fish_common ?? 0) : count;
        if (surplus) {
          const coins = state.wallet.coins;
          state = send(p, "sell_fish", group.itemId, event.minute, { quantity: surplus }); check(state);
          fishSaleCoins += state.wallet.coins - coins; sold[group.itemId] = (sold[group.itemId] ?? 0) + surplus;
        }
      }
      assert.equal(state.fishingCastSeed, undefined, "server entropy is never exposed in the API");
      if ((caught.fish_common ?? 0) < 9) fish(event.minute);
    } else if (["claim", "claim_building"].includes(event.action)) {
      const job = read(p, event.minute).jobs.find(entry => event.action === "claim_building"
        ? entry.kind === "construction" && entry.targetId === event.target
        : entry.recipeId === event.target || entry.kind === "exploration" && entry.targetId === event.target);
      assert.ok(job, `missing ${event.target} at minute ${event.minute}`);
      state = send(p, "claim_job", job.id, event.minute);
      for (const [id, count] of Object.entries(job.rewards)) (Object.keys(job.cost.items).length ? produced : raw)[id] = ((Object.keys(job.cost.items).length ? produced : raw)[id] ?? 0) + count;
    } else {
      const before = read(p, event.minute); state = send(p, event.action, event.target, event.minute);
      if (event.action === "start_construction" && event.target === "home") {
        assert.equal(before.stageOrders.stages["2"].step, 7); assert.equal(before.stageOrders.stages["2"].completed, true);
        assert.equal(before.progression.recipes.cook_grilled_fish, 3); assert.ok(!before.jobs.some(job => job.fishing));
      }
      if (event.action === "start_construction") costs.push(before.wallet.coins - state.wallet.coins);
      if (event.action === "complete_resident_order") orders.push(state.wallet.coins - before.wallet.coins);
    }
    check(state);
    if (cooked < 3 && (state.inventory.fish_common ?? 0) > 0 && !state.jobs.some(job => job.kind === "production" && job.targetId === "dryer")) {
      state = send(p, "start_production", "cook_grilled_fish", event.minute); cooked++; check(state);
      queue(event.minute + recipe("cook_grilled_fish").seconds / 60, "claim", "cook_grilled_fish");
    }
    if (state.stageOrders.stages["2"].step === 5 && (state.inventory.fish_common ?? 0) >= 6) {
      const coins = state.wallet.coins; state = send(p, "complete_resident_order", "stage2_fish_order", event.minute);
      orders.push(state.wallet.coins - coins); check(state);
    }
    if (state.stageOrders.stages["2"].step === 6 && (state.inventory.grilled_fish ?? 0) >= 3) {
      const coins = state.wallet.coins; state = send(p, "complete_resident_order", "stage2_fish_meal_order", event.minute);
      orders.push(state.wallet.coins - coins); check(state);
    }
  }
  const finish = read(p, 179);
  assert.equal(finish.buildings.home, 3); assert.equal(finish.buildings.quarry, 2); assert.equal(finish.buildings.kiln, 1);
  assert.equal(finish.buildings.warehouse, withWarehouse ? 2 : 1); assert.equal(finish.jobs.length, 0);
  assert.deepEqual(raw, { fiber: 20, wood: 30, stone: 19, clay: 16 });
  assert.deepEqual(produced, { rope: 10, planks: 16, grilled_fish: 3, charcoal: 12, bricks: 10 });
  assert.deepEqual(orders, [90, 360, 180, 150, 600, 360, 250]); assert.equal(orders.reduce((sum, value) => sum + value, 0), 1990);
  assert.equal((caught.fish_common ?? 0) - (sold.fish_common ?? 0), 9);
  assert.equal(Object.values(caught).reduce((sum, value) => sum + value, 0), cast * 2);
  assert.equal(Object.values(finish.fishing.catches).reduce((sum, value) => sum + value, 0), cast * 2);
  for (const [id, quantity] of Object.entries(caught)) if (id !== "fish_common") assert.equal(sold[id], quantity);
  assert.equal(costs.reduce((sum, value) => sum + value, 0), withWarehouse ? 1200 : 1050);
  assert.deepEqual(finish.wallet, { coins: (withWarehouse ? 840 : 990) + fishSaleCoins, pearls: 0 });
  assert.deepEqual(finish.inventory, withWarehouse ? {} : { planks: 3, stone: 2, rope: 2 });
  assert.equal(finish.stageOrders.stages["2"].step, 7); assert.equal(finish.stageOrders.stages["2"].completed, true);
  assert.ok(peak <= 50, "the optional expansion must not hide a mandatory oversized stock requirement");
  assert.equal(peak, withWarehouse ? 40 : 47);
  t.diagnostic(`${cast} shore trips; caught ${JSON.stringify(caught)}; sold ${JSON.stringify(sold)} for ${fishSaleCoins} coins; peak ${peak}/${finish.storage.capacity}; final ${finish.wallet.coins} coins`);
});

test("second-stage basic production and construction keep unit counts, exact timers and optional storage", () => {
  for (const [id, seconds, inputs, outputs] of [
    ["gather_fiber", 60, {}, { fiber: 1 }], ["make_rope", 180, { fiber: 2 }, { rope: 1 }],
    ["make_charcoal", 120, { wood: 1 }, { charcoal: 1 }], ["fire_bricks", 180, { clay: 1, charcoal: 1 }, { bricks: 1 }],
  ]) {
    const entry = recipe(id); assert.equal(entry.seconds, seconds); assert.equal(entry.maxBatch, 1);
    assert.deepEqual(entry.cost, { coins: 0, items: inputs }); assert.deepEqual(entry.rewards, outputs); assert.equal(entry.requiredHomeLevel, 2);
  }
  for (const [id, outputs, quarry] of [["quarry_stone", { stone: 1 }, 1], ["quarry_clay", { clay: 1 }, 2]]) {
    const entry = route(id); assert.equal(entry.seconds, 180); assert.equal(entry.activity, "mining");
    assert.deepEqual(entry.rewards, outputs); assert.equal(entry.requiredBuildings.quarry, quarry); assert.equal(entry.requiredHomeLevel, 2);
  }
  for (const [id, level, seconds, coins, items] of [
    ["quarry", 1, 300, 100, { wood: 2, planks: 2 }], ["quarry", 2, 600, 200, { planks: 3, stone: 3, rope: 2 }],
    ["warehouse", 2, 600, 150, { planks: 3, stone: 2, rope: 2 }], ["kiln", 1, 600, 150, { planks: 2, stone: 4, clay: 2 }],
    ["home", 3, 1200, 600, { planks: 6, bricks: 6, rope: 4, stone: 4 }],
  ]) {
    const entry = model.economyCatalog.buildings.find(building => building.id === id).levels.find(entry => entry.level === level);
    assert.equal(entry.seconds, seconds); assert.deepEqual(entry.cost, { coins, items });
  }
  const home = model.economyCatalog.buildings.find(building => building.id === "home").levels[2];
  assert.deepEqual(home.requiredBuildings, { workshop: 1, quarry: 2, kiln: 1 });
  const p = player(); read(p); const state = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
  state.buildings.quarry = 2; state.buildings.kiln = 1; state.inventory = { fiber: 8, wood: 8, charcoal: 8, clay: 8 };
  for (const id of ["gather_fiber", "make_rope", "make_charcoal", "fire_bricks"]) {
    const before = read(p); assert.throws(() => send(p, "start_production", id, 0, { quantity: 2 }), { code: "INVALID_ECONOMY_COMMAND" }); assert.deepEqual(read(p), before);
  }
  for (const id of ["quarry_stone", "quarry_clay"]) {
    const before = read(p); assert.throws(() => send(p, "start_exploration", id, 0, { quantity: 2 }), { code: "INVALID_ECONOMY_COMMAND" }); assert.deepEqual(read(p), before);
  }
});
