import assert from "node:assert/strict";

export const recipeBuildingLevel = recipe => recipe.baseCampfire === true && recipe.id === "cook_grilled_fish"
  && recipe.buildingId === "dryer" && recipe.buildingLevel === 1 ? 0 : recipe.buildingLevel;

const add = (into, values, scale = 1) => {
  for (const [key, value] of Object.entries(values)) into[key] = (into[key] ?? 0) + value * scale;
};
const requireLevels = (into, values) => {
  for (const [id, level] of Object.entries(values)) into[id] = Math.max(into[id] ?? 0, level);
};
const productionStation = definition => definition.buildingId ?? (definition.activity === "mining" && definition.requiredBuildings?.quarry ? "quarry" : null);
const recipeSlots = recipe => {
  const station = productionStation(recipe);
  const slots = station ? { [station]: (recipe.seconds + (recipe.collection?.seconds ?? 0)) / 60 } : {};
  // Focused mining reserves both the mine and its independent miner for the same interval.
  // This is resource occupancy, not two consecutive wall-clock intervals.
  const actorSeconds = (!recipe.buildingId ? recipe.seconds : 0) + (recipe.collection?.seconds ?? 0);
  if (actorSeconds) slots[recipe.activity === "mining" ? "miner" : "mochlik"] = actorSeconds / 60;
  return slots;
};
/** Fish use their specialist buyer; configured first-stage goods have exact NPC prices. */
export function createLiquidation(catalog) {
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const fish = new Set([...(catalog.fishing?.fish ?? []), ...(catalog.fishing?.classes ?? [])].map(item => item.itemId));
  const scale = catalog.currencyScale ?? 1, buyer = catalog.localBuyer;
  return quantities => Object.entries(quantities).reduce((sum, [id, quantity]) => {
    const item = items.get(id); assert(item, `Unknown sale item ${id}`);
    const fixed = buyer?.unitPrices?.[id];
    return sum + (fish.has(id) ? item.baseSellPrice * quantity : fixed !== undefined ? fixed * quantity
      : Math.floor(item.baseSellPrice / scale * quantity * (buyer?.payoutBps ?? 10000) / 10000) * scale);
  }, 0);
}

/** Resource work is a vector of minimum intrinsic occupied slot-minutes, not
 * elapsed wall time: compulsory collection is included, waiting to claim is not.
 * Elementary references use short single-output recipes. Catch byproducts are
 * reported separately; their sale is not silently deducted from an input cost.
 */
export function economicMath(catalog) {
  const items = new Map(catalog.items.map(i => [i.id, i]));
  const buildings = new Map(catalog.buildings.map(b => [b.id, b]));
  const fish = new Set([...(catalog.fishing?.fish ?? []), ...(catalog.fishing?.classes ?? [])].map(f => f.itemId));
  const rare = new Set(catalog.rareDrops?.itemIds ?? []);
  const liquidation = createLiquidation(catalog);
  const recipes = new Map(catalog.recipes.map(recipe => [recipe.id, recipe]));
  const homeCache = new Map();
  function buildingHome(id, level, path = []) {
    if (id === "dryer" && level === 0) return 1;
    const key = `${id}:${level}`;
    if (homeCache.has(key)) return homeCache.get(key);
    assert(!path.includes(key), `Unlock cycle: ${key}`);
    const d = buildings.get(id)?.levels.find(l => l.level === level); assert(d, `Unknown building ${key}`);
    let result = Math.max(d.requiredHomeLevel, id === "home" ? level : 1);
    if (level > 1) result = Math.max(result, buildingHome(id, level - 1, [...path, key]));
    for (const [b, l] of Object.entries(d.requiredBuildings)) result = Math.max(result, buildingHome(b, l, [...path, key]));
    homeCache.set(key, result); return result;
  }
  const definitionHome = (d, path = []) => {
    assert(!path.includes(d.id), `Recipe unlock cycle: ${[...path, d.id].join(" -> ")}`);
    return Math.max(d.requiredHomeLevel,
      ...(d.buildingId ? [buildingHome(d.buildingId, recipeBuildingLevel(d))] : []),
      ...Object.entries(d.requiredBuildings ?? {}).map(([id, level]) => buildingHome(id, level)),
      ...Object.keys(d.requiredRecipes ?? {}).map(id => {
        const prior = recipes.get(id); assert(prior, `Unknown recipe unlock ${id}`);
        return definitionHome(prior, [...path, d.id]);
      }));
  };
  const unlockPrerequisites = (d, path = []) => {
    assert(!path.includes(d.id), `Recipe unlock cycle: ${[...path, d.id].join(" -> ")}`);
    const levels = { ...d.requiredBuildings, ...(d.buildingId ? { [d.buildingId]: recipeBuildingLevel(d) } : {}), home: d.requiredHomeLevel };
    const completedRecipes = { ...d.requiredRecipes };
    for (const id of Object.keys(d.requiredRecipes ?? {})) {
      const recipe = recipes.get(id); assert(recipe, `Unknown recipe unlock ${id}`);
      const prior = unlockPrerequisites(recipe, [...path, d.id]);
      requireLevels(levels, prior.levels); requireLevels(completedRecipes, prior.completedRecipes);
    }
    return { levels, completedRecipes };
  };
  const rodCanCatch = (rod, rarity) => (rarity !== "legendary" || rod.rarity === "legendary")
    && (!rod.classOddsBps || rod.classOddsBps[rarity] > 0);
  const fishingHome = itemId => {
    const spec = [...catalog.fishing.fish, ...(catalog.fishing.classes ?? [])].find(f => f.itemId === itemId);
    return Math.max(1, Math.min(...catalog.fishing.rods.filter(rod => rodCanCatch(rod, spec.rarity)).map(rod => rod.requiredHomeLevel ?? 1)));
  };
  const sourceHome = itemId => Math.min(...[...catalog.recipes, ...catalog.explorations].filter(d => d.rewards[itemId] > 0).map(d => definitionHome(d)),
    ...(rare.has(itemId) ? [catalog.rareDrops.requiredHomeLevel] : []),
    ...(fish.has(itemId) ? [fishingHome(itemId)] : []),
    ...(catalog.fishing?.baits.filter(b => b.itemId === itemId).map(b => b.requiredHomeLevel ?? 1) ?? []));
  const primitive = new Map();
  for (const r of [...catalog.recipes, ...catalog.explorations.filter(r => r.activity === "mining")].filter(r => r.seconds < 14400 && Object.keys(r.rewards).length === 1)) {
    const id = Object.keys(r.rewards)[0], prior = primitive.get(id);
    if (!prior || r.seconds / r.rewards[id] < prior.seconds / prior.rewards[id]) primitive.set(id, r);
  }
  function catchPortfolio(rodId = "reed_rod", baitId = null, routeId = "shore", hookId = "bare_hook") {
    const route = catalog.explorations.find(r => r.id === routeId); assert(route && route.rewards.fish > 0);
    const tackle = [catalog.fishing.rods.find(r => r.id === rodId), catalog.fishing.hooks.find(h => h.id === hookId), catalog.fishing.baits.find(b => b.itemId === baitId)];
    const eligible = f => tackle[0] && rodCanCatch(tackle[0], f.rarity);
    const classes = catalog.fishing.classes.map(group => {
      const species = catalog.fishing.fish.filter(f => f.rarity === group.rarity && eligible(f));
      const weight = !species.length ? 0 : tackle[0].classOddsBps
        ? Math.floor(tackle[0].classOddsBps[group.rarity] * (tackle[1]?.rarityWeights?.[group.rarity] ?? 100)
          * (tackle[2]?.rarityWeights?.[group.rarity] ?? 100) / 10000)
        : Math.max(1, Math.floor(group.weight * tackle.reduce((weight, gear) =>
          weight * (gear?.rarityWeights?.[group.rarity] ?? 100), 1) / 1_000_000));
      return { ...group, species, weight };
    });
    const total = classes.reduce((sum, group) => sum + group.weight, 0);
    assert(total > 0, "Fishing requires an eligible class");
    const classProbabilities = Object.fromEntries(classes.map(group => [group.itemId, group.weight / total]));
    const speciesWeight = fish => (tackle[0]?.speciesWeights?.[fish.itemId] ?? 100) * (tackle[1]?.speciesWeights?.[fish.itemId] ?? 100);
    const probabilities = Object.fromEntries(catalog.fishing.fish.map(f => {
      const group = classes.find(group => group.rarity === f.rarity);
      return [f.itemId, eligible(f) && group.species.length ? group.weight / total * speciesWeight(f)
        / group.species.reduce((sum, species) => sum + speciesWeight(species), 0) : 0];
    }));
    const draws = catalog.fishing.collectionDrawsByRoute?.[routeId] ?? 1;
    assert(Number.isInteger(draws) && draws > 0 && draws <= route.rewards.fish, `${routeId}: invalid number of species draws`);
    const output = { ...route.rewards };
    delete output.fish;
    for (const group of classes) output[group.itemId] = draws * classProbabilities[group.itemId];
    output[classes.find(group => group.rarity === "common").itemId] += route.rewards.fish - draws;
    const baitCost = baitId ? catalog.fishing.baits.find(b => b.itemId === baitId).price : 0;
    return { slotMinutes: { mochlik: route.seconds / 60 }, output, speciesDrawsPerJob: draws, probabilities, classProbabilities,
      routeCoins: route.cost.coins, routeInputs: { ...route.cost.items }, baitPurchaseCoins: baitCost, expectedFishRevenue: Object.entries(output).filter(([id]) => fish.has(id)).reduce((sum, [id, q]) => sum + items.get(id).baseSellPrice * q, 0) };
  }
  const profiles = new Map();
  function profile(id, path = []) {
    if (profiles.has(id)) return profiles.get(id);
    assert(!path.includes(id), `Production cycle: ${[...path, id].join(" -> ")}`);
    const r = primitive.get(id);
    const result = { itemId: id, slotMinutes: {}, rawInputs: {}, coins: 0, depth: 0, sourceHome: sourceHome(id), referenceHome: 1, byproducts: {}, producerLevels: {}, unlockRecipes: {} };
    if (r) {
      const output = r.rewards[id]; result[r.buildingId ? "recipeId" : "routeId"] = r.id; result.referenceHome = definitionHome(r);
      const prerequisites = unlockPrerequisites(r);
      requireLevels(result.producerLevels, prerequisites.levels); requireLevels(result.unlockRecipes, prerequisites.completedRecipes);
      add(result.slotMinutes, recipeSlots(r), 1 / output); result.coins += r.cost.coins / output;
      if (!Object.keys(r.cost.items).length) result.rawInputs[id] = 1;
      for (const [input, quantity] of Object.entries(r.cost.items)) {
        const p = profile(input, [...path, id]), scale = quantity / output;
        add(result.slotMinutes, p.slotMinutes, scale); add(result.rawInputs, p.rawInputs, scale); add(result.byproducts, p.byproducts, scale);
        requireLevels(result.producerLevels, p.producerLevels);
        requireLevels(result.unlockRecipes, p.unlockRecipes);
        result.coins += p.coins * scale; result.depth = Math.max(result.depth, p.depth + 1); result.referenceHome = Math.max(result.referenceHome, p.referenceHome);
      }
    } else if (rare.has(id)) {
      const spec = catalog.rareDrops, meanSeconds = (spec.minSeconds + spec.maxSeconds) / 2;
      result.reference = "independent completed-exploration clock per actor; no NPC or coin-market purchase";
      result.referenceHome = spec.requiredHomeLevel;
      result.producerLevels.home = spec.requiredHomeLevel;
      // These are expectations, not a deterministic recipe or a zero-cost NPC item.
      // The same expedition hours yield other types, so individual expectations cannot be summed.
      result.acquisition = { kind: "rare_drop", clock: "per_actor_exploration", actors: ["mochlik", "miner"],
        timeReference: "completed work of one actor; simultaneous wall-clock rates are not modeled", requiredHomeLevel: spec.requiredHomeLevel,
        minClockSeconds: spec.minSeconds, maxClockSeconds: spec.maxSeconds, meanAnySeconds: meanSeconds,
        maxDeliveryRoundingSeconds: Math.max(...catalog.explorations.map(route => route.seconds)),
        typeProbability: 1 / spec.itemIds.length, expectedSpecificSeconds: meanSeconds * spec.itemIds.length,
        expectedCompleteSetSeconds: meanSeconds * spec.itemIds.length * spec.itemIds.reduce((sum, _, index) => sum + 1 / (index + 1), 0),
        finiteSpecificGuarantee: false, coinPurchasePrice: null };
    } else if (fish.has(id)) {
      const spec = [...catalog.fishing.fish, ...catalog.fishing.classes].find(f => f.itemId === id);
      const group = catalog.fishing.classes.find(f => f.rarity === spec.rarity);
      const rod = catalog.fishing.rods.filter(rod => rodCanCatch(rod, spec.rarity)).sort((a, b) => a.price - b.price)[0];
      const hook = catalog.fishing.hooks.toSorted((a, b) => a.price - b.price)[0];
      assert(rod && hook, `${id}: no eligible reference tackle`);
      const portfolio = catchPortfolio(rod.id, null, "shore", hook.id), probability = portfolio.classProbabilities[group.itemId];
      const output = portfolio.output[group.itemId];
      assert(output > 0, `${id}: reference tackle cannot catch the fish class`);
      result.reference = "steady-state class stock with least expensive eligible tackle; merchant waiting excluded";
      result.referenceHome = result.sourceHome;
      result.producerLevels.home = result.referenceHome;
      result.rawInputs[group.itemId] = 1;
      result.catchReference = { rodId: rod.id, hookId: hook.id, probability, expectedTrips: 1 / output,
        expectedFishPerTrip: output, rodPurchaseCoins: rod.price, hookPurchaseCoins: hook.price, finiteGuarantee: false };
      add(result.slotMinutes, portfolio.slotMinutes, 1 / output);
      result.coins = portfolio.routeCoins / output;
      for (const [input, quantity] of Object.entries(portfolio.routeInputs)) {
        const p = profile(input, [...path, id]), scale = quantity / output;
        add(result.slotMinutes, p.slotMinutes, scale); add(result.rawInputs, p.rawInputs, scale); add(result.byproducts, p.byproducts, scale);
        requireLevels(result.producerLevels, p.producerLevels); result.coins += p.coins * scale;
        result.depth = Math.max(result.depth, p.depth + 1); result.referenceHome = Math.max(result.referenceHome, p.referenceHome);
      }
      for (const [other, quantity] of Object.entries(portfolio.output)) if (other !== group.itemId && quantity > 0) result.byproducts[other] = quantity / output;
    } else {
      const purchase = catalog.fishing?.baits.find(b => b.itemId === id);
      assert(purchase, `No elementary reference or NPC stock for ${id}`);
      result.reference = "rotating merchant offer; stock waiting excluded"; result.coins = purchase.price; result.referenceHome = result.sourceHome;
    }
    result.totalSlotMinutes = Object.values(result.slotMinutes).reduce((sum, minutes) => sum + minutes, 0);
    profiles.set(id, result); return result;
  }
  function batch(recipe) {
    const stationMinutes = (recipe.seconds + (recipe.collection?.seconds ?? 0)) / 60;
    const slotMinutes = recipeSlots(recipe), rawInputs = {}, byproducts = {};
    let coins = recipe.cost.coins, referenceHome = definitionHome(recipe);
    for (const [id, quantity] of Object.entries(recipe.cost.items)) {
      const p = profile(id); add(slotMinutes, p.slotMinutes, quantity); add(rawInputs, p.rawInputs, quantity); add(byproducts, p.byproducts, quantity); coins += p.coins * quantity;
      referenceHome = Math.max(referenceHome, p.referenceHome);
    }
    const elementaryOutputMinutes = {};
    for (const [id, quantity] of Object.entries(recipe.rewards)) add(elementaryOutputMinutes, profile(id).slotMinutes, quantity);
    const baseValue = quantities => Object.entries(quantities).reduce((sum, [id, quantity]) => sum + items.get(id).baseSellPrice * quantity, 0);
    const baseMarketMargin = baseValue(recipe.rewards) - baseValue(recipe.cost.items) - recipe.cost.coins;
    return { id: recipe.id, directHome: definitionHome(recipe), referenceHome, output: { ...recipe.rewards }, directInputs: { ...recipe.cost.items },
      slotMinutes, rawInputs, byproducts, coins, elementaryOutputMinutes,
      directRevenue: liquidation(recipe.rewards), directInputOpportunity: liquidation(recipe.cost.items) + recipe.cost.coins,
      incrementalMargin: liquidation(recipe.rewards) - liquidation(recipe.cost.items) - recipe.cost.coins,
      baseMarketMargin, baseMarketMarginPerStationHour: baseMarketMargin / (stationMinutes / 60),
      maxBatch: recipe.maxBatch, processMinutes: recipe.seconds / 60, stationMinutes };
  }
  const stationBenchmarks = {};
  for (const r of [...catalog.recipes, ...catalog.explorations.filter(r => productionStation(r))]) {
    const margin = liquidation(r.rewards) - liquidation(r.cost.items) - r.cost.coins;
    const stationMinutes = (r.seconds + (r.collection?.seconds ?? 0)) / 60;
    const rate = margin / stationMinutes, prior = stationBenchmarks[productionStation(r)];
    if (!prior || rate > prior.coinsPerMinute) stationBenchmarks[productionStation(r)] = { recipeId: r.id, coinsPerMinute: rate, marginPerBatch: margin, stationMinutes };
  }
  if (stationBenchmarks.quarry) stationBenchmarks.miner = { ...stationBenchmarks.quarry };
  const portfolio = catchPortfolio(); stationBenchmarks.mochlik = { recipeId: "shore with starter tackle, expectation", coinsPerMinute: (portfolio.expectedFishRevenue - portfolio.routeCoins - portfolio.baitPurchaseCoins - liquidation(portfolio.routeInputs)) / portfolio.slotMinutes.mochlik };
  function startup(producerLevels) {
    const nodes = new Map(), initial = { home: 1, garden: 1, warehouse: 1 };
    const visit = (id, level) => {
      const key = `${id}:${level}`;
      if (nodes.has(key) || level <= (initial[id] ?? 0)) return;
      const d = buildings.get(id).levels.find(l => l.level === level); nodes.set(key, d);
      if (level > 1) visit(id, level - 1);
      visit("home", d.requiredHomeLevel);
      for (const [b, l] of Object.entries(d.requiredBuildings)) visit(b, l);
    };
    for (const [id, level] of Object.entries(producerLevels)) visit(id, level);
    const costItems = {}; let coins = 0, constructionMinutes = 0;
    for (const d of nodes.values()) { coins += d.cost.coins; constructionMinutes += d.seconds / 60; add(costItems, d.cost.items); }
    return { upgrades: [...nodes.keys()], coins, costItems, constructionMinutes };
  }
  return { profile, batch, catchPortfolio, sourceHome, liquidation, stationBenchmarks, startup };
}

export function auditEconomicMath(catalog) {
  const math = economicMath(catalog);
  const profiles = catalog.items.map(i => ({ ...math.profile(i.id), name: i.name, basePrice: i.baseSellPrice,
    startup: math.startup(math.profile(i.id).producerLevels),
    oneUnitNpcRevenue: math.liquidation({ [i.id]: 1 }),
    slotOpportunityCoins: i.category === "special" ? null : Object.entries(math.profile(i.id).slotMinutes).reduce((sum, [slot, minutes]) => sum + minutes * math.stationBenchmarks[slot].coinsPerMinute, 0) }));
  const batches = catalog.recipes.map(math.batch);
  const mining = catalog.explorations.filter(route => route.activity === "mining").map(math.batch);
  for (const p of profiles) assert(Object.values(p.slotMinutes).every(x => Number.isFinite(x) && x >= 0), `${p.itemId}: invalid minutes`);
  for (const r of batches) assert(r.incrementalMargin > 0, `${r.id}: nonpositive actual sale margin`);
  return { units: "minimum intrinsic occupied named slot-minutes, excluding waits to claim; coins; item units", profiles, batches, mining, stationBenchmarks: math.stationBenchmarks,
    fishing: catalog.fishing.rods.map(r => ({ rodId: r.id, ...math.catchPortfolio(r.id) })),
    fishingLoadouts: catalog.fishing.rods.flatMap(rod => (catalog.fishing.hooks ?? [{ id: "bare_hook" }]).flatMap(hook =>
      [null, ...catalog.fishing.baits.map(bait => bait.itemId)].map(baitId => ({ rodId: rod.id, hookId: hook.id, baitId,
        ...math.catchPortfolio(rod.id, baitId, "shore", hook.id) })))) };
}
