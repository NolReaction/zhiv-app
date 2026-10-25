import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { runEconomyCommandScenario } from "../scripts/lib/economy-command-scenario.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const stages = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const tutorial = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
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

for (const withWarehouse of [true, false]) test(`real one-slot commands earn house three ${withWarehouse ? "and optional storage" : "with the original warehouse"}`, t => {
  // Start at the actual zero-extra-gift fresh account, rather than granting a funded house two.
  const report = runEconomyCommandScenario({ rules, catalog: model.economyCatalog, stages, tutorial },
    { targetHome: 3, warehouseLevel: withWarehouse ? 2 : 1 });
  const state = report.state;
  assert.equal(state.buildings.home, 3); assert.equal(state.buildings.quarry, 2); assert.equal(state.buildings.kiln, 1);
  assert.equal(state.buildings.warehouse, withWarehouse ? 2 : 1); assert.equal(state.jobs.length, 0);
  assert.equal(state.stageOrders.stages["2"].step, 7); assert.equal(state.stageOrders.stages["2"].completed, true);
  assert.ok(state.progression.recipes.cook_grilled_fish >= 3);
  const stageIds = new Set(model.economyCatalog.stageOrders.find(stage => stage.homeLevel === 2).orders.map(order => order.id));
  const delivered = report.deliveries.filter(order => stageIds.has(order.id));
  assert.equal(delivered.length, 7);
  assert.equal(delivered.reduce((sum, order) => sum + order.coins, 0), model.economyCatalog.stageOrders
    .find(stage => stage.homeLevel === 2).orders.reduce((sum, order) => sum + order.coins, 0));
  assert.ok(report.peakStorage <= 50, "optional capacity must not conceal a mandatory stock bottleneck");
  assert.ok(state.wallet.coins >= 0); assert.equal(state.wallet.pearls, 0);
  assert.ok(report.starts.quarry_stone > 0 && report.starts.quarry_clay > 0 && report.starts.shore > 0);
  assert.ok(Object.keys(report.starts).every(id => ![...model.economyCatalog.recipes, ...model.economyCatalog.explorations]
    .find(source => source.id === id).retired));
  t.diagnostic(JSON.stringify({ elapsedSeconds: report.elapsedSeconds, commands: report.commandCount,
    peakStorage: report.peakStorage, earned: report.income, spent: report.expenses, coins: state.wallet.coins }));
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
    ["quarry", 1, 300, 50, { wood: 2, planks: 2 }], ["quarry", 2, 1200, 200, { planks: 3, stone: 3, rope: 2 }],
    ["warehouse", 2, 600, 100, { planks: 3, stone: 2, rope: 2 }], ["kiln", 1, 600, 100, { planks: 2, stone: 4, clay: 2 }],
    ["home", 3, 7200, 1200, { planks: 6, bricks: 6, rope: 4, stone: 4 }],
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
