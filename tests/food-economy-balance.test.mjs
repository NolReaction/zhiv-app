import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { auditFoodEconomy } from "../scripts/audit-food-economy.mjs";

const catalog = () => JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));

test("all selected fish keep a positive cooking margin including Pleska's full fish price", () => {
  const data = catalog(), report = auditFoodEconomy(data);
  assert.equal(report.meals.length, 4);
  assert.equal(report.recipes.length, data.recipes.filter(recipe => recipe.fishInput).length);
  for (const recipe of report.recipes) for (const variant of recipe.variants) assert(variant.saleProfitCoins > 0);
  assert.equal(report.recipes.find(recipe => recipe.recipeId === "cook_grilled_fish").variants.length, 3);
  assert.equal(report.recipes.find(recipe => recipe.recipeId === "cook_berry_fish").variants.find(variant => variant.fishItemId === "fish_bream").inputSaleOpportunityCoins, 330);
});

test("an expensive fish substitution cannot silently turn cooking into value destruction", () => {
  const data = catalog();
  data.recipes.find(recipe => recipe.id === "cook_grilled_fish").fishInput.itemIds.push("fish_shark");
  assert.throws(() => auditFoodEconomy(data), /cook_grilled_fish@fish_shark: cooking destroys/);
});

test("raw fish orders pay for caught inventory but cannot profit from instant NPC purchase", () => {
  const report = auditFoodEconomy(catalog());
  for (const order of report.templates) {
    assert(order.rewardCoins > order.itemReferenceCoins);
    if (order.directPurchaseCoins !== null) assert(order.rewardCoins < order.directPurchaseCoins);
  }
  const data = catalog();
  data.food.orders.templates.find(order => order.id === "plesk_river_catch").coins = 500;
  assert.throws(() => auditFoodEconomy(data), /instant buy-and-deliver arbitrage/);
});

test("orders cannot offer an unopened kitchen's meals", () => {
  const data = catalog();
  data.food.orders.templates.find(order => order.id === "builder_soup_pot").requiredBuildings = {};
  assert.throws(() => auditFoodEconomy(data), /unavailable production/);
});

test("one night catch funds a bulk common-fish plan with explicit kitchen time and input value", () => {
  const data = catalog(), report = auditFoodEconomy(data), plan = report.supplyPlans.find(plan => plan.id === "night_catch_family_meals");
  const route = data.explorations.find(route => route.id === "shore_camp");
  const guaranteed = route.rewards.fish - data.fishing.collectionDrawsByRoute.shore_camp;
  assert(plan.inputs.fish <= guaranteed);
  assert.equal(plan.campfireSlotMinutes, 240);
  assert.equal(plan.rewardCoins, 5700);
  assert.equal(plan.inputSaleOpportunityCoins, 1470);
  assert.equal(plan.extraOverInputsSaleCoins, 4230);
  assert.equal(plan.boughtFishNetCoins, 2950);
});

test("satiety speeds actions without applying a mistaken ten percent duration discount", () => {
  const report = auditFoodEconomy(catalog());
  for (const meal of report.meals) {
    assert.equal(meal.twentyFourHourBuildSeconds, 78546);
    assert.notEqual(meal.twentyFourHourBuildSeconds, 86400 * 0.9);
  }
  const data = catalog(); data.food.meals[0].heroSpeedBps = 2600;
  assert.throws(() => auditFoodEconomy(data), /Unbounded hero meal bonus/);
});

test("board simulations disclose inventory-rich bounds and finite deliveries per scheduled visit", () => {
  const report = auditFoodEconomy(catalog());
  for (const scenario of report.boardScenarios) {
    assert.equal(scenario.completed, scenario.days * scenario.visitsPerDay * report.timers.slots);
    assert(scenario.averageDailyExtraOverStockSaleCoins > 0);
    assert(scenario.averageDailyExtraOverStockSaleCoins < scenario.averageDailyRewardCoins);
  }
});
