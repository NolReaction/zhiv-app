import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const tutorial = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const now = Date.parse("2026-10-13T20:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const player = () => identities.createDevIdentity("Первое хозяйство", crypto.randomUUID());
const read = (p, seconds = 0) => economy.getDevEconomy(p.token, now + seconds * 1000);
const send = (p, action, targetId, seconds = 0, extra = {}) => economy.commandDevEconomy(p.token, {
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, seconds).revision,
  action, targetId, quantity: 1, totalPrice: 0, ...extra,
}, now + seconds * 1000).state;
const recipe = id => model.economyCatalog.recipes.find(entry => entry.id === id);

test("first-stage production contracts give one ordinary item per slot and add value through memorable recipes", () => {
  const expected = [
    ["grow_berries", 60, {}, { berries: 1 }], ["grow_strawberries", 300, {}, { strawberries: 1 }],
    ["gather_wood", 180, {}, { wood: 1 }], ["make_planks", 120, { wood: 1 }, { planks: 1 }],
    ["cook_compote", 180, { berries: 2 }, { berry_compote: 1 }],
    ["cook_grilled_fish", 180, { fish_common: 1 }, { grilled_fish: 1 }],
  ];
  for (const [id, seconds, inputs, output] of expected) {
    const entry = recipe(id);
    assert.ok(entry, id); assert.equal(entry.seconds, seconds); assert.equal(entry.maxBatch, 1);
    assert.deepEqual(entry.cost, { coins: 0, items: inputs }); assert.deepEqual(entry.rewards, output);
  }
  for (const id of ["grow_berries", "grow_strawberries"]) assert.equal(recipe(id).collection.seconds, 8);
  assert.deepEqual(recipe("grow_strawberries").requiredRecipes, { cook_compote: 1 });
  const items = new Map(model.economyCatalog.items.map(entry => [entry.id, entry]));
  for (const id of ["make_planks", "cook_compote", "cook_grilled_fish"]) {
    const entry = recipe(id), value = counts => Object.entries(counts).reduce((sum, [item, count]) => sum + items.get(item).baseSellPrice * count, 0);
    assert.ok(value(entry.rewards) > value(entry.cost.items), `${id} must add value`);
  }
});

test("new players have exactly the affordable one-slot starting settlement and no special starter gift", () => {
  const state = fresh();
  assert.deepEqual(state.wallet, { coins: 100, pearls: 0 });
  assert.deepEqual(state.inventory, { wood: 3, stone: 5 });
  for (const id of ["home", "garden", "warehouse"]) assert.equal(state.buildings[id], 1);
  for (const id of ["woodlot", "dryer", "workshop", "quarry", "kiln"]) assert.equal(state.buildings[id], 0);
  assert.deepEqual(state.productionSlots ?? {}, {}); assert.equal(rules.economyStorage(state).capacity, 50);
  assert.equal(state.tutorialOrder.version, 2); assert.equal(state.tutorialOrder.step, 0);
  assert.equal(state.tutorialOrder.ingredientsClaimed, true); assert.equal(state.workshopStarterClaimed, false);
  const p = player(), before = read(p);
  assert.throws(() => send(p, "claim_workshop_starter", "workshop"), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
  assert.deepEqual(read(p), before);
});

test("a controlled clock completes the whole first stage in 42 minutes with one builder, one slot and eight-second harvesting", () => {
  const p = player();
  let elapsed = 0, peak = read(p).storage.used;
  const produced = {}, starts = [], claimed = [];
  const act = (seconds, action, targetId) => {
    assert.ok(seconds >= elapsed, "the simulation clock must only move forward"); elapsed = seconds;
    const state = send(p, action, targetId, seconds);
    peak = Math.max(peak, state.storage.used);
    assert.equal(state.wallet.pearls, 0); assert.deepEqual(state.productionSlots, {});
    assert.ok(state.storage.used <= 50); assert.ok(state.jobs.filter(job => job.kind === "construction").length <= 1);
    return state;
  };
  const start = (seconds, id) => { const state = act(seconds, "start_production", id); starts.push(id); return state; };
  const claim = (seconds, id) => {
    const job = read(p, seconds).jobs.find(entry => entry.recipeId === id || entry.targetId === id && entry.kind === "construction");
    assert.ok(job, `missing ${id} job at ${seconds}`);
    const state = act(seconds, "claim_job", job.id); claimed.push(id);
    for (const [item, count] of Object.entries(job.rewards)) produced[item] = (produced[item] ?? 0) + count;
    return state;
  };
  const collect = seconds => {
    const job = read(p, seconds).jobs.find(entry => entry.recipeId === "grow_berries");
    assert.ok(job); const state = act(seconds, "start_collection", job.id);
    assert.equal(Date.parse(state.jobs.find(entry => entry.id === job.id).collection.finishesAt) - (now + seconds * 1000), 8000);
  };
  const order = seconds => act(seconds, "complete_resident_order", tutorial.tutorialResidentOrder(read(p, seconds)).id);

  act(0, "start_construction", "woodlot"); start(0, "grow_berries");
  collect(60); claim(68, "grow_berries"); start(68, "grow_berries");
  claim(120, "woodlot"); act(120, "start_construction", "dryer"); start(120, "gather_wood");
  collect(128); claim(136, "grow_berries"); order(136); start(136, "grow_berries");
  collect(196); claim(204, "grow_berries"); start(204, "grow_berries");
  collect(264); claim(272, "grow_berries"); start(272, "grow_berries");
  claim(300, "dryer"); claim(300, "gather_wood"); order(300); start(300, "gather_wood"); start(300, "cook_compote");
  collect(332); claim(340, "grow_berries"); start(340, "grow_berries");
  collect(400); claim(408, "grow_berries");
  claim(480, "gather_wood"); start(480, "gather_wood"); claim(480, "cook_compote"); start(480, "cook_compote");
  claim(660, "gather_wood"); start(660, "gather_wood"); claim(660, "cook_compote"); order(660);
  act(660, "start_construction", "workshop");
  claim(840, "gather_wood"); start(840, "gather_wood");
  claim(960, "workshop"); start(960, "make_planks");
  claim(1020, "gather_wood"); start(1020, "gather_wood");
  claim(1080, "make_planks"); start(1080, "make_planks");
  claim(1200, "gather_wood"); start(1200, "gather_wood"); claim(1200, "make_planks"); order(1200); start(1200, "make_planks");
  claim(1320, "make_planks");
  claim(1380, "gather_wood"); start(1380, "gather_wood"); start(1380, "make_planks");
  claim(1500, "make_planks");
  claim(1560, "gather_wood"); start(1560, "gather_wood");
  claim(1740, "gather_wood"); start(1740, "gather_wood"); claim(1920, "gather_wood");
  act(1920, "start_construction", "home");
  assert.equal(read(p, 1920).buildings.home, 1);
  const finish = claim(2520, "home");
  assert.equal(elapsed, 42 * 60); assert.equal(finish.buildings.home, 2);
  assert.deepEqual(finish.wallet, { coins: 50, pearls: 0 }); assert.deepEqual(finish.inventory, {});
  assert.deepEqual(produced, { berries: 6, wood: 10, berry_compote: 2, planks: 4 });
  assert.equal(finish.tutorialOrder.step, 4); assert.equal(finish.tutorialOrder.completed, true);
  assert.equal(finish.residentOrders.completed, 4); assert.equal(finish.residentOrders.earnedCoins, 330);
  assert.equal(peak, 8); assert.equal(finish.jobs.length, 0);
  assert.ok(starts.every(id => !id.includes("fish"))); assert.equal(claimed.length, 26);
});

test("fresh-stage one-slot commands reject batches atomically and strawberry unlock requires a claimed compote", () => {
  const p = player();
  read(p); const state = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
  Object.assign(state.buildings, { woodlot: 1, workshop: 1, dryer: 1 }); state.inventory = { wood: 10, berries: 10, fish_common: 10 };
  for (const id of ["grow_berries", "gather_wood", "make_planks", "cook_compote", "cook_grilled_fish"]) {
    const before = structuredClone(read(p));
    assert.throws(() => send(p, "start_production", id, 0, { quantity: 2 }), { code: "INVALID_ECONOMY_COMMAND" });
    assert.deepEqual(read(p), before);
  }
  assert.throws(() => send(p, "start_production", "grow_strawberries"), { code: "ECONOMY_RECIPE_REQUIRED" });
  const cooking = send(p, "start_production", "cook_compote");
  assert.throws(() => send(p, "start_production", "grow_strawberries", 180), { code: "ECONOMY_RECIPE_REQUIRED" });
  const job = cooking.jobs[0]; send(p, "claim_job", job.id, 180);
  const unlocked = send(p, "start_production", "grow_strawberries", 180);
  assert.deepEqual(unlocked.jobs.find(entry => entry.recipeId === "grow_strawberries").rewards, { strawberries: 1 });
});

test("three garden slots run two raspberries and a strawberry simultaneously and ready crops occupy capacity until claimed", () => {
  const p = player(); read(p); const state = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
  state.wallet.pearls = 700; state.progression.recipes.cook_compote = 1;
  send(p, "buy_production_slot", "garden"); send(p, "buy_production_slot", "garden");
  send(p, "start_production", "grow_berries"); send(p, "start_production", "grow_berries");
  const started = send(p, "start_production", "grow_strawberries");
  assert.equal(started.wallet.pearls, 0); assert.deepEqual(started.productionSlots, { garden: 3 });
  assert.equal(started.jobs.length, 3); assert.ok(started.jobs.every(job => Object.values(job.rewards).reduce((sum, count) => sum + count, 0) === 1));
  assert.equal(new Set(started.jobs.map(job => job.startedAt)).size, 1);
  assert.throws(() => send(p, "start_production", "grow_berries", 300), { code: "ECONOMY_BUILDING_BUSY" });
  let seconds = 300;
  for (const crop of started.jobs) {
    send(p, "start_collection", crop.id, seconds); seconds += 8; send(p, "claim_job", crop.id, seconds);
  }
  const finished = read(p, seconds); assert.equal(finished.jobs.length, 0);
  assert.deepEqual(finished.inventory, { wood: 3, stone: 5, berries: 2, strawberries: 1 });
  assert.equal(send(p, "start_production", "grow_berries", seconds).jobs.length, 1);
});

test("selling the five starting stones cannot permanently block development because the free forest route restores them", () => {
  const p = player(), sold = send(p, "sell", "stone", 0, { quantity: 5 });
  assert.equal(sold.inventory.stone, undefined); assert.equal(sold.wallet.coins, 300);
  const exploring = send(p, "start_exploration", "forest"), job = exploring.jobs[0];
  assert.deepEqual(job.cost, { coins: 0, items: {} }); assert.ok(job.rewards.stone > 0);
  const seconds = (Date.parse(job.finishesAt) - now) / 1000, recovered = send(p, "claim_job", job.id, seconds);
  assert.ok(recovered.inventory.stone > 0); assert.equal(recovered.wallet.coins, sold.wallet.coins);
  assert.ok(recovered.storage.used <= 50);
  assert.equal(send(p, "start_construction", "woodlot", seconds).jobs[0].targetId, "woodlot");
});

test("a previously paid production batch delivers its saved output without adopting new one-item catalog terms", () => {
  const p = player(); read(p); const state = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
  state.jobs = [model.economyJobSchema.parse({ id: crypto.randomUUID(), kind: "production", targetId: "workshop", recipeId: "make_planks",
    targetLevel: null, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 900 * 1000).toISOString(),
    rewards: { planks: 5 }, cost: { coins: 0, items: { wood: 10 } }, catalogVersion: 5 })];
  const before = read(p); assert.equal(recipe("make_planks").rewards.planks, 1);
  const finished = send(p, "claim_job", before.jobs[0].id, 900);
  assert.deepEqual(finished.inventory, { wood: 3, stone: 5, planks: 5 }); assert.deepEqual(finished.wallet, before.wallet);
  assert.equal(finished.jobs.length, 0); assert.equal(finished.progression.recipes.make_planks, 1);
});
