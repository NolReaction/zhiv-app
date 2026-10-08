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
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const dev = await vite.ssrLoadModule("/features/economy/dev/dev-model.ts");
after(() => vite.close());
beforeEach(() => identities.resetDevStoreForTests());

const now = Date.parse("2026-10-06T23:00:00Z");
const warehouse = model.economyCatalog.buildings.find(building => building.id === "warehouse");
const capacity = [200, 500, 1000, 1800, 3000, 4000, 5200, 6600, 8200, 10000];
const relicCosts = [[2, 1, 1], [3, 1, 1], [4, 1, 1], [5, 2, 2], [6, 2, 2], [8, 2, 2], [10, 3, 3]];
const relicIds = ["ancient_core", "moon_crystal", "living_resin"];
const initial = level => {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings.warehouse = level;
  return state;
};
const direct = (state, action, targetId, at = now, totalPrice = 0) => rules.applyEconomyCommand(state,
  { action, targetId, quantity: 1, totalPrice }, at, () => crypto.randomUUID());
const player = level => {
  const p = identities.createDevIdentity("Хранитель запасов", crypto.randomUUID());
  economy.getDevEconomy(p.token, now);
  saved(p).buildings.warehouse = level;
  return p;
};
const saved = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const request = (p, action, targetId, at = now, extra = {}) => ({ requestId: crypto.randomUUID(),
  ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision, action, targetId, quantity: 1, totalPrice: 0, ...extra });
const issue = (p, action, targetId, at = now) => economy.commandDevEconomy(p.token, request(p, action, targetId, at), at);

test("ten warehouse tiers preserve earned capacity and switch to escalating relic sets only after level three", () => {
  assert.deepEqual(warehouse.levels.map(level => level.level), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(warehouse.levels.map(level => level.warehouseCapacity), capacity);
  const third = warehouse.levels[2];
  assert.deepEqual(third.cost, { coins: 16000, items: { planks: 50, bricks: 45, iron_ingot: 12, cloth: 10 } });
  for (const target of warehouse.levels) {
    assert.equal(target.requiredHomeLevel, 1); assert.deepEqual(target.requiredBuildings, {});
  }
  for (const target of warehouse.levels.slice(0, 3))
    assert.ok(relicIds.every(id => !target.cost.items[id]));
  for (const [index, target] of warehouse.levels.slice(3).entries()) {
    assert.deepEqual(target.cost, { coins: 0, items: Object.fromEntries(relicIds.map((id, i) => [id, relicCosts[index][i]])) });
    assert.equal(target.requiredHomeLevel, 1); assert.deepEqual(target.requiredBuildings, {});
    assert.equal(target.seconds, (index + 2) * 86400);
  }
});

test("ordinary warehouse expansions keep prices and materials but have no house or workshop gate", () => {
  const state = initial(1), buildings = structuredClone(state.buildings);
  const costs = [
    { coins: 2500, items: { planks: 18, stone: 20, rope: 8 } },
    { coins: 16000, items: { planks: 50, bricks: 45, iron_ingot: 12, cloth: 10 } },
  ];
  const seconds = [28800, 86400];
  let at = now;
  for (const [index, target] of warehouse.levels.slice(1, 3).entries()) {
    assert.deepEqual(target.cost, costs[index]); assert.equal(target.seconds, seconds[index]);
    state.wallet.coins = target.cost.coins;
    state.inventory = { ...target.cost.items, wood: 2 };
    const before = structuredClone(state);
    const missingCoins = structuredClone(state); missingCoins.wallet.coins--;
    assert.throws(() => direct(missingCoins, "start_construction", "warehouse", at), { code: "ECONOMY_RESOURCES" });
    assert.deepEqual(missingCoins.jobs, before.jobs);
    const missingMaterial = structuredClone(state); missingMaterial.inventory.planks--;
    assert.throws(() => direct(missingMaterial, "start_construction", "warehouse", at), { code: "ECONOMY_RESOURCES" });
    assert.deepEqual(missingMaterial.wallet, before.wallet); assert.deepEqual(missingMaterial.jobs, before.jobs);
    direct(state, "start_construction", "warehouse", at);
    const job = state.jobs[0];
    assert.equal(job.targetLevel, target.level); assert.deepEqual(job.cost, target.cost);
    assert.equal(Date.parse(job.finishesAt) - at, seconds[index] * 1000);
    assert.deepEqual(state.inventory, { wood: 2 }); assert.equal(state.wallet.coins, 0);
    assert.equal(state.buildings.warehouse, target.level - 1);
    assert.throws(() => direct(structuredClone(state), "start_construction", "warehouse", at), { code: "ECONOMY_CONSTRUCTION_BUSY" });
    const unrelated = structuredClone(state); unrelated.buildings.woodlot = 0;
    assert.throws(() => direct(unrelated, "start_construction", "woodlot", at), { code: "ECONOMY_CONSTRUCTION_BUSY" });
    assert.throws(() => direct(structuredClone(state), "claim_job", job.id, Date.parse(job.finishesAt) - 1), { code: "ECONOMY_JOB_NOT_READY" });
    at = Date.parse(job.finishesAt); direct(state, "claim_job", job.id, at);
    assert.deepEqual(state.buildings, { ...buildings, warehouse: target.level });
    assert.equal(rules.economyStorage(state).capacity, capacity[target.level - 1]);
  }
});

test("a small settlement can expand from warehouse three to ten without improving any other building", () => {
  const state = initial(3);
  state.wallet = { coins: 321, pearls: 500 };
  state.inventory = { wood: 2, ancient_core: 38, moon_crystal: 12, living_resin: 12 };
  const buildings = structuredClone(state.buildings);
  let at = now;
  for (const target of warehouse.levels.slice(3)) {
    const before = structuredClone(state.inventory);
    direct(state, "start_construction", "warehouse", at);
    const job = state.jobs[0];
    assert.equal(job.targetLevel, target.level); assert.deepEqual(job.cost, target.cost);
    for (const id of relicIds) assert.equal(state.inventory[id] ?? 0, before[id] - target.cost.items[id]);
    assert.equal(state.buildings.warehouse, target.level - 1);
    assert.equal(rules.economyStorage(state).capacity, capacity[target.level - 2]);
    assert.throws(() => direct(structuredClone(state), "start_construction", "warehouse", at), { code: "ECONOMY_CONSTRUCTION_BUSY" });
    assert.throws(() => direct(structuredClone(state), "claim_job", job.id, Date.parse(job.finishesAt) - 1), { code: "ECONOMY_JOB_NOT_READY" });
    at = Date.parse(job.finishesAt);
    direct(state, "claim_job", job.id, at);
    assert.equal(state.buildings.warehouse, target.level);
    assert.equal(rules.economyStorage(state).capacity, capacity[target.level - 1]);
    assert.deepEqual(state.wallet, { coins: 321, pearls: 500 });
    assert.equal(state.jobs.length, 0);
  }
  assert.deepEqual(state.inventory, { wood: 2 });
  assert.deepEqual(state.buildings, { ...buildings, warehouse: 10 });
  const before = structuredClone(state);
  assert.throws(() => direct(state, "start_construction", "warehouse", at), { code: "ECONOMY_MAX_LEVEL" });
  assert.deepEqual(state, before);
});

test("each missing relic blocks every advanced tier atomically in the local server adapter", () => {
  for (const target of warehouse.levels.slice(3)) for (const id of relicIds) {
    const p = player(target.level - 1);
    saved(p).inventory = { ...target.cost.items, [id]: target.cost.items[id] - 1 };
    saved(p).rareDropState = { version: 1, remainingSeconds: 1800, itemId: "living_resin" };
    const before = structuredClone(saved(p)), view = read(p);
    assert.throws(() => issue(p, "start_construction", "warehouse"), { code: "ECONOMY_RESOURCES" });
    assert.deepEqual(saved(p), before); assert.deepEqual(read(p), view);
  }
});

test("construction and claim request replays cannot spend another relic set or grant another level", () => {
  const p = player(9), target = warehouse.levels[9];
  saved(p).inventory = { ...target.cost.items, wood: 5 };
  const start = request(p, "start_construction", "warehouse");
  const started = economy.commandDevEconomy(p.token, start, now), job = started.state.jobs[0];
  assert.deepEqual(started.state.inventory, { wood: 5 });
  assert.equal(economy.commandDevEconomy(p.token, start, now + 1).replayed, true);
  assert.equal(read(p).jobs.length, 1); assert.deepEqual(read(p).inventory, { wood: 5 });
  const end = Date.parse(job.finishesAt), claim = request(p, "claim_job", job.id, end);
  const claimed = economy.commandDevEconomy(p.token, claim, end);
  assert.equal(claimed.state.buildings.warehouse, 10); assert.equal(claimed.state.storage.capacity, 10000);
  assert.equal(economy.commandDevEconomy(p.token, claim, end + 1).replayed, true);
  assert.deepEqual(saved(p).inventory, { wood: 5 }); assert.equal(saved(p).buildings.warehouse, 10);
  assert.equal(read(p, end).jobs.length, 0);
  assert.throws(() => issue(p, "claim_job", job.id, end), { code: "ECONOMY_JOB_GONE" });
});

test("saved paid fourth and fifth warehouse upgrades keep their original cost and finish without a new relic charge", () => {
  const originalCosts = [
    { coins: 70000, items: { beams: 60, cut_stone: 70, glass: 25, tools: 15, ancient_core: 1 } },
    { coins: 220000, items: { beams: 100, cut_stone: 140, reinforced_parts: 35, glass: 60, cloth: 45, moon_crystal: 1 } },
  ];
  for (const level of [4, 5]) {
    const p = player(level - 1), state = saved(p);
    state.wallet = { coins: 321, pearls: 500 }; state.inventory = { wood: 5 };
    const job = model.economyJobSchema.parse({ id: crypto.randomUUID(), kind: "construction", targetId: "warehouse",
      recipeId: null, targetLevel: level, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + (level - 2) * 86400000).toISOString(),
      rewards: {}, cost: originalCosts[level - 4], catalogVersion: 3 });
    state.jobs = [job];
    const snapshot = model.economyViewSchema.parse(read(p));
    assert.deepEqual(snapshot.jobs[0].cost, originalCosts[level - 4]);
    const before = structuredClone(state);
    assert.throws(() => issue(p, "claim_job", job.id), { code: "ECONOMY_JOB_NOT_READY" });
    assert.deepEqual(state, before);
    const end = Date.parse(job.finishesAt), claim = request(p, "claim_job", job.id, end);
    const first = economy.commandDevEconomy(p.token, claim, end).state;
    assert.equal(first.buildings.warehouse, level); assert.equal(first.storage.capacity, capacity[level - 1]);
    assert.deepEqual(first.wallet, before.wallet); assert.deepEqual(first.inventory, before.inventory);
    assert.equal(economy.commandDevEconomy(p.token, claim, end + 1).replayed, true);
    assert.deepEqual(saved(p).wallet, before.wallet); assert.deepEqual(saved(p).inventory, before.inventory);
  }
});

test("speedup finishes warehouse ten once for the current pearl tariff without recharging paid relics", () => {
  const p = player(9), target = warehouse.levels[9];
  saved(p).wallet = { coins: 321, pearls: 500000 };
  saved(p).inventory = { ...target.cost.items };
  const started = issue(p, "start_construction", "warehouse").state, job = started.jobs[0];
  const price = rules.constructionSpeedupPrice(job, now);
  assert.equal(price, 115200); assert.deepEqual(started.inventory, {});
  const speedup = request(p, "speedup_construction", job.id, now, { totalPrice: price });
  const finished = economy.commandDevEconomy(p.token, speedup, now).state;
  assert.equal(finished.buildings.warehouse, 10); assert.equal(finished.storage.capacity, 10000);
  assert.deepEqual(finished.wallet, { coins: 321, pearls: 500000 - price });
  assert.deepEqual(finished.inventory, {}); assert.deepEqual(finished.jobs, []);
  assert.equal(economy.commandDevEconomy(p.token, speedup, now + 1).replayed, true);
  assert.deepEqual(saved(p).wallet, finished.wallet);
  assert.throws(() => economy.commandDevEconomy(p.token, request(p, "speedup_construction", job.id, now, { totalPrice: price }), now),
    { code: "ECONOMY_JOB_GONE" });
});

test("all warehouse tiers still count stored relics and marketplace or barter escrow against capacity", () => {
  for (const target of warehouse.levels) {
    const state = initial(target.level), reserved = { moon_crystal: 1 };
    state.inventory = { wood: target.warehouseCapacity - 2, ancient_core: 1 };
    assert.deepEqual(rules.economyStorage(state, reserved), { capacity: target.warehouseCapacity,
      used: target.warehouseCapacity - 1, reserved: 1, available: 0, overflow: 0 });
    const inflow = structuredClone(state); inflow.inventory.living_resin = 1;
    assert.throws(() => rules.assertEconomyStorageTransition(state, inflow, reserved), { code: "ECONOMY_STORAGE_FULL" });
    state.inventory.wood += 5;
    const shrinking = structuredClone(state); shrinking.inventory.wood -= 1;
    assert.equal(rules.economyStorage(state, reserved).overflow, 5);
    assert.doesNotThrow(() => rules.assertEconomyStorageTransition(state, shrinking, reserved));
    assert.throws(() => rules.assertEconomyStorageTransition(state, { ...state, inventory: { ...state.inventory, living_resin: 1 } }, reserved),
      { code: "ECONOMY_STORAGE_FULL" });
  }
});

test("snapshots accept warehouse ten and DEV rejects a nonexistent eleventh tier while player commands cannot skip levels", () => {
  const p = player(10), snapshot = read(p);
  assert.equal(model.economyViewSchema.safeParse(snapshot).success, true);
  const setLevel = request(p, "set_building_level", "warehouse", now, { quantity: 10 });
  assert.equal(dev.economyDevCommandSchema.safeParse(setLevel).success, true);
  assert.equal(dev.economyDevCommandSchema.safeParse({ ...setLevel, quantity: 11 }).success, false);
  const fresh = player(3); saved(fresh).inventory = { ...warehouse.levels[3].cost.items };
  const before = structuredClone(saved(fresh));
  assert.throws(() => economy.commandDevEconomy(fresh.token, request(fresh, "start_construction", "warehouse", now, { quantity: 10 }), now),
    { code: "INVALID_ECONOMY_COMMAND" });
  assert.deepEqual(saved(fresh), before);
  assert.equal(model.economyCommandSchema.safeParse({ ...request(fresh, "start_construction", "warehouse"), targetLevel: 10 }).success, false);
});
