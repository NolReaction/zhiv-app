import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { familiarEconomyItems } = await vite.ssrLoadModule("/features/economy/domain/familiar-items.ts");
const { newEconomyState, applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
after(() => vite.close());

test("available sources and unseen future goods are not ingredient knowledge", () => {
  const state = { inventory: {}, unlockedItems: ["fish_legendary", "cranberries"], buildings: { home: 5, garden: 5 } };
  assert.deepEqual(familiarEconomyItems(state), []);
});

test("read-only projection recovers owned goods without changing an old save", () => {
  const state = { inventory: { blueberries: 2, strawberries: 0, unknown: 1 } };
  const before = structuredClone(state);
  assert.deepEqual(familiarEconomyItems(state), ["blueberries"]);
  assert.deepEqual(state, before);
});

test("precise fish knowledge retains the species and its class but does not invent a species", () => {
  assert.deepEqual(familiarEconomyItems({ inventory: { fish_rare: 1 } }), ["fish_rare"]);
  const species = economyCatalog.fishing.fish.find(fish => fish.itemId === "fish_silverfin");
  const group = economyCatalog.fishing.classes.find(group => group.rarity === species.rarity);
  assert.deepEqual(familiarEconomyItems({ inventory: { [group.itemId]: 1 }, fishing: { stock: { fish_silverfin: 1 } } }), [group.itemId, "fish_silverfin"].sort());
  assert.deepEqual(familiarEconomyItems({ inventory: {}, fishing: { stock: { fish_silverfin: 1 } } }), []);
});

test("confirmed cooking retains both used ingredients and the dish after stocks run out", () => {
  const recipe = economyCatalog.recipes.find(recipe => recipe.id === "cook_blueberry_compote");
  const actual = familiarEconomyItems({ progression: { recipes: { [recipe.id]: 1 } } });
  for (const id of [...Object.keys(recipe.cost.items), ...Object.keys(recipe.rewards)]) assert(actual.includes(id));
});

test("pending jobs and random future fishing do not reveal ingredients", () => {
  assert.deepEqual(familiarEconomyItems({ jobs: [{ rewards: { fish_sturgeon: 1 } }], progression: { routes: { shore: 1 } } }), []);
});

test("legacy ledger seeds once, while current received stock remains discoverable", () => {
  assert.deepEqual(familiarEconomyItems({}, ["cranberries"]), ["cranberries"]);
  assert.deepEqual(familiarEconomyItems({ familiarItems: [], inventory: { blueberries: 1 } }, ["cranberries"]), ["blueberries"]);
});

test("initialized knowledge does not learn future ingredients from old recipe counters", () => {
  assert.deepEqual(familiarEconomyItems({ familiarItems: ["berries"], inventory: {},
    progression: { recipes: { cook_blueberry_compote: 1 }, routes: { old_forest: 1 } } }), ["berries"]);
});

test("successful consumption seals ingredient knowledge, rejected commands do not mutate it", () => {
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.inventory = { berries: 2 };
  const command = { action: "start_production", targetId: "cook_compote", quantity: 1, totalPrice: 0 };
  state.buildings.dryer = 1;
  applyEconomyCommand(state, command, Date.parse("2026-11-02T00:00:00Z"), () => crypto.randomUUID());
  assert(state.familiarItems.includes("berries"));
  assert.equal(state.inventory.berries ?? 0, 0);
  const before = structuredClone(state);
  assert.throws(() => applyEconomyCommand(state, command, Date.parse("2026-11-02T00:00:01Z"), () => crypto.randomUUID()));
  assert.deepEqual(state.familiarItems, before.familiarItems);
});
