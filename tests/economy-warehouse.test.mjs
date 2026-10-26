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
const capacity = [50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
const relicCosts = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [1, 1, 0], [2, 0, 1]];
const relicSeconds = [7200, 14400, 14400, 14400, 14400, 14400, 14400];
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
  saved(p).buildings = { ...saved(p).buildings, ...Object.fromEntries(model.economyCatalog.buildings.map(b => [b.id, b.levels.at(-1).level])), warehouse: level };
  return p;
};
const saved = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const request = (p, action, targetId, at = now, extra = {}) => ({ requestId: crypto.randomUUID(),
  ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision, action, targetId, quantity: 1, totalPrice: 0, ...extra });
const issue = (p, action, targetId, at = now) => economy.commandDevEconomy(p.token, request(p, action, targetId, at), at);

test("ten warehouse tiers preserve capacity and spread small relic baskets across crafted endgame goals", () => {
  assert.deepEqual(warehouse.levels.map(level => level.level), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(warehouse.levels.map(level => level.warehouseCapacity), capacity);
  assert.deepEqual(warehouse.levels.map(level => level.cost.coins), [0, 200, 1500, 8000, 12000, 18000, 30000, 45000, 65000, 95000]);
  const third = warehouse.levels[2];
  assert.deepEqual(third.cost, { coins: 1500, items: { planks: 6, bricks: 6, iron_ingot: 2, cloth: 2 } });
  for (const target of warehouse.levels) {
    assert.equal(target.requiredHomeLevel, target.level <= 3 ? target.level : target.level <= 6 ? 4 : 5);
    if (target.level <= 3) assert.deepEqual(target.requiredBuildings, {});
  }
  for (const target of warehouse.levels.slice(0, 3))
    assert.ok(relicIds.every(id => !target.cost.items[id]));
  for (const [index, target] of warehouse.levels.slice(3).entries()) {
    assert.ok(target.cost.coins > warehouse.levels[target.level - 2].cost.coins);
    assert.deepEqual(relicIds.map(id => target.cost.items[id] ?? 0), relicCosts[index]);
    assert.equal(Object.keys(target.cost.items).filter(id => !relicIds.includes(id)).length, 3);
    assert.equal(target.requiredHomeLevel, target.level <= 6 ? 4 : 5);
    assert.equal(target.seconds, relicSeconds[index]);
  }
});

test("ordinary construction fits the base warehouse and never requires a warehouse upgrade", () => {
  for (const building of model.economyCatalog.buildings) for (const target of building.levels) {
    const itemCount = Object.values(target.cost.items).reduce((total, count) => total + count, 0);
    assert.ok(itemCount <= 42, `${building.id} ${target.level} needs ${itemCount} stored items`);
    if (building.id !== "warehouse") assert.equal(target.requiredBuildings.warehouse, undefined,
      `${building.id} ${target.level} must not require optional storage`);
  }

  const target = model.economyCatalog.buildings.find(building => building.id === "woodlot").levels[3];
  const state = initial(1);
  state.buildings = { ...state.buildings, home: 4, workshop: 3, woodlot: 3 };
  state.wallet.coins = target.cost.coins;
  const spareWood = 50 - Object.values(target.cost.items).reduce((total, count) => total + count, 0);
  state.inventory = { ...target.cost.items, wood: spareWood };
  assert.equal(rules.economyStorage(state).used, 50);
  const missingWorkshop = structuredClone(state); missingWorkshop.buildings.workshop = 2;
  const before = structuredClone(missingWorkshop);
  assert.throws(() => direct(missingWorkshop, "start_construction", "woodlot"), { code: "ECONOMY_BUILDING_REQUIRED" });
  assert.deepEqual(missingWorkshop, before);
  direct(state, "start_construction", "woodlot");
  const job = state.jobs[0];
  assert.equal(job.targetLevel, 4); assert.deepEqual(job.cost, target.cost);
  assert.deepEqual(state.inventory, { wood: spareWood });
  direct(state, "claim_job", job.id, Date.parse(job.finishesAt));
  assert.equal(state.buildings.woodlot, 4); assert.equal(state.buildings.warehouse, 1);
  assert.equal(rules.economyStorage(state).capacity, 50);
});

test("warehouse two and three charge current prices and require the home stage that opens their materials", () => {
  const state = initial(1);
  const costs = [
    { coins: 200, items: { planks: 3, stone: 2, rope: 2 } },
    { coins: 1500, items: { planks: 6, bricks: 6, iron_ingot: 2, cloth: 2 } },
  ];
  const seconds = [600, 3600];
  let at = now;
  for (const [index, target] of warehouse.levels.slice(1, 3).entries()) {
    assert.deepEqual(target.cost, costs[index]); assert.equal(target.seconds, seconds[index]);
    state.wallet.coins = target.cost.coins;
    state.inventory = { ...target.cost.items, wood: 2 };
    const missingHome = structuredClone(state), missingHomeBefore = structuredClone(missingHome);
    assert.throws(() => direct(missingHome, "start_construction", "warehouse", at), { code: "ECONOMY_HOME_REQUIRED" });
    assert.deepEqual(missingHome, missingHomeBefore);
    state.buildings.home = target.level;
    const buildings = structuredClone(state.buildings);
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

test("a developed settlement pays each crafted and relic basket exactly once through warehouse ten", () => {
  const state = initial(3);
  const totalCoins = warehouse.levels.slice(3).reduce((sum, target) => sum + target.cost.coins, 0);
  state.wallet = { coins: totalCoins + 321, pearls: 500 };
  state.buildings = { ...state.buildings, ...Object.fromEntries(model.economyCatalog.buildings.map(b => [b.id, b.levels.at(-1).level])), warehouse: 3 };
  state.inventory = { wood: 2 };
  for (const target of warehouse.levels.slice(3)) for (const [id, amount] of Object.entries(target.cost.items)) state.inventory[id] = (state.inventory[id] ?? 0) + amount;
  const buildings = structuredClone(state.buildings);
  let at = now;
  for (const target of warehouse.levels.slice(3)) {
    const before = structuredClone(state.inventory), beforeWallet = structuredClone(state.wallet);
    direct(state, "start_construction", "warehouse", at);
    const job = state.jobs[0];
    assert.equal(job.targetLevel, target.level); assert.deepEqual(job.cost, target.cost);
    assert.deepEqual(state.wallet, { ...beforeWallet, coins: beforeWallet.coins - target.cost.coins });
    const paidWallet = structuredClone(state.wallet);
    for (const [id, amount] of Object.entries(target.cost.items)) assert.equal(state.inventory[id] ?? 0, before[id] - amount);
    assert.equal(state.buildings.warehouse, target.level - 1);
    assert.equal(rules.economyStorage(state).capacity, capacity[target.level - 2]);
    assert.throws(() => direct(structuredClone(state), "start_construction", "warehouse", at), { code: "ECONOMY_CONSTRUCTION_BUSY" });
    assert.throws(() => direct(structuredClone(state), "claim_job", job.id, Date.parse(job.finishesAt) - 1), { code: "ECONOMY_JOB_NOT_READY" });
    at = Date.parse(job.finishesAt);
    direct(state, "claim_job", job.id, at);
    assert.equal(state.buildings.warehouse, target.level);
    assert.equal(rules.economyStorage(state).capacity, capacity[target.level - 1]);
    assert.deepEqual(state.wallet, paidWallet, "claiming paid construction never charges its coins again");
    assert.equal(state.jobs.length, 0);
  }
  assert.deepEqual(state.wallet, { coins: 321, pearls: 500 });
  assert.deepEqual(state.inventory, { wood: 2 });
  assert.deepEqual(state.buildings, { ...buildings, warehouse: 10 });
  const before = structuredClone(state);
  assert.throws(() => direct(state, "start_construction", "warehouse", at), { code: "ECONOMY_MAX_LEVEL" });
  assert.deepEqual(state, before);
});

test("each missing material or relic blocks an advanced tier atomically in the local server adapter", () => {
  for (const target of warehouse.levels.slice(3)) for (const id of Object.keys(target.cost.items)) {
    const p = player(target.level - 1);
    saved(p).wallet.coins = target.cost.coins;
    saved(p).inventory = { ...target.cost.items, [id]: target.cost.items[id] - 1 };
    saved(p).rareDropState = { version: 1, remainingSeconds: 1800, itemId: "living_resin" };
    const before = structuredClone(saved(p)), view = read(p);
    assert.throws(() => issue(p, "start_construction", "warehouse"), { code: "ECONOMY_RESOURCES" });
    assert.deepEqual(saved(p), before); assert.deepEqual(read(p), view);
  }
});

test("advanced storage requires its house and ingredient sources before spending any saved input", () => {
  for (const target of warehouse.levels.slice(3)) {
    const gates = [["home", target.requiredHomeLevel, "ECONOMY_HOME_REQUIRED"],
      ...Object.entries(target.requiredBuildings).map(([id, level]) => [id, level, "ECONOMY_BUILDING_REQUIRED"])];
    for (const [id, level, code] of gates) {
      const p = player(target.level - 1);
      saved(p).wallet.coins = target.cost.coins;
      saved(p).inventory = { ...target.cost.items };
      saved(p).buildings[id] = level - 1;
      const before = structuredClone(saved(p)), view = read(p);
      assert.throws(() => issue(p, "start_construction", "warehouse"), { code });
      assert.deepEqual(saved(p), before); assert.deepEqual(read(p), view);
    }
  }
});

test("construction and claim request replays cannot spend another relic set or grant another level", () => {
  const p = player(9), target = warehouse.levels[9];
  saved(p).wallet = { coins: target.cost.coins + 321, pearls: 50 };
  saved(p).inventory = { ...target.cost.items, wood: 5 };
  const start = request(p, "start_construction", "warehouse");
  const started = economy.commandDevEconomy(p.token, start, now), job = started.state.jobs[0];
  assert.deepEqual(job.cost, target.cost);
  assert.deepEqual(started.state.wallet, { coins: 321, pearls: 50 });
  assert.deepEqual(started.state.inventory, { wood: 5 });
  assert.equal(economy.commandDevEconomy(p.token, start, now + 1).replayed, true);
  assert.deepEqual(saved(p).wallet, started.state.wallet);
  assert.equal(read(p).jobs.length, 1); assert.deepEqual(read(p).inventory, { wood: 5 });
  const end = Date.parse(job.finishesAt), claim = request(p, "claim_job", job.id, end);
  const claimed = economy.commandDevEconomy(p.token, claim, end);
  assert.deepEqual(claimed.state.wallet, started.state.wallet);
  assert.equal(claimed.state.buildings.warehouse, 10); assert.equal(claimed.state.storage.capacity, 500);
  assert.equal(economy.commandDevEconomy(p.token, claim, end + 1).replayed, true);
  assert.deepEqual(saved(p).wallet, started.state.wallet);
  assert.deepEqual(saved(p).inventory, { wood: 5 }); assert.equal(saved(p).buildings.warehouse, 10);
  assert.equal(read(p, end).jobs.length, 0);
  assert.throws(() => issue(p, "claim_job", job.id, end), { code: "ECONOMY_JOB_GONE" });
});

test("saved paid warehouse upgrades keep original costs and finish without new house or relic requirements", () => {
  const originalCosts = {
    2: { coins: 2500, items: { planks: 17, stone: 18, rope: 7 } },
    3: { coins: 16000, items: { planks: 36, bricks: 33, iron_ingot: 9, cloth: 7 } },
    4: { coins: 70000, items: { beams: 60, cut_stone: 70, glass: 25, tools: 15, ancient_core: 1 } },
    5: { coins: 220000, items: { beams: 100, cut_stone: 140, reinforced_parts: 35, glass: 60, cloth: 45, moon_crystal: 1 } },
    10: { coins: 0, items: { ancient_core: 10, moon_crystal: 3, living_resin: 3 } },
  };
  for (const level of [2, 3, 4, 5, 10]) {
    const p = player(level - 1), state = saved(p);
    state.buildings = { home: 1, warehouse: level - 1, garden: 1 };
    state.wallet = { coins: 321, pearls: 500 }; state.inventory = { wood: 5 };
    const seconds = level === 2 ? 28800 : (level - 2) * 86400;
    const job = model.economyJobSchema.parse({ id: crypto.randomUUID(), kind: "construction", targetId: "warehouse",
      recipeId: null, targetLevel: level, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + seconds * 1000).toISOString(),
      rewards: {}, cost: originalCosts[level], catalogVersion: level === 10 ? 14 : level === 2 ? 6 : level === 3 ? 7 : 3 });
    state.jobs = [job];
    const snapshot = model.economyViewSchema.parse(read(p));
    assert.deepEqual(snapshot.jobs[0].cost, originalCosts[level]);
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
  saved(p).wallet = { coins: target.cost.coins + 321, pearls: 500000 };
  saved(p).inventory = { ...target.cost.items };
  const started = issue(p, "start_construction", "warehouse").state, job = started.jobs[0];
  assert.deepEqual(job.cost, target.cost);
  assert.deepEqual(started.wallet, { coins: 321, pearls: 500000 });
  const price = rules.constructionSpeedupPrice(job, now);
  assert.equal(price, 96); assert.deepEqual(started.inventory, {});
  const speedup = request(p, "speedup_construction", job.id, now, { totalPrice: price });
  const finished = economy.commandDevEconomy(p.token, speedup, now).state;
  assert.equal(finished.buildings.warehouse, 10); assert.equal(finished.storage.capacity, 500);
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
