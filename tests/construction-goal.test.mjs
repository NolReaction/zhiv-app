import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { constructionGoalDetails, constructionGoalStorageKey, createConstructionGoalStore } = await vite.ssrLoadModule("/features/economy/ui/construction/construction-goal.ts");
after(() => vite.close());

const owner = "TEST-GOAL-0001";
const goal = { buildingId: "home", targetLevel: 2 };
function state(overrides = {}) {
  return { ownerPublicId: owner, wallet: { coins: 1000, pearls: 0 }, inventory: { wood: 40, stone: 20, planks: 2, fiber: 10 },
    buildings: { home: 1, warehouse: 1, workshop: 1, woodlot: 1 }, jobs: [], catalog: structuredClone(economyCatalog), ...overrides };
}
function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
function recipe(id, rewards, items, extra = {}) {
  return { id, name: id, buildingId: "workshop", buildingLevel: 1, requiredHomeLevel: 1, requiredBuildings: {},
    seconds: 60, rewards, cost: { coins: 0, items }, ...extra };
}
function customState(cost, recipes, inventory) {
  const view = state({ inventory });
  view.catalog.recipes = recipes;
  view.catalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 2).cost = { coins: 0, items: cost };
  return view;
}

test("home target reads current catalog, deficits and craft ingredients without mutating the snapshot", () => {
  const view = state(), before = structuredClone(view);
  const details = constructionGoalDetails(view, goal);
  assert.equal(details.name, "Дом Мохлика");
  assert.deepEqual(details.missing, { coins: 500, items: { planks: 4, rope: 2 } });
  assert.deepEqual(details.keepItems, { wood: 28, stone: 15, planks: 6, rope: 2, fiber: 6 });
  assert.deepEqual(details.excessItems, { wood: 12, stone: 5, planks: 0, fiber: 4 });
  assert.equal(details.reservesComplete, true);
  assert.deepEqual(view, before);
  view.inventory.planks = 6; view.inventory.rope = 2;
  view.wallet.coins = 1500;
  assert.deepEqual(constructionGoalDetails(view, goal).missing, { coins: 0, items: {} });
  assert.equal(constructionGoalDetails(view, goal).keepItems.wood, 20);
  assert.equal(constructionGoalDetails(view, goal).keepItems.fiber, undefined);
});

test("one exact next level is selectable, including unmet building requirements, but never an automatic next target", () => {
  const view = state({ buildings: { home: 1 } });
  assert.ok(constructionGoalDetails(view, goal));
  assert.equal(constructionGoalDetails(view, { buildingId: "missing", targetLevel: 1 }), null);
  assert.equal(constructionGoalDetails(view, { buildingId: "home", targetLevel: 3 }), null);
  assert.equal(constructionGoalDetails({ ...view, buildings: { home: 2 } }, goal), null);
  const building = view.catalog.buildings.find(entry => entry.id === "home");
  building.levels = building.levels.filter(level => level.level !== 2);
  assert.equal(constructionGoalDetails(view, goal), null);
});

test("starting the selected construction clears its unpaid goal, while another builder job does not", () => {
  const view = state({ jobs: [{ kind: "construction", targetId: "warehouse", targetLevel: 2 }] });
  assert.ok(constructionGoalDetails(view, goal));
  view.jobs = [{ kind: "construction", targetId: "home", targetLevel: 2 }];
  assert.equal(constructionGoalDetails(view, goal), null);
});

test("shared inputs are aggregated once and output batches round up across a multistep craft chain", () => {
  const view = customState({ beams: 2, planks: 1, rope: 1, wood: 2 }, [
    recipe("beams", { beams: 1 }, { planks: 3, rope: 1 }),
    recipe("planks", { planks: 2 }, { wood: 5 }),
    recipe("rope", { rope: 1 }, { fiber: 3 }),
  ], { beams: 1, planks: 2, rope: 1, wood: 20, fiber: 5 });
  const details = constructionGoalDetails(view, goal);
  assert.deepEqual(details.keepItems, { beams: 2, planks: 4, rope: 2, wood: 7, fiber: 3 });
  assert.deepEqual(details.excessItems, { beams: 0, planks: 0, rope: 0, wood: 13, fiber: 2 });
  view.inventory.planks = 3;
  assert.equal(constructionGoalDetails(view, goal).keepItems.wood, 7, "one missing plank still needs a whole batch");
});

test("unclaimed jobs and recipe byproducts cannot make inventory appear disposable", () => {
  const view = customState({ planks: 2, rope: 1 }, [
    recipe("rope", { rope: 1 }, { fiber: 2 }), recipe("planks", { planks: 2, rope: 1 }, { wood: 3 }),
  ], { wood: 8, fiber: 5 });
  view.jobs = [{ kind: "production", targetId: "workshop", rewards: { planks: 100, rope: 100 } }];
  const details = constructionGoalDetails(view, goal);
  assert.deepEqual(details.missing.items, { planks: 2, rope: 1 });
  assert.equal(details.keepItems.wood, 3);
  assert.equal(details.keepItems.fiber, 2);
});

test("recipe navigation and ingredient protection use the same available recipe", () => {
  const view = customState({ planks: 3 }, [
    recipe("unavailable", { planks: 10 }, { special_wood: 1 }, { buildingLevel: 4 }),
    recipe("available", { planks: 2 }, { wood: 3 }),
  ], { special_wood: 5, wood: 10 });
  const details = constructionGoalDetails(view, goal);
  assert.equal(details.keepItems.wood, 6);
  assert.equal(details.keepItems.special_wood, undefined);
  assert.equal(details.excessItems.special_wood, 5);
});

test("a future workshop goal already protects its crafting inputs before the workshop is built", () => {
  const view = state({ buildings: { home: 1, warehouse: 1 } });
  const details = constructionGoalDetails(view, goal);
  assert.equal(details.keepItems.wood, 28);
  assert.equal(details.keepItems.fiber, 6);
  assert.equal(details.excessItems.fiber, 4);
});

test("a cyclic or overflowing craft plan conservatively retains stock", () => {
  const view = customState({ a: 1 }, [recipe("a", { a: 1 }, { b: 1 }), recipe("b", { b: 1 }, { a: 1 })], { a: 0, b: 3, wood: 10 });
  let details = constructionGoalDetails(view, goal);
  assert.equal(details.reservesComplete, false);
  assert.deepEqual(details.excessItems, { a: 0, b: 0, wood: 0 });
  view.catalog.recipes = [recipe("a", { a: 1 }, { b: Number.MAX_SAFE_INTEGER })];
  view.catalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 2).cost.items.a = 2;
  details = constructionGoalDetails(view, goal);
  assert.equal(details.reservesComplete, false);
  assert.deepEqual(details.excessItems, { a: 0, b: 0, wood: 0 });
});

test("pin, restore, replace and clear persist only the explicit target for this account", () => {
  const storage = memoryStorage(), first = createConstructionGoalStore(owner, storage);
  first.pin(state(), "home");
  assert.deepEqual(first.getSnapshot(), goal);
  assert.equal(first.getServerSnapshot(), null);
  const restored = createConstructionGoalStore(owner, storage);
  restored.restore();
  assert.deepEqual(restored.getSnapshot(), goal);
  restored.pin(state(), "warehouse");
  assert.deepEqual(restored.getSnapshot(), { buildingId: "warehouse", targetLevel: 2 });
  first.restore();
  assert.deepEqual(first.getSnapshot(), restored.getSnapshot());
  restored.clear(); first.restore();
  assert.equal(first.getSnapshot(), null);
  assert.equal(storage.values.has(constructionGoalStorageKey(owner)), false);
});

test("account changes and stale snapshots cannot write or clear another account's goal", () => {
  const storage = memoryStorage(), a = createConstructionGoalStore(owner, storage), other = "TEST-GOAL-0002";
  const b = createConstructionGoalStore(other, storage), guest = createConstructionGoalStore(null, storage);
  a.pin(state(), "home"); b.restore();
  assert.equal(b.getSnapshot(), null);
  b.pin(state(), "warehouse"); guest.pin(state(), "home");
  assert.equal(b.getSnapshot(), null);
  assert.equal(storage.values.size, 1);
  b.pin(state({ ownerPublicId: other }), "warehouse");
  const saved = storage.getItem(constructionGoalStorageKey(other));
  b.reconcile(state({ buildings: { warehouse: 2 } }));
  assert.equal(storage.getItem(constructionGoalStorageKey(other)), saved);
  a.clear();
  assert.equal(storage.getItem(constructionGoalStorageKey(other)), saved);
});

test("automatic cleanup waits for the matching owner's snapshot and cannot advance to a later level", () => {
  const storage = memoryStorage(), store = createConstructionGoalStore(owner, storage);
  store.pin(state(), "home"); store.reconcile(null);
  assert.deepEqual(store.getSnapshot(), goal);
  store.reconcile(state({ buildings: { home: 2 } }));
  assert.equal(store.getSnapshot(), null);
  assert.equal(storage.values.size, 0);
  store.pin(state(), "home");
  store.reconcile(state({ jobs: [{ kind: "construction", targetId: "home", targetLevel: 2 }] }));
  assert.equal(store.getSnapshot(), null);
});

test("an older tab preserves a newer known goal until its authoritative snapshot catches up", () => {
  const storage = memoryStorage(), older = createConstructionGoalStore(owner, storage), newer = createConstructionGoalStore(owner, storage);
  older.pin(state(), "home");
  const advanced = state({ buildings: { home: 2, workshop: 2, warehouse: 2 } });
  newer.pin(advanced, "home");
  const nextGoal = { buildingId: "home", targetLevel: 3 };
  const persisted = storage.getItem(constructionGoalStorageKey(owner));
  older.restore(); older.reconcile(state());
  assert.deepEqual(older.getSnapshot(), nextGoal);
  assert.equal(storage.getItem(constructionGoalStorageKey(owner)), persisted);
  assert.equal(constructionGoalDetails(state(), older.getSnapshot()), null);
  older.reconcile(state({ jobs: [{ kind: "construction", targetId: "home", targetLevel: 2 }] }));
  assert.deepEqual(older.getSnapshot(), nextGoal, "an older paid level is not this goal");
  older.reconcile(advanced);
  assert.deepEqual(constructionGoalDetails(advanced, older.getSnapshot()).goal, nextGoal);
  older.reconcile({ ...advanced, jobs: [{ kind: "construction", targetId: "home", targetLevel: 3 }] });
  assert.equal(older.getSnapshot(), null);
  assert.equal(storage.getItem(constructionGoalStorageKey(owner)), null);
});

test("corrupt cache and forged owner payloads cannot create an active goal", () => {
  const storage = memoryStorage(), store = createConstructionGoalStore(owner, storage), key = constructionGoalStorageKey(owner);
  for (const value of ["{", "null", "[]", JSON.stringify({ version: 2, ownerPublicId: owner, goal }),
    JSON.stringify({ version: 1, ownerPublicId: "someone-else", goal }),
    JSON.stringify({ version: 1, ownerPublicId: owner, goal: { buildingId: "home", targetLevel: 1.5 } })]) {
    storage.setItem(key, value); store.restore(); assert.equal(store.getSnapshot(), null);
  }
  storage.setItem(key, JSON.stringify({ version: 1, ownerPublicId: owner, goal: { buildingId: "unknown", targetLevel: 1 } }));
  store.restore(); store.reconcile(state());
  assert.equal(store.getSnapshot(), null);
  assert.equal(storage.getItem(key), null);
});

test("unavailable browser storage leaves a usable in-memory goal and stable store snapshots", () => {
  const unavailable = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const store = createConstructionGoalStore(owner, unavailable);
  let changes = 0;
  const unsubscribe = store.subscribe(() => changes++);
  store.restore(); store.pin(state(), "home");
  const saved = store.getSnapshot();
  store.restore(); store.pin(state(), "home");
  assert.equal(store.getSnapshot(), saved);
  assert.equal(changes, 1);
  store.clear();
  assert.equal(store.getSnapshot(), null);
  assert.equal(changes, 2);
  unsubscribe(); store.pin(state(), "home");
  assert.equal(changes, 2);
});
