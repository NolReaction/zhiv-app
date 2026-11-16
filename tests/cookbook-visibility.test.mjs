import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { cookbookCoreIngredients, cookbookRecipeVisible, cookbookPages } = await vite.ssrLoadModule("/features/economy/ui/food/cookbook-visibility.ts");
const { worldRecipeAccessReason } = await vite.ssrLoadModule("/features/economy/ui/shared/world-stations.ts");
const recipes = economyCatalog.recipes.filter(recipe => recipe.buildingId === "dryer");
const recipe = id => recipes.find(entry => entry.id === id);
const state = (overrides = {}) => ({ catalog: economyCatalog, buildings: Object.fromEntries(economyCatalog.buildings.map(building => [building.id, 5])), familiarItems: [], inventory: {}, jobs: [],
  progression: { recipes: {}, routes: {}, skills: { version: 1, cookingSeconds: 0 } }, fishing: { catches: {}, stock: {} }, ...overrides });
const visible = (snapshot, id) => cookbookRecipeVisible(snapshot, recipe(id));

test("an untouched book starts with fish, then compote at campfire level one", () => {
  const snapshot = state({ buildings: { home: 1, dryer: 0 } });
  assert.deepEqual(cookbookPages(snapshot, recipes).known.map(entry => entry.id), ["cook_grilled_fish"]);
  snapshot.buildings.dryer = 1;
  assert.deepEqual(cookbookPages(snapshot, recipes).known.map(entry => entry.id), ["cook_grilled_fish", "cook_compote"]);
});

test("a high house and every tradable unlocked item never substitute for familiar ingredients", () => {
  const snapshot = state({ unlockedItems: economyCatalog.items.map(item => item.id) });
  assert.deepEqual(cookbookPages(snapshot, recipes).known.map(entry => entry.id), ["cook_grilled_fish", "cook_compote"]);
});

test("ingredient familiarity and station progress are independent gates", () => {
  const snapshot = state({ familiarItems: ["berries", "fish_rare"], buildings: { home: 2, dryer: 2 } });
  assert.equal(visible(snapshot, "cook_hearty_fish"), false);
  snapshot.buildings = { home: 3, dryer: 3 };
  assert.equal(visible(snapshot, "cook_hearty_fish"), true);
  assert.equal(visible({ ...snapshot, familiarItems: ["berries"] }, "cook_hearty_fish"), false);
});

test("fuel and packaging do not conceal familiar food, but all core food ingredients matter", () => {
  assert.deepEqual(cookbookCoreIngredients(recipe("cook_epic_fish")), ["berries", "fish_epic"]);
  assert.deepEqual(cookbookCoreIngredients(recipe("cook_mooncarp_blueberries")), ["fish_mooncarp", "blueberries"]);
  const snapshot = state({ familiarItems: ["fish_mooncarp", "blueberries"] });
  assert.equal(visible(snapshot, "cook_mooncarp_blueberries"), true);
  assert.equal(visible({ ...snapshot, familiarItems: ["fish_mooncarp"] }, "cook_mooncarp_blueberries"), false);
});

test("a visible recipe may still have its own cooking or fishing quest", () => {
  const snapshot = state({ familiarItems: ["fish_common", "berries"] });
  assert.equal(visible(snapshot, "cook_fish_soup"), true);
  assert.match(worldRecipeAccessReason(snapshot, recipe("cook_fish_soup")), /Приготовьте и заберите/);
});

test("once cooked, a page survives empty inventory and a later requirement change", () => {
  const snapshot = state({ buildings: { home: 1, dryer: 0 }, progression: { recipes: { cook_epic_fish: 1 }, routes: {} } });
  assert.equal(visible(snapshot, "cook_epic_fish"), true);
  assert.match(worldRecipeAccessReason(snapshot, recipe("cook_epic_fish")), /Доступно с/);
  assert.equal(cookbookRecipeVisible(snapshot, { ...recipe("cook_epic_fish"), retired: true }), false);
});

test("saved familiar ingredients remain known without stock, purchases can seed knowledge without inventing catches", () => {
  const snapshot = state({ familiarItems: ["strawberries"], inventory: {} });
  assert.equal(visible(snapshot, "cook_strawberry_compote"), true);
  assert.equal(visible(state({ inventory: { strawberries: 1 } }), "cook_strawberry_compote"), true);
  const bought = state({ inventory: { fish_common: 1 }, fishing: { stock: { fish_silverfin: 1 }, catches: {} } });
  assert.equal(visible(bought, "cook_grilled_silverfin"), true);
  assert.deepEqual(bought.fishing.catches, {});
});

test("species familiarity opens its class without inventing other exact species", () => {
  const snapshot = state({ fishing: { catches: { fish_silverfin: 1 } }, familiarItems: ["berries"] });
  assert.equal(visible(snapshot, "cook_grilled_silverfin"), true);
  assert.equal(visible(snapshot, "cook_forest_pan"), true);
  assert.equal(visible(state({ familiarItems: ["fish_common"] }), "cook_grilled_silverfin"), false);
});

test("legacy completed cooking restores its ingredients and products even after all stock is spent", () => {
  const snapshot = state({ familiarItems: undefined, progression: { recipes: { cook_strawberry_compote: 1, cook_compote: 1 }, routes: {} } });
  assert.equal(visible(snapshot, "experiment_berry_pastila"), true);
  assert.equal(snapshot.familiarItems, undefined, "render projection never writes progression");
});

test("experiments need known ingredients and cooking skill; a gifted secret dish does not reveal its recipe", () => {
  const snapshot = state({ familiarItems: ["fish_soup", "blueberries"] });
  assert.equal(visible(snapshot, "experiment_river_aspic"), false);
  snapshot.progression.skills.cookingSeconds = economyCatalog.skills.levels[2].requiredSeconds;
  assert.equal(visible(snapshot, "experiment_river_aspic"), true);
  assert.equal(visible(state({ inventory: { berry_pastila: 1 } }), "experiment_berry_pastila"), false);
});

test("unfinished rewards and possible route drops do not become known food", () => {
  const snapshot = state({ jobs: [{ kind: "production", recipeId: "cook_strawberry_compote", rewards: { strawberry_compote: 1 } }], familiarItems: ["berries"] });
  assert.equal(visible(snapshot, "experiment_berry_pastila"), false);
  const fishing = state({ progression: { routes: { [economyCatalog.fishing.routeIds[0]]: 10 }, recipes: {} } });
  assert.equal(visible(fishing, "cook_grilled_silverfin"), false);
});
