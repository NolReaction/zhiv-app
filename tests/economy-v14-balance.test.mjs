import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { economicMath } from "../scripts/lib/economy-math.mjs";
import { auditTimeEconomy } from "../scripts/audit-time-economy.mjs";
import { auditTradeRelations } from "../scripts/audit-trade-relations.mjs";
import { tradeOrderEffort, reputationXpForEffort, weeklyReputationXpForEffort } from "../scripts/lib/trade-relations-effort.mjs";
import { heroMealWorkBudgetSeconds, timeEconomyPricing } from "../scripts/lib/time-economy-pricing.mjs";

const read = () => JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
const near = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("every fishing loadout has a bounded return and paid bait never turns a departure into negative cash", () => {
  const catalog = read(), math = economicMath(catalog);
  near(math.catchPortfolio().expectedFishRevenue / 3, 10.6);
  let combinations = 0, best = 0;
  for (const route of catalog.fishing.routeIds) for (const rod of catalog.fishing.rods)
    for (const hook of catalog.fishing.hooks) for (const bait of [null, ...catalog.fishing.baits.map(row => row.itemId)]) {
      const trip = math.catchPortfolio(rod.id, bait, route, hook.id);
      const gross = trip.expectedFishRevenue / trip.slotMinutes.mochlik;
      const net = trip.expectedFishRevenue - trip.baitPurchaseCoins - trip.routeCoins - math.liquidation(trip.routeInputs);
      assert(gross <= 25.34, `${route}/${rod.id}/${hook.id}/${bait}: fishing mint`);
      assert(net > 0, `${route}/${rod.id}/${hook.id}/${bait}: paid bait loses the whole catch`);
      best = Math.max(best, gross); combinations++;
    }
  assert(combinations > 2000); assert(best > 20 && best < 25.34);
});

test("durable rod and hook prices repay over active hours, not hundreds of hours after fish compression", () => {
  const catalog = read(), math = economicMath(catalog), starter = math.catchPortfolio().expectedFishRevenue / 3;
  for (const rod of catalog.fishing.rods.filter(row => row.price > 0)) {
    const advantage = math.catchPortfolio(rod.id).expectedFishRevenue / 3 - starter;
    const activeHours = rod.price / advantage / 60;
    assert(activeHours >= 2 && activeHours <= 16, `${rod.id}: ${activeHours} active-hour return`);
  }
  for (const hook of catalog.fishing.hooks.filter(row => row.price > 0)) {
    const marginal = Math.max(...catalog.fishing.rods.filter(rod => rod.requiredHomeLevel <= hook.requiredHomeLevel)
      .map(rod => (math.catchPortfolio(rod.id, null, "shore", hook.id).expectedFishRevenue - math.catchPortfolio(rod.id).expectedFishRevenue) / 3));
    const activeHours = hook.price / marginal / 60;
    assert(activeHours >= 6 && activeHours <= 17, `${hook.id}: ${activeHours} active-hour marginal return`);
  }
});

test("each of six named fish dishes consumes its actual species and has repeatable request demand", () => {
  const catalog = read(), math = economicMath(catalog), effort = tradeOrderEffort(catalog);
  const speciesRecipes = catalog.recipes.filter(recipe => recipe.fishInput?.exactSpecies);
  assert.equal(speciesRecipes.length, 6);
  assert.equal(new Set(speciesRecipes.flatMap(recipe => recipe.fishInput.itemIds)).size, 6);
  for (const recipe of speciesRecipes) {
    const [species] = recipe.fishInput.itemIds, output = Object.keys(recipe.rewards)[0];
    assert.equal(recipe.fishInput.itemIds.length, 1); assert(recipe.cost.items[species] > 0);
    assert.equal(recipe.maxBatch, 1); assert(recipe.seconds <= 3600);
    const orders = catalog.food.orders.templates.filter(order => order.items[output]);
    assert(orders.length >= 2, `${output}: needs recurring demand beyond collection`);
    for (const order of orders) assert(effort(order).fishingUncertain, `${order.id}: exact species acquisition remains uncertain`);
    const group = catalog.fishing.classes.find(group => group.rarity === catalog.fishing.fish.find(fish => fish.itemId === species).rarity);
    assert(math.profile(species).slotMinutes.mochlik > math.profile(group.itemId).slotMinutes.mochlik,
      `${species}: exact-species work must not silently become generic class work`);
  }
  assert(catalog.stageOrders.every(course => course.orders.every(order =>
    speciesRecipes.every(recipe => !order.items[Object.keys(recipe.rewards)[0]]))), "mandatory projects never gate on named random fish");
});

test("hero food pays for useful active work across many manual departures; builder berries retain a distinct role", () => {
  const catalog = read(), price = timeEconomyPricing(catalog);
  for (const meal of catalog.food.meals) {
    assert.equal(meal.heroWorkSeconds, heroMealWorkBudgetSeconds(catalog, meal, price));
    const saved = meal.heroWorkSeconds - Math.ceil(meal.heroWorkSeconds * 10000 / (10000 + meal.heroSpeedBps));
    assert(saved / 60 * 10 >= price.price(meal.itemId) * 1.25 - 1);
    assert(meal.heroWorkSeconds / 180 >= 20, `${meal.itemId}: a snack must survive several short departures`);
  }
  const cranberry = catalog.food.meals.find(meal => meal.itemId === "cranberry_glaze");
  assert.equal(cranberry.builderSpeedBps, 10000);
  assert(21600 / 2 / 60 * 10 > price.price(cranberry.itemId), "a fully used six-hour construction justifies the best crop meal");
});

test("random expedition bonuses are useful bounded upside, separately disclosed from guaranteed route value", () => {
  const catalog = read(), report = auditTimeEconomy(catalog);
  assert.equal(report.expeditionFinds.length, report.activeHeroMaterialRoutes);
  for (const row of report.expeditionFinds) {
    assert(row.chance >= .3 && row.chance <= .5);
    assert(row.expectedNetCoinsPerMinute >= 10.5 && row.expectedNetCoinsPerMinute <= 11.5);
  }
  const mint = read(); mint.explorations.find(route => route.id === "forest").finds.entries[0].quantity = 20;
  assert.throws(() => auditTimeEconomy(mint), /expected bonus|maximum find/);
});

test("reputation values authored work, preserves the ten-percent ceiling and takes weeks even at every daily cap", () => {
  const catalog = read(), report = auditTradeRelations(catalog);
  assert.equal(reputationXpForEffort(240), 5);
  assert.equal(reputationXpForEffort(17 * 3600), 30);
  assert.equal(weeklyReputationXpForEffort(36000), 70);
  assert(report.pacing.optimisticEarliestElapsedDays >= 42);
  assert.equal(catalog.tradeRelations.maxBonusBps, 1000);
  for (const weekly of catalog.tradeRelations.weekly.templates) {
    assert.equal(weekly.stages.at(-1).pearls, 20);
    assert(weekly.stages.slice(0, -1).every(stage => !stage.pearls));
  }
  assert(catalog.food.orders.templates.every(order => !order.pearls));
});

test("month-scale work is not encoded as delivery waits, overnight production, or a required storage purchase", () => {
  const catalog = read(), report = auditTimeEconomy(catalog);
  assert(catalog.stageOrders.every(course => course.intervalSeconds === 0));
  for (const building of catalog.buildings) for (const level of building.levels) {
    assert(level.seconds <= (building.id === "home" ? 21600 : 14400));
    assert(Object.values(level.cost.items).reduce((total, value) => total + value, 0) <= 50);
  }
  assert(report.chapters.every(chapter => chapter.minimumProjectWaitSeconds === 0));
  assert(report.chapters[2].productionStarts > report.chapters[1].productionStarts * 3);
  assert(report.chapters[3].productionStarts > report.chapters[2].productionStarts);
  assert.deepEqual(catalog.productionSlots.upgrades.map(upgrade => upgrade.pricePearls), [200, 500]);
});
