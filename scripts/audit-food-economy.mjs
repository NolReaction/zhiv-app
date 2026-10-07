import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { economicMath } from "./lib/economy-math.mjs";

const rounded = value => Number(value.toFixed(3));
const sum = values => values.reduce((total, value) => total + value, 0);
const hash = value => { let result = 2166136261; for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619) >>> 0; return result; };
const valueOf = (items, quantities) => sum(Object.entries(quantities).map(([id, count]) => items.get(id).baseSellPrice * count));

/** Exact catalog arithmetic; no invented sell multiplier, random sample or claim
 * that a rare catch / particular rotating order is guaranteed on a given day. */
export function auditFoodEconomy(catalog) {
  const food = catalog.food, scale = catalog.currencyScale, math = economicMath(catalog);
  assert(food?.meals.length >= 4, "A meal catalog is required");
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const fish = new Map(catalog.fishing.fish.map(item => [item.itemId, item]));
  const mealIds = new Set(food.meals.map(meal => meal.itemId));
  assert.equal(mealIds.size, food.meals.length, "Duplicate meal");
  const money = value => rounded(value);
  const positiveInt = value => Number.isSafeInteger(value) && value > 0;
  const orders = food.orders;
  assert.equal(orders.slots, 3);
  for (const key of ["refreshSeconds", "replacementSeconds", "completionSeconds"]) assert(positiveInt(orders[key]), `Invalid ${key}`);
  assert.equal(new Set(orders.templates.map(order => order.id)).size, orders.templates.length, "Duplicate order template");
  const fishRecipes = catalog.recipes.filter(recipe => recipe.fishInput);
  const referenceCatch = math.catchPortfolio(), referenceRoute = catalog.explorations.find(route => route.id === "shore");
  const referenceFishingCoinsPerHour = (referenceCatch.expectedFishRevenue - referenceCatch.routeCoins
    - referenceCatch.baitPurchaseCoins - math.liquidation(referenceCatch.routeInputs)) * 3600 / referenceRoute.seconds;
  const recipes = fishRecipes.map(recipe => {
    const options = recipe.fishInput.itemIds, original = Object.keys(recipe.cost.items).filter(id => options.includes(id));
    assert.equal(original.length, 1, `${recipe.id}: exactly one fish placeholder is required`);
    assert.equal(new Set(options).size, options.length, `${recipe.id}: duplicate fish option`);
    assert(options.every(id => fish.has(id)), `${recipe.id}: unknown fish option`);
    const quantity = recipe.cost.items[original[0]], revenue = math.liquidation(recipe.rewards);
    const variants = options.map(id => {
      const cost = { ...recipe.cost.items }; delete cost[original[0]]; cost[id] = quantity;
      const opportunity = math.liquidation(cost) + recipe.cost.coins;
      assert(revenue > opportunity, `${recipe.id}@${id}: cooking destroys actual sale proceeds`);
      const nonFish = { ...cost }; delete nonFish[id];
      const purchaseCost = fish.get(id).rarity === "common" ? fish.get(id).buyPrice * quantity + math.liquidation(nonFish) + recipe.cost.coins : null;
      return { fishItemId: id, quantity, inputReferenceCoins: money(valueOf(items, cost) + recipe.cost.coins),
        inputSaleOpportunityCoins: money(opportunity), saleProfitCoins: money(revenue - opportunity),
        saleProfitPerStationHour: money((revenue - opportunity) * 3600 / recipe.seconds),
        shopFishAndOtherInputsSaleOpportunityCoins: purchaseCost === null ? null : money(purchaseCost),
        shopFishCookingSaleProfitCoins: purchaseCost === null ? null : money(revenue - purchaseCost) };
    });
    return { recipeId: recipe.id, homeLevel: recipe.requiredHomeLevel, stationLevel: recipe.buildingLevel,
      minutes: recipe.seconds / 60, output: recipe.rewards, maxBatch: recipe.maxBatch,
      singleSlotBatchesPerDay: rounded(86400 / recipe.seconds), outputSaleCoins: money(revenue), variants,
      defaultInputSourceSlotMinutes: Object.fromEntries(Object.entries(math.batch(recipe).slotMinutes).map(([id, minutes]) => [id, rounded(minutes)])) };
  });
  const meals = food.meals.map(meal => {
    assert(items.has(meal.itemId), `Unknown meal ${meal.itemId}`);
    assert(Number.isInteger(meal.heroSpeedBps) && meal.heroSpeedBps >= 0 && meal.heroSpeedBps <= 2500, "Unbounded hero meal bonus");
    assert.equal(meal.builderSpeedBps, 1000, "Builder bonus is exactly +10% speed");
    const producer = catalog.recipes.find(recipe => recipe.rewards[meal.itemId]);
    assert(producer?.fishInput, `${meal.itemId}: no fish recipe`);
    const duration = (seconds, bps) => Math.ceil(seconds * 10000 / (10000 + bps));
    return { itemId: meal.itemId, heroSpeedPercent: meal.heroSpeedBps / 100, builderSpeedPercent: meal.builderSpeedBps / 100,
      mealSaleOpportunityCoins: money(math.liquidation({ [meal.itemId]: 1 })),
      minimumBaseTripHoursForSavedTimeToMatchMealSaleValue: meal.heroSpeedBps ? rounded(math.liquidation({ [meal.itemId]: 1 })
        / referenceFishingCoinsPerHour * (10000 + meal.heroSpeedBps) / meal.heroSpeedBps) : null,
      eightHourHeroTripSeconds: duration(28800, meal.heroSpeedBps), eightHourHeroMinutesSaved: rounded((28800 - duration(28800, meal.heroSpeedBps)) / 60),
      twentyFourHourBuildSeconds: duration(86400, meal.builderSpeedBps), twentyFourHourBuildMinutesSaved: rounded((86400 - duration(86400, meal.builderSpeedBps)) / 60) };
  });
  const templates = orders.templates.map(order => {
    assert(["plesk", "builder"].includes(order.residentId), `${order.id}: unknown resident`);
    assert(positiveInt(order.coins) && order.coins % scale === 0, `${order.id}: invalid coin reward`);
    assert(Object.keys(order.items).length > 0, `${order.id}: empty order`);
    for (const [id, count] of Object.entries(order.items)) {
      assert(items.has(id) && positiveInt(count), `${order.id}: invalid ingredient`);
      assert(math.sourceHome(id) <= order.requiredHomeLevel, `${order.id}: home gate cannot source ${id}`);
      const producer = catalog.recipes.find(recipe => recipe.rewards[id]);
      if (producer) assert((order.requiredBuildings[producer.buildingId] ?? ({ garden: 1 }[producer.buildingId] ?? 0)) >= producer.buildingLevel,
        `${order.id}: unavailable production for ${id}`);
    }
    const referenceValue = valueOf(items, order.items), saleValue = math.liquidation(order.items);
    assert(order.coins > referenceValue, `${order.id}: orders must reward more than full reference item value`);
    const allPurchasable = Object.keys(order.items).every(id => fish.get(id)?.rarity === "common");
    const directBuyCost = allPurchasable ? sum(Object.entries(order.items).map(([id, count]) => fish.get(id).buyPrice * count)) : null;
    if (directBuyCost !== null) assert(order.coins < directBuyCost, `${order.id}: instant buy-and-deliver arbitrage`);
    const rawInputs = {}, productionSlots = {};
    for (const [id, count] of Object.entries(order.items)) {
      const profile = math.profile(id);
      for (const [input, amount] of Object.entries(profile.rawInputs)) rawInputs[input] = (rawInputs[input] ?? 0) + amount * count;
      for (const [station, minutes] of Object.entries(profile.slotMinutes)) productionSlots[station] = (productionSlots[station] ?? 0) + minutes * count;
    }
    return { id: order.id, homeLevel: order.requiredHomeLevel, items: order.items, rewardCoins: money(order.coins),
      itemReferenceCoins: money(referenceValue), directSaleCoins: money(saleValue), extraOverDirectSaleCoins: money(order.coins - saleValue),
      directPurchaseCoins: directBuyCost === null ? null : money(directBuyCost),
      defaultSourceSlotMinutes: Object.fromEntries(Object.entries(productionSlots).map(([id, minutes]) => [id, rounded(minutes)])),
      defaultRawInputs: rawInputs };
  });

  // Finite seven-day board schedule, starting 2026-10-08 UTC. Every requested item
  // is assumed stocked: these figures are rotation/cooldown ceilings, not income
  // promises. The supply plans below expose the actual production bottlenecks.
  const boardScenarios = [1, 2, 3, 5].flatMap(homeLevel => [3, 8].map(visitsPerDay => {
    const pool = orders.templates.filter(order => order.requiredHomeLevel <= homeLevel && Object.values(order.requiredBuildings).every(level => level <= homeLevel))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    assert(pool.length >= orders.slots, `Home ${homeLevel}: inadequate starter order pool`);
    let cycle = -1, slots = [], completed = 0, coins = 0, inputSale = 0;
    const start = Date.parse("2026-10-08T00:00:00Z") / 1000;
    for (let day = 0; day < 7; day++) for (let visit = 0; visit < visitsPerDay; visit++) {
      const now = start + day * 86400 + visit * 86400 / visitsPerDay, currentCycle = Math.floor(now / orders.refreshSeconds);
      if (currentCycle !== cycle) { cycle = currentCycle; slots = Array.from({ length: orders.slots }, () => ({ sequence: 0, readyAt: 0 })); }
      slots.forEach((slot, index) => {
        if (now < slot.readyAt) return;
        const order = pool[(hash(`${cycle}:${index}`) + slot.sequence) % pool.length];
        completed++; coins += order.coins; inputSale += math.liquidation(order.items); slot.sequence++; slot.readyAt = now + orders.completionSeconds;
      });
    }
    return { homeLevel, visitsPerDay, days: 7, completed, averageDailyRewardCoins: money(coins / 7), averageDailyExtraOverStockSaleCoins: money((coins - inputSale) / 7) };
  }));
  const plans = [
    { id: "starter_three_lunches", homeLevel: 1, orders: { builder_grilled_lunch: 3 } },
    { id: "night_catch_family_meals", homeLevel: 2, orders: { builder_grilled_lunch: 2, builder_soup_pot: 2 } },
  ].map(plan => {
    const output = {}, directInputs = {}; let coins = 0, minutes = 0, count = 0;
    for (const [id, amount] of Object.entries(plan.orders)) {
      const order = orders.templates.find(order => order.id === id); coins += order.coins * amount; count += amount;
      for (const [item, quantity] of Object.entries(order.items)) output[item] = (output[item] ?? 0) + quantity * amount;
    }
    for (const [id, quantity] of Object.entries(output)) {
      const recipe = catalog.recipes.find(recipe => recipe.rewards[id]); assert(recipe && Object.keys(recipe.rewards).length === 1);
      const batches = quantity / recipe.rewards[id]; minutes += recipe.seconds / 60 * batches;
      for (const [input, amount] of Object.entries(recipe.cost.items)) directInputs[input] = (directInputs[input] ?? 0) + amount * batches;
    }
    const inputSale = math.liquidation(directInputs), purchasedInputs = { ...directInputs }; delete purchasedInputs.fish;
    const purchaseCost = (directInputs.fish ?? 0) * fish.get("fish").buyPrice + math.liquidation(purchasedInputs);
    return { ...plan, matchingOffersRequired: count, items: output, inputs: directInputs, campfireSlotMinutes: minutes,
      rewardCoins: money(coins), inputSaleOpportunityCoins: money(inputSale), extraOverInputsSaleCoins: money(coins - inputSale),
      boughtFishAndOtherInputsOpportunityCoins: money(purchaseCost), boughtFishNetCoins: money(coins - purchaseCost),
      boughtFishNetPerCampfireHour: money((coins - purchaseCost) * 60 / minutes) };
  });
  return { catalogVersion: catalog.version, currency: "visible coins, identical to catalog integer amounts; currencyScale is a historical denomination marker",
    assumptions: ["Pleska buys fish at full baseSellPrice; the local buyer pays 60% for other goods, rounded down to multiples of 10 exactly as the game",
      "Fishing/source slot minutes are expectations, not rare-catch delivery guarantees; byproducts are not subtracted as free profit",
      "Food costs one dish, never stacks, lasts until one eligible action; +10% speed means duration divided by 1.1",
      "Meal time break-even values saved time at continuous starter shore fishing; eating pays for convenience on short trips, never promises extra coins or changes fish odds",
      "Orders pay coins only and never feed either actor; replacements cost time, not coins",
      "Stock-rich board simulations are explicit upper bounds; no market demand, fish RNG, inventory, production or acquisition waits included",
      "Supply plans require matching offers; 18 guaranteed river fish from an 8-hour trip cover the 16-fish family plan, plus random catches",
      "Bought-fish meal profit is intentional timed production; direct buy-and-deliver orders lose coins; cooking slots, stock, delivery cooldowns and board rotation bound turnover"],
    timers: { slots: orders.slots, refreshHours: orders.refreshSeconds / 3600, replacementMinutes: orders.replacementSeconds / 60, completionMinutes: orders.completionSeconds / 60 },
    meals, recipes, templates, boardScenarios, supplyPlans: plans };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
  console.log(JSON.stringify(auditFoodEconomy(catalog), null, 2));
}
