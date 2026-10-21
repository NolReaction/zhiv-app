import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { economicMath, recipeBuildingLevel } from "./lib/economy-math.mjs";
import { auditEconomyProgression } from "./audit-economy-progression.mjs";

const rounded = value => Number(value.toFixed(3));
const sum = values => values.reduce((total, value) => total + value, 0);
const add = (target, source, multiplier = 1) => { if (!multiplier) return target; for (const [id, count] of Object.entries(source)) target[id] = (target[id] ?? 0) + count * multiplier; return target; };
const signature = quantities => JSON.stringify(Object.entries(quantities).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const valueOf = (items, quantities) => sum(Object.entries(quantities).map(([id, count]) => items.get(id).baseSellPrice * count));
const duration = (seconds, bps) => Math.ceil(seconds * 10000 / (10000 + bps));

/** Exact arithmetic in current visible coins. Board selection itself is tested
 * through the production helper: there is no second copy of its rotation here. */
export function auditFoodEconomy(catalog) {
  const food = catalog.food, math = economicMath(catalog), scale = catalog.currencyScale;
  assert(food?.meals.length >= 6, "The six-tier meal catalog is required");
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const fish = new Map([...catalog.fishing.fish, ...catalog.fishing.classes].map(item => [item.itemId, item]));
  const fishOptions = recipe => recipe?.fishInput?.itemIds ?? Object.keys(recipe?.cost.items ?? {}).filter(id => fish.has(id));
  const mealIds = new Set(food.meals.map(meal => meal.itemId));
  assert.equal(mealIds.size, food.meals.length, "Duplicate meal");
  const positiveInt = value => Number.isSafeInteger(value) && value > 0;
  const orders = food.orders;
  assert.equal(orders.slots, 3);
  for (const key of ["refreshSeconds", "replacementWindowSeconds", "freeReplacements", "replacementPricePearls", "recentLimit"])
    assert(positiveInt(orders[key]), `Invalid ${key}`);
  for (const key of ["replacementSeconds", "completionSeconds"]) assert.equal(orders[key], 0, "Completed and replaced orders have no cooldown");
  assert.equal(new Set(orders.templates.map(order => order.id)).size, orders.templates.length, "Duplicate order template");
  assert.equal(new Set(orders.templates.map(order => signature(order.items))).size, orders.templates.length, "Duplicate order composition");
  const shopPrice = id => Math.ceil(fish.get(id).buyPrice * catalog.fishing.shop.fishPriceBps / 10000);
  const defaultProducer = id => catalog.recipes.find(recipe => recipe.rewards[id] > 0 && Object.keys(recipe.rewards).length === 1);
  const hasRequirements = (definition, buildings) => (buildings.home ?? 1) >= definition.requiredHomeLevel
    && Object.entries(definition.requiredBuildings ?? {}).every(([id, level]) => (buildings[id] ?? 0) >= level)
    && (!definition.buildingId || (buildings[definition.buildingId] ?? 0) >= recipeBuildingLevel(definition));
  // Independent fixed-point audit of prerequisites, including ingredient chains.
  const obtainable = buildings => {
    const reachable = new Set(), completedRecipes = new Set(); let changed = true;
    while (changed) {
      const before = reachable.size + completedRecipes.size;
      for (const source of [...catalog.explorations, ...catalog.recipes]) {
        if (!hasRequirements(source, buildings)) continue;
        if (Object.keys(source.requiredRecipes ?? {}).some(id => !completedRecipes.has(id))) continue;
        const options = source.fishInput?.itemIds;
        if (Object.keys(source.cost.items).some(id => !reachable.has(id) && !options?.includes(id)) || options && !options.some(id => reachable.has(id))) continue;
        for (const [id, count] of Object.entries(source.rewards)) if (count > 0) reachable.add(id);
        if (source.buildingId) completedRecipes.add(source.id);
        if (catalog.fishing.routeIds.includes(source.id)) for (const spec of catalog.fishing.classes) {
          const rods = catalog.fishing.rods.filter(rod => rod.requiredHomeLevel <= buildings.home && (spec.rarity !== "legendary" || rod.rarity === "legendary")
            && (!rod.classOddsBps || rod.classOddsBps[spec.rarity] > 0));
          const hooks = catalog.fishing.hooks.filter(hook => hook.requiredHomeLevel <= buildings.home);
          if (rods.length && hooks.length) reachable.add(spec.itemId);
        }
      }
      changed = before !== reachable.size + completedRecipes.size;
    }
    return reachable;
  };
  const progression = orders.progression;
  assert(progression, "Order progression must be configured");
  for (const [key, ceiling] of [["rawBpsByHome", 50000], ["fishBpsByHome", 20000], ["craftedBpsByHome", 15000]]) {
    const values = progression[key];
    assert(values?.length === 5 && values[0] === 10000 && values.every((value, index) => positiveInt(value)
      && value <= ceiling && (!index || value >= values[index - 1])), `Invalid ${key} progression`);
  }
  const progressedOrder = (order, home) => {
    const quantities = Object.fromEntries(Object.entries(order.items).map(([id, count]) => {
      const category = items.get(id).category;
      const bps = fish.has(id) ? progression.fishBpsByHome[home - 1]
        : ["crafted", "provisions"].includes(category) ? progression.craftedBpsByHome[home - 1] : progression.rawBpsByHome[home - 1];
      return [id, Number(BigInt(count) * BigInt(bps) / 10000n)];
    }));
    const baseValue = BigInt(valueOf(items, order.items)), scaledValue = BigInt(valueOf(items, quantities));
    const coins = Number((BigInt(order.coins) * scaledValue + baseValue * 10n - 1n) / (baseValue * 10n) * 10n);
    assert(coins <= Number(scaledValue) * 2, `${order.id}@${home}: excessive scaled order premium`);
    const slotMinutes = {};
    for (const [id, count] of Object.entries(quantities)) add(slotMinutes, math.profile(id).slotMinutes, count);
    return { homeLevel: home, items: quantities, rewardCoins: coins,
      itemReferenceCoins: Number(scaledValue), directSaleCoins: math.liquidation(quantities),
      inputSourceSlotMinutes: Object.fromEntries(Object.entries(slotMinutes).map(([id, minutes]) => [id, rounded(minutes)])) };
  };
  const fishRecipes = catalog.recipes.filter(recipe => fishOptions(recipe).length);
  const recipes = fishRecipes.map(recipe => {
    const options = fishOptions(recipe), original = Object.keys(recipe.cost.items).filter(id => options.includes(id));
    assert.equal(original.length, 1, `${recipe.id}: exactly one fish placeholder is required`);
    assert.equal(new Set(options).size, options.length, `${recipe.id}: duplicate fish option`);
    assert(options.every(id => fish.has(id)), `${recipe.id}: unknown fish option`);
    const quantity = recipe.cost.items[original[0]], revenue = math.liquidation(recipe.rewards);
    const variants = options.map(id => {
      const cost = { ...recipe.cost.items }; delete cost[original[0]]; cost[id] = quantity;
      const opportunity = math.liquidation(cost) + recipe.cost.coins;
      assert(revenue > opportunity, `${recipe.id}@${id}: cooking destroys actual sale proceeds`);
      const nonFish = { ...cost }; delete nonFish[id];
      const purchaseCost = fish.get(id).rarity === "common" ? shopPrice(id) * quantity + math.liquidation(nonFish) + recipe.cost.coins : null;
      const batch = recipe.maxBatch ?? 1;
      const batchCost = Object.fromEntries(Object.entries(cost).map(([item, count]) => [item, count * batch]));
      const batchOutput = Object.fromEntries(Object.entries(recipe.rewards).map(([item, count]) => [item, count * batch]));
      const batchProfit = math.liquidation(batchOutput) - math.liquidation(batchCost) - recipe.cost.coins * batch;
      assert(batchProfit > 0, `${recipe.id}@${id}: full batch destroys actual sale proceeds`);
      return { fishItemId: id, quantity, inputReferenceCoins: valueOf(items, cost) + recipe.cost.coins,
        inputSaleOpportunityCoins: opportunity, saleProfitCoins: revenue - opportunity,
        saleProfitPerStationHour: rounded((revenue - opportunity) * 3600 / recipe.seconds),
        discountedFishUnitPrice: fish.get(id).rarity === "common" ? shopPrice(id) : null,
        shopFishAndOtherInputsSaleOpportunityCoins: purchaseCost,
        shopFishCookingSaleProfitCoins: purchaseCost === null ? null : revenue - purchaseCost,
        fullBatchSaleProfitCoins: batchProfit };
    });
    return { recipeId: recipe.id, homeLevel: recipe.requiredHomeLevel, stationLevel: recipeBuildingLevel(recipe),
      minutes: recipe.seconds / 60, output: recipe.rewards, maxBatch: recipe.maxBatch,
      singleSlotBatchesPerDay: rounded(86400 / recipe.seconds), outputSaleCoins: revenue, variants,
      defaultInputSourceSlotMinutes: Object.fromEntries(Object.entries(math.batch(recipe).slotMinutes).map(([id, minutes]) => [id, rounded(minutes)])) };
  });
  const loadouts = catalog.fishing.rods.flatMap(rod => catalog.fishing.hooks.flatMap(hook => [null, ...catalog.fishing.baits.map(bait => bait.itemId)]
    .map(baitId => ({ rodId: rod.id, hookId: hook.id, baitId }))));
  const referenceCatch = math.catchPortfolio(), referenceRoute = catalog.explorations.find(route => route.id === "shore");
  const referenceFishingCoinsPerHour = (referenceCatch.expectedFishRevenue - referenceCatch.routeCoins
    - referenceCatch.baitPurchaseCoins - math.liquidation(referenceCatch.routeInputs)) * 3600 / referenceRoute.seconds;
  const fishMeals = food.meals.filter(meal => fishOptions(defaultProducer(meal.itemId)).length);
  for (const [index, meal] of fishMeals.entries()) if (index) for (const consumer of ["hero", "builder"])
    assert(meal[`${consumer}SpeedBps`] > fishMeals[index - 1][`${consumer}SpeedBps`], "Fish meal tiers must improve both consumers");
  const meals = food.meals.map(meal => {
    assert(items.has(meal.itemId), `Unknown meal ${meal.itemId}`);
    for (const consumer of ["hero", "builder"]) {
      const bonus = meal[`${consumer}SpeedBps`];
      assert(Number.isInteger(bonus) && bonus > 0 && bonus <= 10000, `Unbounded ${consumer} meal bonus`);
    }
    const producer = defaultProducer(meal.itemId); assert(producer, `${meal.itemId}: no food recipe`);
    const mealValue = math.liquidation({ [meal.itemId]: 1 });
    const fishingReturn = catalog.fishing.routeIds.map(routeId => {
      const route = catalog.explorations.find(route => route.id === routeId);
      const cases = loadouts.map(loadout => {
        const caught = math.catchPortfolio(loadout.rodId, loadout.baitId, routeId, loadout.hookId);
        const net = caught.expectedFishRevenue - caught.routeCoins - caught.baitPurchaseCoins - math.liquidation(caught.routeInputs);
        const fedSeconds = duration(route.seconds, meal.heroSpeedBps);
        return { ...loadout, withoutFoodNetCoinsPerHour: rounded(net * 3600 / route.seconds),
          withFoodNetCoinsPerHour: rounded((net - mealValue) * 3600 / fedSeconds),
          fishNetCoinsPerJob: rounded(net), dishOpportunityCoins: mealValue, fedSeconds,
          compatibleFishExpectedPerJob: rounded(sum(fishOptions(producer).map(id => caught.output[id] ?? 0))) };
      });
      const best = cases.reduce((a, b) => a.withFoodNetCoinsPerHour >= b.withFoodNetCoinsPerHour ? a : b);
      return { routeId, starter: cases.find(row => row.rodId === "reed_rod" && row.hookId === "bare_hook" && row.baitId === null), best };
    });
    return { itemId: meal.itemId, heroSpeedPercent: meal.heroSpeedBps / 100, builderSpeedPercent: meal.builderSpeedBps / 100,
      mealSaleOpportunityCoins: mealValue, preparationMinutes: producer.seconds / 60,
      minimumBaseTripHoursForSavedTimeToMatchMealSaleValue: rounded(mealValue / referenceFishingCoinsPerHour * (10000 + meal.heroSpeedBps) / meal.heroSpeedBps),
      eightHourHeroTripSeconds: duration(28800, meal.heroSpeedBps), eightHourHeroMinutesSaved: rounded((28800 - duration(28800, meal.heroSpeedBps)) / 60),
      twentyFourHourBuildSeconds: duration(86400, meal.builderSpeedBps), twentyFourHourBuildMinutesSaved: rounded((86400 - duration(86400, meal.builderSpeedBps)) / 60),
      sevenDayBuildSeconds: duration(604800, meal.builderSpeedBps), fishingReturn };
  });
  const templates = orders.templates.map(order => {
    assert(["plesk", "builder"].includes(order.residentId), `${order.id}: unknown resident`);
    assert(positiveInt(order.coins) && order.coins % scale === 0, `${order.id}: invalid coin reward`);
    assert(Object.keys(order.items).length > 0, `${order.id}: empty order`);
    const guaranteedBuildings = { home: order.requiredHomeLevel, garden: 1, warehouse: 1, ...order.requiredBuildings };
    const reachable = obtainable(guaranteedBuildings);
    for (const [id, count] of Object.entries(order.items)) {
      assert(items.has(id) && positiveInt(count), `${order.id}: invalid ingredient`);
      assert(math.sourceHome(id) <= order.requiredHomeLevel, `${order.id}: home gate cannot source ${id}`);
      assert(reachable.has(id), `${order.id}: unavailable production chain for ${id}`);
      const directSources = [...catalog.recipes, ...catalog.explorations].filter(source => source.rewards[id] > 0);
      if (!fish.has(id)) assert(directSources.some(source => hasRequirements(source, guaranteedBuildings)),
        `${order.id}: unavailable production for ${id}`);
    }
    const referenceValue = valueOf(items, order.items), saleValue = math.liquidation(order.items);
    assert(order.coins > referenceValue, `${order.id}: orders must reward more than full reference item value`);
    assert(order.coins <= referenceValue * 2, `${order.id}: excessive order premium`);
    const allPurchasable = Object.keys(order.items).every(id => fish.get(id)?.rarity === "common");
    const directBuyCost = allPurchasable ? sum(Object.entries(order.items).map(([id, count]) => shopPrice(id) * count)) : null;
    return { id: order.id, residentId: order.residentId, homeLevel: order.requiredHomeLevel, items: order.items, rewardCoins: order.coins,
      itemReferenceCoins: referenceValue, basePremiumPercent: rounded((order.coins / referenceValue - 1) * 100),
      directSaleCoins: saleValue, extraOverDirectSaleCoins: order.coins - saleValue,
      actualDiscountedPurchaseCoins: directBuyCost, boughtFishOrderProfitCoins: directBuyCost === null ? null : order.coins - directBuyCost,
      byHome: Array.from({ length: 6 - order.requiredHomeLevel }, (_, index) => progressedOrder(order, index + order.requiredHomeLevel)) };
  });
  const earlyOrders = orders.templates.filter(order => hasRequirements(order, { home: 1, garden: 1, warehouse: 1 }));
  const tutorials = catalog.onboarding?.residentOrders ?? [];
  assert.equal(tutorials.length, 1, "The tutorial teaches one request");
  assert.deepEqual(tutorials[0].items, { berries: 1 }, "A single ripe raspberry must finish the teaching request");
  assert.equal(tutorials[0].coins, 15, "The teaching request pays 1.5 times its NPC value");
  const firstCourse = catalog.stageOrders?.find(stage => stage.homeLevel === 1);
  assert.equal(firstCourse?.orders.length, 3, "The first house needs three small permanent requests");
  assert.equal(firstCourse.intervalSeconds, 0, "Beginner requests never wait behind a daily gate");
  assert.equal(sum([...tutorials, ...firstCourse.orders].map(order => order.coins)), 315, "The first stage must keep its 35-coin surplus");
  const secondCourse = catalog.stageOrders?.find(stage => stage.homeLevel === 2);
  assert.equal(secondCourse?.orders.length, 7, "Second stage needs seven guaranteed permanent requests");
  assert.equal(sum(secondCourse.orders.map(order => order.coins)), 1990, "Second-stage requests must pay 1990 coins");
  for (const order of secondCourse.orders)
    assert.equal(order.coins, Math.ceil(math.liquidation(order.items) * 1.5 / scale) * scale,
      `${order.id}: permanent requests must pay 150% of actual NPC value rounded up to the coin quantum`);
  const thirdCourse = catalog.stageOrders?.find(stage => stage.homeLevel === 3);
  assert.equal(thirdCourse?.orders.length, 8, "Third stage needs eight guaranteed permanent requests");
  assert.equal(thirdCourse.intervalSeconds, 23 * 3600, "Each next third-stage request waits 23 hours after its actual prior delivery");
  assert.deepEqual(thirdCourse.completionRewards, { living_resin: 1 }, "The course guarantees the house's required resin");
  assert.equal(sum(thirdCourse.orders.map(order => order.coins)), 14840, "Third-stage requests must pay 14840 coins");
  for (const order of thirdCourse.orders)
    assert.equal(order.coins, Math.ceil(math.liquidation(order.items) * 1.5 / scale) * scale,
      `${order.id}: third-stage requests keep the exact rounded 150% premium`);
  assert(earlyOrders.length >= 5, "Starter board needs at least five eligible distinct templates alongside the tutorial requests");
  for (const resident of ["plesk", "builder"]) assert(earlyOrders.some(order => order.residentId === resident), "Both starter residents need an eligible request");
  const secondStageOrders = orders.templates.filter(order => hasRequirements(order, { home: 2, garden: 1, warehouse: 1 }));
  assert(secondStageOrders.length >= 10, "Second-stage board needs at least ten eligible distinct templates");
  for (const resident of ["plesk", "builder"]) assert(secondStageOrders.filter(order => order.residentId === resident).length >= 4, "Each second-stage resident needs variety");

  // Exhaustive finite unbounded-knapsack over <=6 purchased fish. Other goods are
  // explicitly owned inputs valued as one aggregate sale; no per-unit rounding.
  // Matching offers/history are relaxed, so this is a ceiling, not a promised run.
  const shopDeliveryBudgets = catalog.fishing.classes.filter(spec => spec.rarity === "common").map(spec => {
    const unitPrice = shopPrice(spec.itemId), stock = catalog.fishing.shop.fishStock;
    assert(unitPrice > items.get(spec.itemId).baseSellPrice, `${spec.itemId}: instant NPC buy-sell arbitrage`);
    const candidates = orders.templates.flatMap(order => {
      let quantity = 0, minutes = 0, coins = 0; const others = {};
      for (const [id, count] of Object.entries(order.items)) {
        if (id === spec.itemId) { quantity += count; continue; }
        const recipe = defaultProducer(id);
        if (recipe && fishOptions(recipe).includes(spec.itemId)) {
          const placeholder = fishOptions(recipe).find(id => recipe.cost.items[id] > 0), batches = count / recipe.rewards[id];
          quantity += recipe.cost.items[placeholder] * batches;
          minutes += recipe.seconds / 60 * batches; coins += recipe.cost.coins * batches;
          add(others, Object.fromEntries(Object.entries(recipe.cost.items).filter(([id]) => id !== placeholder)), batches);
        } else others[id] = (others[id] ?? 0) + count;
      }
      return quantity > 0 && quantity <= stock ? [{ id: order.id, quantity, minutes, coins, others, reward: order.coins }] : [];
    });
    const optimize = choices => {
      let best = { orderCounts: {}, purchasedFish: 0, otherOwnedInputs: {}, productionMinutes: 0, rewardCoins: 0,
        purchaseCoins: 0, productionCoinCost: 0, otherOwnedInputsSaleCoins: 0, netCoins: 0 };
      function visit(index, quantity, others, minutes, reward, coins, counts) {
        if (index === choices.length) {
          const otherValue = math.liquidation(others), net = reward - quantity * unitPrice - otherValue - coins;
          if (net > best.netCoins) best = { orderCounts: { ...counts }, purchasedFish: quantity, otherOwnedInputs: { ...others }, productionMinutes: minutes,
            rewardCoins: reward, purchaseCoins: quantity * unitPrice, productionCoinCost: coins, otherOwnedInputsSaleCoins: otherValue, netCoins: net };
          return;
        }
        const option = choices[index];
        for (let count = 0; quantity + count * option.quantity <= stock; count++) {
          const nextCounts = { ...counts }; if (count) nextCounts[option.id] = count;
          visit(index + 1, quantity + count * option.quantity, add({ ...others }, option.others, count), minutes + option.minutes * count,
            reward + option.reward * count, coins + option.coins * count, nextCounts);
        }
      }
      visit(0, 0, {}, 0, 0, 0, {}); return best;
    };
    const rawOnly = optimize(candidates.filter(row => row.minutes === 0 && Object.keys(row.others).length === 0));
    const ordinaryMaterials = optimize(candidates.filter(row => Object.keys(row.others).every(id => !fish.has(id) && items.get(id).category !== "provisions")));
    const fromIngredients = candidates.map(candidate => {
      const expanded = { ...candidate, others: {} };
      function expand(id, count) {
        const recipe = items.get(id).category === "provisions" ? defaultProducer(id) : null;
        if (!recipe) { expanded.others[id] = (expanded.others[id] ?? 0) + count; return; }
        const batches = count / recipe.rewards[id]; expanded.minutes += recipe.seconds / 60 * batches; expanded.coins += recipe.cost.coins * batches;
        for (const [input, quantity] of Object.entries(recipe.cost.items)) expand(input, quantity * batches);
      }
      for (const [id, count] of Object.entries(candidate.others)) expand(id, count);
      return expanded;
    });
    return { fishItemId: spec.itemId, nominalUnitPrice: spec.buyPrice, actualUnitPrice: unitPrice,
      buybackUnitPrice: items.get(spec.itemId).baseSellPrice, stock, directResaleProfitForFullStock: stock * (items.get(spec.itemId).baseSellPrice - unitPrice),
      matchingPureFishOrdersCeiling: rawOnly, matchingOrdersWithOtherOwnedInputsCeiling: optimize(candidates),
      matchingCookedOrdersWithOrdinaryMaterialsCeiling: ordinaryMaterials,
      matchingOrdersWithAdditionalRawIngredientsCeiling: optimize(fromIngredients),
      steadyNaturalDeliveriesPerDay: 86400 / catalog.fishing.shop.refreshSeconds,
      pureFishOrderSteadyNaturalDailyCeiling: rawOnly.netCoins * 86400 / catalog.fishing.shop.refreshSeconds };
  });

  // This is one feasible topological build ordering with stocked ingredients and
  // meals from ALREADY opened kitchens, not a promise of elapsed player progress.
  const buildProgression = auditEconomyProgression(catalog), levels = { home: 1, garden: 1, warehouse: 1 }, fedCounts = {};
  let baseBuildSeconds = 0, stockedFoodBuildSeconds = 0, mealPreparationMinutes = 0;
  for (const key of buildProgression.constructionOrder) {
    const [id, levelText] = key.split(":"), level = Number(levelText);
    if (level > 5) continue;
    const target = catalog.buildings.find(building => building.id === id).levels.find(row => row.level === level);
    if (level <= (levels[id] ?? 0)) continue;
    const possible = food.meals.filter(meal => hasRequirements(defaultProducer(meal.itemId), levels));
    const meal = possible.toSorted((a, b) => b.builderSpeedBps - a.builderSpeedBps)[0];
    baseBuildSeconds += target.seconds; stockedFoodBuildSeconds += duration(target.seconds, meal?.builderSpeedBps ?? 0);
    if (meal) { fedCounts[meal.itemId] = (fedCounts[meal.itemId] ?? 0) + 1; mealPreparationMinutes += defaultProducer(meal.itemId).seconds / 60; }
    levels[id] = level;
  }
  return { catalogVersion: catalog.version, currency: "visible coins, identical to catalog integer amounts; currencyScale is a historical denomination marker",
    assumptions: ["Fish use full Pleska buyback price; every current tradable good has an exact configured NPC price; the fallback for an unconfigured legacy item rounds its aggregate stack down to a multiple of 10 coins",
      "Actual merchant purchase is ceil(buyPrice*fishPriceBps/10000), not nominal buyPrice; only common class stock is sold",
      "Direct purchase-resale and pure raw-fish buy-to-order turnover lose money; cooking value requires real time and ingredients",
      "Four natural deliveries per steady day is not a strict rolling-day cap; old stock may straddle the interval, and paid merchant refresh restocks the common class offer",
      "Order template/shop ceilings below are base-quantity comparisons; templates.byHome reports issued scaled quantities and corresponding rewards",
      "Production input-source minutes include independent station occupancy and expected fish acquisition; they are not a wall-clock guarantee",
      "Order payouts, including home scaling and rounding, remain at or below twice full reference value; low-price player trades remain bounded by existing trade limits",
      "There is no hourly board earnings cap or completed-card cooldown. Every reward consumes actual inventory; order replacements never restock the merchant",
      "Delivery optimizations relax offer availability and repeat-history restrictions; auxiliary goods must already exist and their aggregate sale value is deducted",
      "Food speed bonuses divide duration and do not stack; meal opportunity is its ordinary sale price, not a free ingredient",
      "Fishing meal ROI uses expected catches and paid bait, excludes gear acquisition/stock waits and meal preparation time; ingredients and rare catches are not guaranteed",
      "Construction projection assumes stocked meals and build inputs in one topological order; it excludes gathering, rarity, claim waits and cooking elapsed time"],
    boardPolicy: { slots: orders.slots, refreshHours: orders.refreshSeconds / 3600, freeReplacements: orders.freeReplacements,
      replacementWindowHours: orders.replacementWindowSeconds / 3600, paidReplacementStoredPearls: orders.replacementPricePearls,
      recentLimit: orders.recentLimit, progression, starterTemplates: earlyOrders.length, tutorialTemplates: tutorials.length,
      secondStageTemplates: secondStageOrders.length, completionCooldownSeconds: 0 },
    meals, recipes, templates, shopDeliveryBudgets,
    construction: { baseBuildSeconds, stockedFoodBuildSeconds, savedPercent: rounded((1 - stockedFoodBuildSeconds / baseBuildSeconds) * 100),
      mealCounts: fedCounts, mealPreparationMinutes, absoluteAllLegendaryTheoreticalSeconds: duration(baseBuildSeconds, Math.max(...food.meals.map(meal => meal.builderSpeedBps))) } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
  console.log(JSON.stringify(auditFoodEconomy(catalog), null, 2));
}
