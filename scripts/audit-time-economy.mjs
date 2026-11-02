import assert from "node:assert/strict";
import { explorationLootSummary } from "./lib/exploration-loot.mjs";
import { auditConstructionEconomy } from "./lib/construction-economy.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { auditBuildingUnlocks } from "./lib/economy-balance.mjs";

const sum = values => values.reduce((total, value) => total + value, 0);
const add = (target, source, multiplier = 1) => {
  for (const [id, quantity] of Object.entries(source)) target[id] = (target[id] ?? 0) + quantity * multiplier;
};

/** Independent valuation audit: it deliberately does not call the repricer.
 * Reference work prices each operation once. Actor/room aliases are not extra work.
 */
export function auditTimeEconomy(catalog) {
  const policy = catalog.timeEconomy;
  assert(catalog.version >= 13 && policy?.version === 1, "Time economy v13 policy is required");
  assert.equal(policy.coinsPerMinute, 10, "The common production-minute rate must stay explicit");
  assert.equal(policy.orderBonusBps, 2500, "Order premium must be twenty-five percent");
  assert.equal(policy.constructionCoinsPerMinute, 10, "Builder minute rate must stay explicit");
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const recipes = new Map(catalog.recipes.map(source => [source.id, source]));
  const routes = new Map(catalog.explorations.map(source => [source.id, source]));
  const active = [...recipes.values(), ...routes.values()].filter(source => !source.retired);
  const values = new Map(), profiles = new Map();
  function profile(itemId, path = []) {
    if (profiles.has(itemId)) return profiles.get(itemId);
    assert(!path.includes(itemId), `Time-price ingredient cycle at ${[...path, itemId].join(" -> ")}`);
    const item = items.get(itemId);
    assert(item, `Unknown time-price item ${itemId}`);
    const recipeId = policy.baselineRecipes[itemId], routeId = policy.baselineExplorations[itemId];
    assert(!(recipeId && routeId), `${itemId}: reference technology must be unambiguous`);
    const source = recipeId ? recipes.get(recipeId) : routeId ? routes.get(routeId) : null;
    if (!source) {
      assert(!recipeId && !routeId, `${itemId}: declared reference source is missing`);
      assert(item.category === "special" || Object.hasOwn(policy.externalPrices, itemId), `${itemId}: price has no declared production or external reference`);
      const price = item.category === "special" ? 0 : policy.externalPrices[itemId];
      assert(Number.isSafeInteger(price) && price >= 0, `${itemId}: invalid external reference price`);
      const result = { itemId, sourceId: null, value: price, workSeconds: 0, starts: 0, stationSeconds: {},
        sourceStarts: {}, externalItems: { [itemId]: 1 }, depth: 0 };
      profiles.set(itemId, result); values.set(itemId, price); return result;
    }
    assert(!source.retired, `${itemId}: retired source cannot establish a current price`);
    assert.deepEqual(source.rewards, { [itemId]: 1 }, `${itemId}: reference must produce exactly one unit`);
    const station = source.buildingId ?? (source.activity === "mining" ? "miner" : "mochlik");
    const result = { itemId, sourceId: source.id, value: source.cost.coins + source.seconds * policy.coinsPerMinute / 60,
      workSeconds: source.seconds, starts: 1, stationSeconds: { [station]: source.seconds },
      sourceStarts: { [source.id]: 1 }, externalItems: {}, depth: 1 };
    for (const [input, quantity] of Object.entries(source.cost.items)) {
      const child = profile(input, [...path, itemId]);
      result.value += child.value * quantity; result.workSeconds += child.workSeconds * quantity;
      result.starts += child.starts * quantity; result.depth = Math.max(result.depth, child.depth + 1);
      add(result.stationSeconds, child.stationSeconds, quantity); add(result.sourceStarts, child.sourceStarts, quantity);
      add(result.externalItems, child.externalItems, quantity);
    }
    if (source.experiment) {
      const chance = source.experiment.successBps / 10000;
      assert(chance > 0 && chance < 1, `${itemId}: experiment needs a real, nonzero success chance`);
      const fallbackValue = sum(Object.entries(source.experiment.failureRewards).map(([id, quantity]) =>
        profile(id, [...path, itemId]).value * quantity));
      result.value = (result.value - (1 - chance) * fallbackValue) / chance;
      result.optionalExperiment = true; result.successBps = source.experiment.successBps;
      result.expectedAttempts = 1 / chance; result.finiteSuccessGuarantee = false;
      result.workSeconds /= chance; result.starts /= chance;
      for (const values of [result.stationSeconds, result.sourceStarts, result.externalItems])
        for (const id of Object.keys(values)) values[id] /= chance;
      result.expectedFailureRewards = Object.fromEntries(Object.entries(source.experiment.failureRewards)
        .map(([id, quantity]) => [id, quantity * (1 - chance) / chance]));
    }
    // Price is rounded once after inputs, own work and any expected fallback credit.
    result.value = Math.ceil(result.value);
    profiles.set(itemId, result); values.set(itemId, result.value); return result;
  }
  for (const item of items.values()) {
    const expected = profile(item.id).value;
    assert.equal(item.baseSellPrice, expected, `${item.id}: price must equal inputs plus its own reference time`);
    if (item.tradable) assert.equal(catalog.localBuyer.unitPrices[item.id], expected, `${item.id}: buyback must match the common base price`);
  }
  const value = quantities => sum(Object.entries(quantities).map(([id, count]) => {
    assert(items.has(id), `Unknown valued item ${id}`); return values.get(id) * count;
  }));
  const unitSources = active.filter(source => source.buildingId || source.activity === "mining");
  for (const source of unitSources) {
    assert.equal(sum(Object.values(source.rewards)), 1, `${source.id}: production/mining must yield one item`);
    assert(source.seconds > 0 && source.seconds <= 3600, `${source.id}: production/mining must take at most one hour`);
    if (source.buildingId) assert.equal(source.maxBatch, 1, `${source.id}: bulk production cannot be restarted`);
    assert(value(source.rewards) > value(source.cost.items) + source.cost.coins, `${source.id}: processing must add sale value`);
  }
  const experiments = [];
  const optionalItems = new Set(active.filter(source => source.experiment).flatMap(source => Object.keys(source.rewards)));
  for (const source of active.filter(source => source.experiment)) {
    const experiment = source.experiment, chance = experiment.successBps / 10000;
    assert.equal(experiment.successBps, 8500, `${source.id}: the baseline experiment chance must remain explicit`);
    assert(Number.isInteger(experiment.requiredCookingLevel) && experiment.requiredCookingLevel >= 1 && experiment.requiredCookingLevel <= 10,
      `${source.id}: invalid cooking level`);
    assert.equal(Object.keys(experiment.failureRewards).length, 0,
      `${source.id}: new failed experiments must consume ingredients without returning a serving`);
    const inputValue = value(source.cost.items) + source.cost.coins, workValue = source.seconds * policy.coinsPerMinute / 60;
    const successValue = value(source.rewards), failureValue = value(experiment.failureRewards);
    const expectedNet = chance * successValue + (1 - chance) * failureValue - inputValue;
    const masteredNet = .95 * successValue + .05 * failureValue - inputValue;
    assert(expectedNet + 1e-8 >= workValue && expectedNet < workValue + 1,
      `${source.id}: baseline expected output must compensate ingredients, work and failed attempts with only rounding surplus`);
    const totalCost = inputValue + workValue, masteredGross = masteredNet + inputValue;
    // With complete ingredient loss the skill saves inputs as well as cooking.
    // 95% / 85% raises gross output by 11.765%; rounding adds less than one coin.
    assert(masteredNet >= expectedNet && masteredGross <= totalCost * 1.12 + 1,
      `${source.id}: maximum cooking skill must stay within twelve percent of total ingredient-and-work value`);
    experiments.push({ recipeId: source.id, successBps: experiment.successBps, maximumSuccessBps: 9500,
      inputValue, workValue, totalCost, successValue, failureValue, expectedNet, masteredNet, masteredGross, optional: true });
  }
  const mandatoryBundles = [
    ...active.filter(source => !source.experiment).map(source => source.cost.items),
    ...catalog.buildings.flatMap(building => building.levels.map(level => level.cost.items)),
    ...catalog.food.orders.templates.map(order => order.items),
    ...catalog.stageOrders.flatMap(stage => stage.orders.map(order => order.items)),
    ...catalog.tradeRelations.weekly.templates.flatMap(template => template.stages.map(stage => stage.items)),
  ];
  assert(mandatoryBundles.every(bundle => Object.keys(bundle).every(id => !optionalItems.has(id))),
    "Optional experiments cannot block ordinary recipes, buildings or authored orders");
  const materialTrips = active.filter(source => !source.buildingId && source.activity !== "mining"
    && !catalog.fishing.routeIds.includes(source.id));
  const expeditionFinds = [];
  for (const source of materialTrips) {
    assert(source.seconds > 0 && source.seconds <= 3600, `${source.id}: material exploration must take at most one hour`);
    const { expectedRewards, maximumBaseCount } = explorationLootSummary(source);
    const expectedBaseNetCoins = value(expectedRewards) - value(source.cost.items) - source.cost.coins;
    assert.equal(expectedBaseNetCoins * 60,
      source.seconds * policy.coinsPerMinute, `${source.id}: hero material trip must earn only its own time value after inputs on average`);
    assert(maximumBaseCount + 1 <= 50, `${source.id}: full trip and one possible relic must fit initial storage`);
    if (source.finds) {
      const { emptyWeight, entries } = source.finds;
      assert(Number.isSafeInteger(emptyWeight) && emptyWeight >= 0 && entries.length > 0, `${source.id}: invalid find weights`);
      const totalWeight = emptyWeight + sum(entries.map(entry => entry.weight));
      for (const entry of entries) {
        assert(Number.isSafeInteger(entry.weight) && entry.weight > 0 && Number.isSafeInteger(entry.quantity) && entry.quantity > 0,
          `${source.id}: finds need positive integer weights and quantities`);
        assert(items.has(entry.itemId) && items.get(entry.itemId).tradable, `${source.id}: random bonus must be ordinary useful goods`);
        assert(maximumBaseCount + entry.quantity + 1 <= 50, `${source.id}: maximum find and relic must fit starter storage`);
      }
      const expectedBonusCoins = sum(entries.map(entry => value({ [entry.itemId]: entry.quantity }) * entry.weight / totalWeight));
      const guaranteedNetCoins = value(source.rewards) - value(source.cost.items) - source.cost.coins;
      assert(expectedBonusCoins >= expectedBaseNetCoins * .05 && expectedBonusCoins <= expectedBaseNetCoins * .15,
        `${source.id}: expected bonus must stay between five and fifteen percent of expected base work value`);
      expeditionFinds.push({ routeId: source.id, chance: 1 - emptyWeight / totalWeight, guaranteedNetCoins, expectedBaseNetCoins,
        expectedBonusCoins, expectedNetCoinsPerMinute: (expectedBaseNetCoins + expectedBonusCoins) * 60 / source.seconds });
    }
  }
  if (catalog.version >= 15) auditConstructionEconomy(catalog);
  else for (const building of catalog.buildings) for (const level of building.levels) {
    if (building.id === "warehouse" && level.level >= 4) continue; // Explicit relic-only optional capacity.
    assert.equal(level.cost.coins, Math.ceil(level.seconds * policy.constructionCoinsPerMinute / 60),
      `${building.id}:${level.level}: construction price must follow builder time`);
  }
  const orders = [...catalog.food.orders.templates, ...catalog.stageOrders.flatMap(stage => stage.orders),
    ...catalog.tradeRelations.weekly.templates.flatMap(template => template.stages)];
  for (const order of orders) assert.equal(order.coins, Math.ceil(value(order.items) * (10000 + policy.orderBonusBps) / 10000),
    `${order.id}: order must pay full item value plus its declared premium once`);
  const itemRows = [...items.values()].map(item => {
    const p = profile(item.id);
    const recipeUses = active.filter(source => source.buildingId && source.cost.items[item.id]).map(source => source.id);
    const ordinaryUses = catalog.food.orders.templates.filter(order => order.items[item.id]).map(order => order.id);
    const weeklyUses = catalog.tradeRelations.weekly.templates.flatMap(template => template.stages)
      .filter(stage => stage.items[item.id]).map(stage => stage.id);
    return { ...p, name: item.name, recipeUses, ordinaryUses, weeklyUses };
  });
  const nodes = new Map(catalog.buildings.flatMap(building => building.levels.map(level => [`${building.id}:${level.level}`, { buildingId: building.id, ...level }])));
  function closure(id, level, result = new Set(), path = []) {
    const key = `${id}:${level}`;
    assert(!path.includes(key), `Construction dependency cycle at ${key}`);
    if (result.has(key)) return result;
    const node = nodes.get(key); assert(node, `Unknown construction ${key}`);
    if (level > 1) closure(id, level - 1, result, [...path, key]);
    for (const [dependency, count] of Object.entries(node.requiredBuildings)) closure(dependency, count, result, [...path, key]);
    if (id !== "home") closure("home", node.requiredHomeLevel, result, [...path, key]);
    result.add(key); return result;
  }
  const chapters = [];
  for (let homeLevel = 1; homeLevel < 5; homeLevel++) {
    const prior = closure("home", homeLevel), next = closure("home", homeLevel + 1);
    const construction = [...next].filter(key => !prior.has(key)).map(key => nodes.get(key));
    const course = catalog.stageOrders.find(stage => stage.homeLevel === homeLevel);
    const materials = {}, stationSeconds = {}, sourceStarts = {}, externalItems = {};
    for (const entry of [...construction.map(level => level.cost.items), ...(course?.orders.map(order => order.items) ?? [])]) add(materials, entry);
    for (const [id, quantity] of Object.entries(materials)) {
      const p = profile(id);
      add(stationSeconds, p.stationSeconds, quantity); add(sourceStarts, p.sourceStarts, quantity); add(externalItems, p.externalItems, quantity);
    }
    const lowerBound = slots => Math.max(0, ...Object.entries(stationSeconds).map(([station, seconds]) => seconds / (["miner", "mochlik"].includes(station) ? 1 : slots)));
    const constructionCoins = sum(construction.map(level => level.cost.coins)), projectCoins = sum(course?.orders.map(order => order.coins) ?? []);
    chapters.push({ fromHome: homeLevel, toHome: homeLevel + 1, constructionCoins,
      constructionSeconds: sum(construction.map(level => level.seconds)), projectCoins,
      buildingFeesMinusProjectRewards: constructionCoins - projectCoins, materials, materialsBaseValue: value(materials),
      productionStarts: sum(Object.values(sourceStarts)), sourceStarts, stationSeconds, externalItems,
      projectGuaranteedItems: course?.completionRewards ?? {},
      productionCapacityLowerBoundSeconds: { oneSlot: lowerBound(1), threeSlots: lowerBound(3) },
      minimumProjectWaitSeconds: Math.max(0, (course?.orders.length ?? 0) - 1) * (course?.intervalSeconds ?? 0) });
  }
  return { catalogVersion: catalog.version, coinsPerMinute: policy.coinsPerMinute, orderBonusBps: policy.orderBonusBps,
    buildingUnlocks: auditBuildingUnlocks(catalog),
    activeHeroMaterialRoutes: materialTrips.length, expeditionFinds, experiments,
    activeRecipes: active.filter(source => source.buildingId).length, activeMiningRoutes: active.filter(source => source.activity === "mining").length,
    retiredSources: [...recipes.values(), ...routes.values()].filter(source => source.retired).map(source => source.id),
    assumptions: ["Reference unboosted technology; input value and operation time are each counted once.",
      "Optional experiments consume all inputs on failure; expected success value covers inputs and work, and maximum skill adds at most 12% of their total value plus coin rounding. Required progression excludes them; success has no finite deadline.",
      "Work excludes eight-second berry collection; collection and manual visits still affect actual completion.",
      "Capacity bounds assume all required buildings and inputs can be scheduled continuously; dependency/collection/storage/visit constraints can only make play slower.",
      "Fish, bait and relic acquisition is reported as external quantities, never invented as guaranteed production time.",
      "Chapter fees minus project rewards excludes starting money, tutorial/gifts, paid slots, NPC sales and ordinary orders; a positive result means additional earnings are needed.",
      "These are auditable production/action budgets, not calendar-playthrough simulations or forecasts."], items: itemRows, chapters };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
  const report = auditTimeEconomy(catalog);
  const baselineIndex = process.argv.indexOf("--baseline");
  if (baselineIndex >= 0) {
    const prior = JSON.parse(readFileSync(process.argv[baselineIndex + 1], "utf8"));
    const oldItems = new Map(prior.items.map(item => [item.id, item]));
    report.priceChanges = catalog.items.map(item => ({ itemId: item.id, name: item.name,
      before: oldItems.get(item.id)?.baseSellPrice ?? null, after: item.baseSellPrice }));
  }
  console.log(JSON.stringify(report, null, 2));
}
