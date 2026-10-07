import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { economicMath } from "./lib/economy-math.mjs";
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
  const fish = new Map(catalog.fishing.fish.map(item => [item.itemId, item]));
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
    && (!definition.buildingId || (buildings[definition.buildingId] ?? 0) >= definition.buildingLevel);
  const fishRecipes = catalog.recipes.filter(recipe => recipe.fishInput);
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
    return { recipeId: recipe.id, homeLevel: recipe.requiredHomeLevel, stationLevel: recipe.buildingLevel,
      minutes: recipe.seconds / 60, output: recipe.rewards, maxBatch: recipe.maxBatch,
      singleSlotBatchesPerDay: rounded(86400 / recipe.seconds), outputSaleCoins: revenue, variants,
      defaultInputSourceSlotMinutes: Object.fromEntries(Object.entries(math.batch(recipe).slotMinutes).map(([id, minutes]) => [id, rounded(minutes)])) };
  });
  const loadouts = catalog.fishing.rods.flatMap(rod => catalog.fishing.hooks.flatMap(hook => [null, ...catalog.fishing.baits.map(bait => bait.itemId)]
    .map(baitId => ({ rodId: rod.id, hookId: hook.id, baitId }))));
  const referenceCatch = math.catchPortfolio(), referenceRoute = catalog.explorations.find(route => route.id === "shore");
  const referenceFishingCoinsPerHour = (referenceCatch.expectedFishRevenue - referenceCatch.routeCoins
    - referenceCatch.baitPurchaseCoins - math.liquidation(referenceCatch.routeInputs)) * 3600 / referenceRoute.seconds;
  const meals = food.meals.map((meal, index) => {
    assert(items.has(meal.itemId), `Unknown meal ${meal.itemId}`);
    for (const consumer of ["hero", "builder"]) {
      const bonus = meal[`${consumer}SpeedBps`];
      assert(Number.isInteger(bonus) && bonus > 0 && bonus <= 10000, `Unbounded ${consumer} meal bonus`);
      if (index) assert(bonus > food.meals[index - 1][`${consumer}SpeedBps`], "Meal tiers must improve both consumers");
    }
    const producer = defaultProducer(meal.itemId); assert(producer?.fishInput, `${meal.itemId}: no fish recipe`);
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
          compatibleFishExpectedPerJob: rounded(sum(producer.fishInput.itemIds.map(id => caught.output[id] ?? 0))) };
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
    for (const [id, count] of Object.entries(order.items)) {
      assert(items.has(id) && positiveInt(count), `${order.id}: invalid ingredient`);
      assert(math.sourceHome(id) <= order.requiredHomeLevel, `${order.id}: home gate cannot source ${id}`);
      const directSources = [...catalog.recipes, ...catalog.explorations].filter(source => source.rewards[id] > 0);
      if (!fish.has(id)) assert(directSources.some(source => hasRequirements(source, guaranteedBuildings)),
        `${order.id}: unavailable production for ${id}`);
    }
    const referenceValue = valueOf(items, order.items), saleValue = math.liquidation(order.items);
    assert(order.coins > referenceValue, `${order.id}: orders must reward more than full reference item value`);
    assert(order.coins <= Math.ceil(referenceValue * 1.4 / 10) * 10, `${order.id}: excessive order premium`);
    const allPurchasable = Object.keys(order.items).every(id => fish.get(id)?.rarity === "common");
    const directBuyCost = allPurchasable ? sum(Object.entries(order.items).map(([id, count]) => shopPrice(id) * count)) : null;
    return { id: order.id, residentId: order.residentId, homeLevel: order.requiredHomeLevel, items: order.items, rewardCoins: order.coins,
      itemReferenceCoins: referenceValue, basePremiumPercent: rounded((order.coins / referenceValue - 1) * 100),
      directSaleCoins: saleValue, extraOverDirectSaleCoins: order.coins - saleValue,
      actualDiscountedPurchaseCoins: directBuyCost, boughtFishOrderProfitCoins: directBuyCost === null ? null : order.coins - directBuyCost };
  });
  const earlyOrders = orders.templates.filter(order => hasRequirements(order, { home: 1, garden: 1, warehouse: 1 }));
  assert(earlyOrders.length >= 10, "Starter board needs at least ten eligible distinct templates");
  for (const resident of ["plesk", "builder"]) assert(earlyOrders.filter(order => order.residentId === resident).length >= 4, "Each starter resident needs variety");

  // Exhaustive finite unbounded-knapsack over <=6 purchased fish. Other goods are
  // explicitly owned inputs valued as one aggregate sale; no per-unit rounding.
  // Matching offers/history are relaxed, so this is a ceiling, not a promised run.
  const shopDeliveryBudgets = catalog.fishing.fish.filter(spec => spec.rarity === "common").map(spec => {
    const unitPrice = shopPrice(spec.itemId), stock = catalog.fishing.shop.fishStock;
    assert(unitPrice > items.get(spec.itemId).baseSellPrice, `${spec.itemId}: instant NPC buy-sell arbitrage`);
    const candidates = orders.templates.flatMap(order => {
      let quantity = 0, minutes = 0, coins = 0; const others = {};
      for (const [id, count] of Object.entries(order.items)) {
        if (id === spec.itemId) { quantity += count; continue; }
        const recipe = defaultProducer(id);
        if (recipe?.fishInput?.itemIds.includes(spec.itemId)) {
          const placeholder = recipe.fishInput.itemIds.find(id => recipe.cost.items[id] > 0), batches = count / recipe.rewards[id];
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
  const progression = auditEconomyProgression(catalog), levels = { home: 1, garden: 1, warehouse: 1 }, fedCounts = {};
  let baseBuildSeconds = 0, stockedFoodBuildSeconds = 0, mealPreparationMinutes = 0;
  for (const key of progression.constructionOrder) {
    const [id, levelText] = key.split(":"), level = Number(levelText);
    if (level > 5) continue;
    const target = catalog.buildings.find(building => building.id === id).levels.find(row => row.level === level);
    if (level <= (levels[id] ?? 0)) continue;
    const possible = food.meals.filter(meal => hasRequirements(defaultProducer(meal.itemId), levels));
    const meal = possible.at(-1);
    baseBuildSeconds += target.seconds; stockedFoodBuildSeconds += duration(target.seconds, meal?.builderSpeedBps ?? 0);
    if (meal) { fedCounts[meal.itemId] = (fedCounts[meal.itemId] ?? 0) + 1; mealPreparationMinutes += defaultProducer(meal.itemId).seconds / 60; }
    levels[id] = level;
  }
  return { catalogVersion: catalog.version, currency: "visible coins, identical to catalog integer amounts; currencyScale is a historical denomination marker",
    assumptions: ["Fish use full Pleska buyback price; local sales round each aggregate item stack down to a multiple of 10 coins",
      "Actual merchant purchase is ceil(buyPrice*fishPriceBps/10000), not nominal buyPrice; only common species are stocked",
      "Direct purchase-resale loses money; positive buy-to-order turnover is intentional and limited by six fish per delivery, stock, other goods and manual confirmed orders",
      "Four natural deliveries per steady day is not a strict rolling-day cap; old stock may straddle the interval, and paid merchant refresh buys more stock with pearls",
      "There is no hourly board earnings cap or completed-card cooldown. Every reward consumes actual inventory; order replacements never restock the merchant",
      "Delivery optimizations relax offer availability and repeat-history restrictions; auxiliary goods must already exist and their aggregate sale value is deducted",
      "Food speed bonuses divide duration and do not stack; meal opportunity is its ordinary sale price, not a free ingredient",
      "Fishing meal ROI uses expected catches and paid bait, excludes gear acquisition/stock waits and meal preparation time; ingredients and rare catches are not guaranteed",
      "Construction projection assumes stocked meals and build inputs in one topological order; it excludes gathering, rarity, claim waits and cooking elapsed time"],
    boardPolicy: { slots: orders.slots, refreshHours: orders.refreshSeconds / 3600, freeReplacements: orders.freeReplacements,
      replacementWindowHours: orders.replacementWindowSeconds / 3600, paidReplacementStoredPearls: orders.replacementPricePearls,
      recentLimit: orders.recentLimit, starterTemplates: earlyOrders.length, completionCooldownSeconds: 0 },
    meals, recipes, templates, shopDeliveryBudgets,
    construction: { baseBuildSeconds, stockedFoodBuildSeconds, savedPercent: rounded((1 - stockedFoodBuildSeconds / baseBuildSeconds) * 100),
      mealCounts: fedCounts, mealPreparationMinutes, absoluteAllLegendaryTheoreticalSeconds: duration(baseBuildSeconds, food.meals.at(-1).builderSpeedBps) } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
  console.log(JSON.stringify(auditFoodEconomy(catalog), null, 2));
}
