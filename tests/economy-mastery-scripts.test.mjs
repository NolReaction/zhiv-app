import assert from "node:assert/strict";
import test from "node:test";
import { auditEconomyProgression, readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";
import { economicMath } from "../scripts/lib/economy-math.mjs";
import { personallyCaughtFish, recipeMasteryMet, recipeMasteryReachable } from "../scripts/lib/recipe-mastery.mjs";
import { tradeSourceAvailability } from "../scripts/lib/trade-relations-effort.mjs";

test("script unlock checks require all earned actions and count species rather than fish stock", () => {
  const catalog = readEconomyCatalog(), species = catalog.fishing.fish[0].itemId;
  const state = { inventory: { fish_common: 500, [species]: 500 }, fishing: { catches: { fish_common: 500, unknown: 500, [species]: 3 } },
    progression: { recipes: { cook_grilled_fish: 1 }, routes: { forest: 1 } } };
  const source = { requiredRecipes: { cook_grilled_fish: 1 }, requiredExplorations: { forest: 1 }, requiredFishCaught: 4 };
  assert.equal(personallyCaughtFish(catalog, state), 3);
  assert.equal(recipeMasteryMet(catalog, state, source), false);
  state.fishing.catches[species] = 4;
  assert.equal(recipeMasteryMet(catalog, state, source), true);
  state.progression.routes.forest = 0;
  assert.equal(recipeMasteryMet(catalog, state, source), false);
  assert.equal(recipeMasteryMet(catalog, {}, {}), true, "Older sources retain their ungated semantics");
});

test("reachability requires the fishing route and both eligible tackle kinds", () => {
  const catalog = readEconomyCatalog(), source = { requiredFishCaught: 4 }, recipes = new Set();
  assert.equal(recipeMasteryReachable(catalog, source, recipes, new Set(), 5), false);
  const routes = new Set(catalog.fishing.routeIds);
  assert.equal(recipeMasteryReachable(catalog, source, recipes, routes, 1), true);
  for (const rod of catalog.fishing.rods) rod.requiredHomeLevel = 5;
  assert.equal(recipeMasteryReachable(catalog, source, recipes, routes, 4), false);
  assert.equal(recipeMasteryReachable(catalog, source, recipes, routes, 5), true);
  catalog.fishing.hooks = [];
  assert.equal(recipeMasteryReachable(catalog, source, recipes, routes, 5), false);
});

test("math propagates required trips and their provision stations without repricing repeat production", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog);
  const bottle = math.profile("glass_bottle"), kit = math.profile("field_kit"), soup = math.profile("fish_soup");
  assert.equal(bottle.unlockExplorations.coastal_deposits, 2);
  assert.equal(bottle.producerLevels.dryer, 2);
  assert.equal(kit.unlockExplorations.far_bank_path, 2);
  assert.equal(kit.producerLevels.bridge, 1);
  assert.equal(soup.requiredFishCaught, 8);
  const ungated = structuredClone(catalog);
  for (const source of ungated.recipes) { delete source.requiredRecipes; delete source.requiredExplorations; delete source.requiredFishCaught; }
  assert.deepEqual(math.profile("glass_bottle").slotMinutes, economicMath(ungated).profile("glass_bottle").slotMinutes,
    "One-time learning is not charged again for every bottle");
});

test("trade reachability does not accept a provision recipe without its prerequisite expedition", () => {
  const catalog = readEconomyCatalog(), levels = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  levels.dryer = 1;
  const locked = tradeSourceAvailability(catalog, levels);
  assert.equal(locked.routes.has("coastal_deposits"), false);
  assert.equal(locked.recipes.has("make_glass_bottle"), false);
  levels.dryer = 2;
  const ready = tradeSourceAvailability(catalog, levels);
  assert.equal(ready.routes.has("coastal_deposits"), true);
  assert.equal(ready.recipes.has("make_glass_bottle"), true);
});

test("audit rejects invalid route and personal-catch requirements", () => {
  for (const fields of [{ requiredExplorations: { missing_route: 1 } }, { requiredExplorations: { forest: 0 } },
    { requiredFishCaught: -1 }, { requiredFishCaught: 1.5 }]) {
    const catalog = readEconomyCatalog();
    Object.assign(catalog.recipes.find(recipe => recipe.id === "make_trade_crate"), fields);
    assert.throws(() => auditEconomyProgression(catalog), /unknown or invalid exploration unlock|invalid personally caught fish requirement/);
  }
});

test("route provisions cannot form a hidden cycle with the recipe they unlock", () => {
  const catalog = readEconomyCatalog();
  catalog.explorations.find(route => route.id === "old_woodland").cost.items.tools = 1;
  assert.throws(() => economicMath(catalog).profile("tools"), /Recipe unlock cycle/);
  const levels = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  const reachable = tradeSourceAvailability(catalog, levels);
  assert.equal(reachable.routes.has("old_woodland"), false);
  assert.equal(reachable.recipes.has("make_tools"), false);
});
