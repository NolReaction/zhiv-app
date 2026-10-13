import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { auditFoodEconomy } from "../scripts/audit-food-economy.mjs";

const catalog = () => JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
const report = auditFoodEconomy(catalog());

test("exact fish classes and full cooking batches preserve their actual sale value", () => {
  const data = catalog();
  assert.equal(report.meals.length, 6);
  assert.equal(report.recipes.length, data.recipes.filter(recipe => Object.keys(recipe.cost.items).some(id => data.fishing.classes.some(group => group.itemId === id))).length);
  for (const recipe of report.recipes) for (const variant of recipe.variants) {
    assert(variant.saleProfitCoins > 0);
    assert(variant.fullBatchSaleProfitCoins > 0);
  }
  const berry = report.recipes.find(recipe => recipe.recipeId === "cook_berry_fish");
  assert.deepEqual(berry.variants.map(variant => variant.fishItemId), ["fish_uncommon"]);
  const hearty = data.recipes.find(recipe => recipe.id === "cook_hearty_fish");
  assert.equal(hearty.cost.items.fish_rare, 1);
  assert.equal(hearty.cost.items.fish_epic, undefined);
  assert.equal(hearty.fishInput, undefined);
  assert.equal(data.recipes.find(recipe => recipe.id === "cook_legendary_fish").cost.items.fish_legendary, 1);
});

test("an expensive fish substitution cannot silently turn cooking into value destruction", () => {
  const data = catalog(), recipe = data.recipes.find(recipe => recipe.id === "cook_grilled_fish");
  delete recipe.cost.items.fish_common; recipe.cost.items.fish_legendary = 1;
  assert.throws(() => auditFoodEconomy(data), /cook_grilled_fish@fish_legendary: cooking destroys/);
});

test("real discounted offer prices are used and direct NPC resale loses coins", () => {
  assert.deepEqual(report.shopDeliveryBudgets.map(row => row.actualUnitPrice), [120]);
  assert.deepEqual(report.shopDeliveryBudgets.map(row => row.directResaleProfitForFullStock), [-480]);
  const data = catalog(); data.fishing.shop.fishPriceBps = 1000;
  assert.throws(() => auditFoodEconomy(data), /instant NPC buy-sell arbitrage/);
});

test("buying raw fish and immediately submitting orders cannot mint coins", () => {
  assert.deepEqual(report.shopDeliveryBudgets.map(row => row.matchingPureFishOrdersCeiling.netCoins), [0]);
  for (const row of report.shopDeliveryBudgets) {
    assert(row.matchingPureFishOrdersCeiling.purchasedFish <= row.stock);
    assert.equal(row.steadyNaturalDeliveriesPerDay, 4);
    assert.equal(row.pureFishOrderSteadyNaturalDailyCeiling, row.matchingPureFishOrdersCeiling.netCoins * 4);
  }
  const data = catalog(); data.food.orders.templates.find(order => order.id === "plesk_river_catch").coins = 5000;
  assert.throws(() => auditFoodEconomy(data), /excessive order premium/);
});

test("cooking ceilings account for extra inventory, real production and aggregate sale rounding", () => {
  assert.deepEqual(report.shopDeliveryBudgets.map(row => row.matchingCookedOrdersWithOrdinaryMaterialsCeiling.netCoins), [0]);
  const cooked = report.shopDeliveryBudgets[0].matchingCookedOrdersWithOrdinaryMaterialsCeiling;
  assert.deepEqual(cooked.otherOwnedInputs, {});
  assert.equal(cooked.otherOwnedInputsSaleCoins, 0);
  assert.equal(cooked.productionMinutes, 0);
  const expanded = report.shopDeliveryBudgets[0].matchingOrdersWithAdditionalRawIngredientsCeiling;
  assert.deepEqual(expanded.otherOwnedInputs, { wood: 3, berries: 36 });
  assert.equal(expanded.otherOwnedInputsSaleCoins, 450);
  assert.equal(expanded.productionMinutes, 360);
  assert.equal(expanded.netCoins, 4440);
});

test("a fresh account has diverse themed orders with unique compositions and no completion delay", () => {
  assert.equal(report.boardPolicy.completionCooldownSeconds, 0);
  assert(report.boardPolicy.starterTemplates >= 5);
  assert.equal(report.boardPolicy.tutorialTemplates, 4);
  assert(report.boardPolicy.secondStageTemplates >= 10);
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
  assert(long.compatibleFishExpectedPerJob > 1, "the arcade legendary kit can replenish a dish on average");
  assert(long.compatibleFishExpectedPerJob < 8, "an expected catch remains below a guaranteed all-legendary trip");
});

test("build projection distinguishes unlock-feasible stocked meals from an impossible all-legendary start", () => {
  assert(report.construction.stockedFoodBuildSeconds < report.construction.baseBuildSeconds);
  assert(report.construction.stockedFoodBuildSeconds > report.construction.absoluteAllLegendaryTheoreticalSeconds);
  assert(report.construction.mealPreparationMinutes > 0);
  assert(report.construction.mealCounts.grilled_fish > 0);
});


test("independent audit agrees with shared progression quotes and exposes source occupancy", async () => {
  const vectors = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/orders-progression-vectors.json", import.meta.url), "utf8"));
  for (const expected of vectors.scaling) {
    const row = report.templates.find(row => row.id === expected.templateId).byHome.find(row => row.homeLevel === expected.home);
    assert.deepEqual(row.items, expected.items); assert.equal(row.rewardCoins, expected.coins);
  }
  const final = report.templates.find(row => row.id === "builder_final_fittings").byHome.at(-1);
  assert(final.inputSourceSlotMinutes.kiln < 24 * 60, "late order must not multiply furnace work into several days");
  assert(final.inputSourceSlotMinutes.workshop < 24 * 60);
  const data = catalog(); data.food.orders.progression.craftedBpsByHome[4] = 50000;
  assert.throws(() => auditFoodEconomy(data), /Invalid craftedBpsByHome progression/);
});

test("audit rejects hidden upstream gaps even when the final recipe is unlocked", () => {
  const data = catalog(); delete data.food.orders.templates.find(order => order.id === "builder_tools").requiredBuildings.kiln;
  assert.throws(() => auditFoodEconomy(data), /unavailable production chain for tools/);
});
