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

for (const withWarehouse of [true, false]) test(`a real 179-minute house-two route completes house three ${withWarehouse ? "with the optional warehouse" : "in the original 50-place warehouse"}`, () => {
  const p = player(), produced = {}, raw = {}, costs = [], orders = []; let peak = 0;
  for (const event of secondStageSchedule(withWarehouse)) {
    let state;
    if (["claim", "claim_building"].includes(event.action)) {
      const job = read(p, event.minute).jobs.find(entry => event.action === "claim_building"
        ? entry.kind === "construction" && entry.targetId === event.target
        : entry.recipeId === event.target || entry.kind === "exploration" && entry.targetId === event.target);
      assert.ok(job, `missing ${event.target} at minute ${event.minute}`);
      state = send(p, "claim_job", job.id, event.minute);
      for (const [id, count] of Object.entries(job.rewards)) (Object.keys(job.cost.items).length ? produced : raw)[id] = ((Object.keys(job.cost.items).length ? produced : raw)[id] ?? 0) + count;
    } else {
      const before = read(p, event.minute); state = send(p, event.action, event.target, event.minute);
      if (event.action === "start_construction") costs.push(before.wallet.coins - state.wallet.coins);
      if (event.action === "complete_resident_order") orders.push(state.wallet.coins - before.wallet.coins);
    }
    peak = Math.max(peak, state.storage.used);
    assert.ok(state.storage.used <= state.storage.capacity); assert.equal(state.wallet.pearls, 0); assert.deepEqual(state.productionSlots, {});
    assert.ok(state.jobs.filter(job => job.kind === "construction").length <= 1);
    for (const id of ["woodlot", "workshop", "kiln"]) assert.ok(state.jobs.filter(job => job.kind === "production" && job.targetId === id).length <= 1);
    assert.ok(state.jobs.filter(job => job.kind === "exploration" && job.actorId === "miner").length <= 1);
    assert.ok(state.jobs.every(job => !job.meal && !job.fishing));
  }
  const finish = read(p, 179);
  assert.equal(finish.buildings.home, 3); assert.equal(finish.buildings.quarry, 2); assert.equal(finish.buildings.kiln, 1);
  assert.equal(finish.buildings.warehouse, withWarehouse ? 2 : 1); assert.equal(finish.jobs.length, 0);
  assert.deepEqual(raw, { fiber: 20, wood: 30, stone: 19, clay: 16 });
  assert.deepEqual(produced, { rope: 10, planks: 16, charcoal: 12, bricks: 10 });
  assert.deepEqual(orders, [90, 360, 180, 150, 600]); assert.equal(orders.reduce((sum, value) => sum + value, 0), 1380);
  assert.equal(costs.reduce((sum, value) => sum + value, 0), withWarehouse ? 1200 : 1050);
  assert.deepEqual(finish.wallet, { coins: withWarehouse ? 230 : 380, pearls: 0 });
  assert.deepEqual(finish.inventory, withWarehouse ? {} : { planks: 3, stone: 2, rope: 2 });
  assert.equal(finish.stageOrders.stages["2"].step, 5); assert.equal(finish.stageOrders.stages["2"].completed, true);
  assert.ok(peak <= 50, "the optional expansion must not hide a mandatory oversized stock requirement");
  assert.equal(peak, withWarehouse ? 31 : 38);
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
