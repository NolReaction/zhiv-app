import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { auditFoodEconomy } from "../scripts/audit-food-economy.mjs";

const catalog = () => JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
const report = auditFoodEconomy(catalog());

test("all selected fish and full cooking batches preserve their actual sale value", () => {
  const data = catalog();
  assert.equal(report.meals.length, 6);
  assert.equal(report.recipes.length, data.recipes.filter(recipe => recipe.fishInput).length);
  for (const recipe of report.recipes) for (const variant of recipe.variants) {
    assert(variant.saleProfitCoins > 0);
    assert(variant.fullBatchSaleProfitCoins > 0);
  }
  assert.equal(report.recipes.find(recipe => recipe.recipeId === "cook_berry_fish").variants.find(variant => variant.fishItemId === "fish_bream").inputSaleOpportunityCoins, 330);
  const hearty = data.recipes.find(recipe => recipe.id === "cook_hearty_fish");
  assert.deepEqual(hearty.fishInput.itemIds, data.fishing.fish.filter(fish => ["rare", "epic"].includes(fish.rarity)).map(fish => fish.itemId));
  assert.deepEqual(data.recipes.find(recipe => recipe.id === "cook_legendary_fish").fishInput.itemIds, ["fish_shark"]);
});

test("an expensive fish substitution cannot silently turn cooking into value destruction", () => {
  const data = catalog(); data.recipes.find(recipe => recipe.id === "cook_grilled_fish").fishInput.itemIds.push("fish_shark");
  assert.throws(() => auditFoodEconomy(data), /cook_grilled_fish@fish_shark: cooking destroys/);
});

test("real discounted offer prices are used and direct NPC resale loses coins", () => {
  assert.deepEqual(report.shopDeliveryBudgets.map(row => row.actualUnitPrice), [96, 144, 168]);
  assert.deepEqual(report.shopDeliveryBudgets.map(row => row.directResaleProfitForFullStock), [-96, -144, -168]);
  const data = catalog(); data.fishing.shop.fishPriceBps = 4000;
  assert.throws(() => auditFoodEconomy(data), /instant NPC buy-sell arbitrage/);
});

test("matching raw orders allow explicitly bounded profit from a six-fish delivery", () => {
  assert.deepEqual(report.shopDeliveryBudgets.map(row => row.matchingPureFishOrdersCeiling.netCoins), [84, 126, 132]);
  for (const row of report.shopDeliveryBudgets) {
    assert(row.matchingPureFishOrdersCeiling.purchasedFish <= row.stock);
    assert.equal(row.steadyNaturalDeliveriesPerDay, 4);
    assert.equal(row.pureFishOrderSteadyNaturalDailyCeiling, row.matchingPureFishOrdersCeiling.netCoins * 4);
  }
  const data = catalog(); data.food.orders.templates.find(order => order.id === "plesk_river_catch").coins = 5000;
  assert.throws(() => auditFoodEconomy(data), /excessive order premium/);
});

test("cooking ceilings account for extra inventory, real production and aggregate sale rounding", () => {
  assert.deepEqual(report.shopDeliveryBudgets.map(row => row.matchingCookedOrdersWithOrdinaryMaterialsCeiling.netCoins), [1774, 1486, 1342]);
  const cooked = report.shopDeliveryBudgets[0].matchingCookedOrdersWithOrdinaryMaterialsCeiling;
  assert.deepEqual(cooked.otherOwnedInputs, { wood: 6, berries: 12 });
  assert.equal(cooked.otherOwnedInputsSaleCoins, 350);
  assert.equal(cooked.productionMinutes, 90);
  const expanded = report.shopDeliveryBudgets[0].matchingOrdersWithAdditionalRawIngredientsCeiling;
  assert.deepEqual(expanded.otherOwnedInputs, { wood: 4, fish_reedperch: 2, berries: 8 });
  assert.equal(expanded.otherOwnedInputsSaleCoins, 590);
  assert.equal(expanded.productionMinutes, 150);
  assert.equal(expanded.netCoins, 2714);
});

test("a fresh account has diverse themed orders with unique compositions and no completion delay", () => {
  assert.equal(report.boardPolicy.completionCooldownSeconds, 0);
  assert(report.boardPolicy.starterTemplates >= 10);
  const data = catalog(), builders = data.food.orders.templates.filter(order => order.residentId === "builder");
  const foods = new Set(data.food.meals.map(meal => meal.itemId));
  assert(builders.filter(order => !Object.keys(order.items).some(id => foods.has(id) || id.startsWith("fish"))).length / builders.length >= .8);
  data.food.orders.templates.push({ ...data.food.orders.templates[0], id: "same_goods_different_name", name: "Different title" });
  assert.throws(() => auditFoodEconomy(data), /Duplicate order composition/);
});

test("orders cannot offer an unopened kitchen's meals", () => {
  const data = catalog(); data.food.orders.templates.find(order => order.id === "plesk_warm_lunch").requiredBuildings = {};
  assert.throws(() => auditFoodEconomy(data), /unavailable production/);
});

test("stronger dishes improve both consumers and divide duration rather than subtracting percentages", () => {
  assert.deepEqual(report.meals.map(meal => meal.heroSpeedPercent), [10, 25, 40, 60, 80, 100]);
  assert.deepEqual(report.meals.map(meal => meal.builderSpeedPercent), [10, 20, 35, 50, 70, 90]);
  assert.equal(report.meals[0].twentyFourHourBuildSeconds, 78546);
  assert.equal(report.meals.at(-1).eightHourHeroTripSeconds, 14400);
  assert.equal(report.meals.at(-1).twentyFourHourBuildSeconds, 45474);
  const data = catalog(); data.food.meals.at(-1).heroSpeedBps = 10001;
  assert.throws(() => auditFoodEconomy(data), /Unbounded hero meal bonus/);
});

test("fishing ROI subtracts the consumed dish and exposes expensive short-trip meals", () => {
  const legendary = report.meals.find(meal => meal.itemId === "legendary_fish");
  const short = legendary.fishingReturn.find(row => row.routeId === "shore").best;
  assert(short.withFoodNetCoinsPerHour < 0);
  assert.equal(short.dishOpportunityCoins, 2400);
  const long = legendary.fishingReturn.find(row => row.routeId === "shore_camp").best;
  assert(long.withFoodNetCoinsPerHour < long.withoutFoodNetCoinsPerHour);
  assert(long.compatibleFishExpectedPerJob < 1, "one fed trip cannot guarantee the next shark meal");
});

test("build projection distinguishes unlock-feasible stocked meals from an impossible all-legendary start", () => {
  assert(report.construction.stockedFoodBuildSeconds < report.construction.baseBuildSeconds);
  assert(report.construction.stockedFoodBuildSeconds > report.construction.absoluteAllLegendaryTheoreticalSeconds);
  assert(report.construction.mealPreparationMinutes > 0);
  assert(report.construction.mealCounts.grilled_fish > 0);
});
