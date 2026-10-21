import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-meal-availability-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { availableMealRecipe, mealBlockedReason, visibleMeals } = await vite.ssrLoadModule("/features/economy/ui/food/meal-availability.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
after(() => vite.close());
const now = Date.parse("2026-10-15T08:00:00Z");
const meal = economyCatalog.food.meals[0];
function controller(overrides = {}) {
  return { snapshot: { ownerPublicId: "meal-owner", revision: 1, serverTime: new Date(now).toISOString(),
    inventory: {}, buildings: { home: 1, dryer: 1, warehouse: 1 }, jobs: [], food: { heroMeal: null, builderMeal: null },
    catalog: structuredClone(economyCatalog), ...overrides }, now };
}
const ids = meals => meals.map(meal => meal.itemId);

test("contextual meals hide future recipes but retain owned portions and opened recipes without ingredients", () => {
  const economy = controller(), state = economy.snapshot;
  const initial = ids(visibleMeals(state));
  assert.ok(initial.includes("grilled_fish")); assert.ok(!initial.includes("legendary_fish"));
  const futureMeal = state.catalog.food.meals.find(meal => !initial.includes(meal.itemId)); assert.ok(futureMeal);
  state.inventory[futureMeal.itemId] = 1;
  assert.ok(ids(visibleMeals(state)).includes(futureMeal.itemId), "a gifted or traded portion remains usable before its recipe opens");
  assert.equal(availableMealRecipe(state, futureMeal.itemId), undefined);
  state.inventory = {}; state.buildings.home = 5; state.buildings.dryer = 5;
  state.progression = { recipes: { cook_grilled_fish: 1 } };
  assert.ok(ids(visibleMeals(state)).includes(futureMeal.itemId));
  assert.ok(availableMealRecipe(state, futureMeal.itemId));
});

test("the meal source retains its exact cooking recipe and all opening requirements", () => {
  const state = controller().snapshot;
  assert.equal(availableMealRecipe(state, "grilled_fish")?.id, "cook_grilled_fish");
  assert.equal(availableMealRecipe(state, "grilled_fish")?.buildingId, "dryer");
  state.buildings.dryer = 0; assert.equal(availableMealRecipe(state, "grilled_fish")?.id, "cook_grilled_fish", "the base campfire needs no dryer upgrade");
  const recipe = state.catalog.recipes.find(recipe => recipe.id === "cook_grilled_fish");
  delete recipe.baseCampfire;
  assert.equal(availableMealRecipe(state, "grilled_fish"), undefined, "catalogues without baseCampfire retain the level-one requirement");
  state.buildings.dryer = 5; state.buildings.home = 1;
  assert.equal(availableMealRecipe(state, "legendary_fish"), undefined);
  assert.equal(availableMealRecipe(state, "not_a_meal"), undefined);
});

test("hero food is blocked by a pending meal, actual journey and harvest collection while passive production stays independent", () => {
  for (const overrides of [
    { food: { heroMeal: meal.itemId, builderMeal: null } },
    { jobs: [{ kind: "exploration", finishesAt: new Date(now + 60_000).toISOString() }] },
    { jobs: [{ kind: "production", targetId: "garden", collection: { startedAt: new Date(now).toISOString() } }] },
  ]) assert.ok(mealBlockedReason(controller(overrides), "hero"));
  assert.equal(mealBlockedReason(controller({ jobs: [{ kind: "production", targetId: "workshop" }] }), "hero"), null);
});

test("builder food distinguishes the next meal from active, fed and finished construction", () => {
  const construction = { kind: "construction", targetId: "home", finishesAt: new Date(now + 60_000).toISOString() };
  for (const overrides of [
    { food: { heroMeal: null, builderMeal: meal.itemId } },
    { jobs: [{ ...construction, meal: { itemId: meal.itemId, consumer: "builder", speedBps: 1000 } }] },
    { jobs: [{ ...construction, finishesAt: new Date(now).toISOString() }] },
  ]) assert.ok(mealBlockedReason(controller(overrides), "builder"));
  assert.equal(mealBlockedReason(controller({ jobs: [construction] }), "builder"), null);
  assert.equal(mealBlockedReason(controller({ food: { heroMeal: meal.itemId, builderMeal: null } }), "builder"), null);
});

test("meal availability is read-only and absent meal configuration does not invent dishes", () => {
  const economy = controller(), before = structuredClone(economy.snapshot);
  visibleMeals(economy.snapshot); availableMealRecipe(economy.snapshot, meal.itemId);
  mealBlockedReason(economy, "hero"); mealBlockedReason(economy, "builder");
  assert.deepEqual(economy.snapshot, before);
  delete economy.snapshot.catalog.food; assert.deepEqual(visibleMeals(economy.snapshot), []);
});


test("meal recipes require personally collected prerequisite production, while owned portions remain visible", () => {
  const state = controller({ buildings: { home: 3, dryer: 1, warehouse: 1 } }).snapshot;
  assert.equal(availableMealRecipe(state, "fish_soup"), undefined);
  assert.equal(ids(visibleMeals(state)).includes("fish_soup"), false);
  state.inventory.grilled_fish = 1;
  assert.equal(availableMealRecipe(state, "fish_soup"), undefined, "a gifted prerequisite is not a personally collected production");
  state.inventory.fish_soup = 1;
  assert.equal(ids(visibleMeals(state)).includes("fish_soup"), true, "gifted or bought meals remain usable before their recipe opens");
  state.progression = { recipes: { cook_grilled_fish: 1 } };
  assert.equal(availableMealRecipe(state, "fish_soup")?.id, "cook_fish_soup");
  state.inventory = {};
  assert.equal(ids(visibleMeals(state)).includes("fish_soup"), true, "opened dishes remain listed even without ingredients");
});
