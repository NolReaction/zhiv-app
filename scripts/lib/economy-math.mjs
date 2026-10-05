import assert from "node:assert/strict";

const add = (into, values, scale = 1) => {
  for (const [key, value] of Object.entries(values)) into[key] = (into[key] ?? 0) + value * scale;
};
const requireLevels = (into, values) => {
  for (const [id, level] of Object.entries(values)) into[id] = Math.max(into[id] ?? 0, level);
};

/** Resource work is a vector of minimum intrinsic occupied slot-minutes, not
 * elapsed wall time: compulsory collection is included, waiting to claim is not.
 * Elementary references use short single-output recipes. Catch byproducts are
 * reported separately; their sale is not silently deducted from an input cost.
 */
export function economicMath(catalog) {
  const items = new Map(catalog.items.map(i => [i.id, i]));
  const buildings = new Map(catalog.buildings.map(b => [b.id, b]));
  const fish = new Set(catalog.fishing?.fish.map(f => f.itemId) ?? []);
  const liquidation = quantities => Object.entries(quantities).reduce((sum, [id, quantity]) => sum +
    (fish.has(id) ? items.get(id).baseSellPrice * quantity : Math.floor(items.get(id).baseSellPrice * quantity * (catalog.localBuyer?.payoutBps ?? 10000) / 10000)), 0);
  const homeCache = new Map();
  function buildingHome(id, level, path = []) {
    const key = `${id}:${level}`;
    if (homeCache.has(key)) return homeCache.get(key);
    assert(!path.includes(key), `Unlock cycle: ${key}`);
    const d = buildings.get(id)?.levels.find(l => l.level === level); assert(d, `Unknown building ${key}`);
    let result = Math.max(d.requiredHomeLevel, id === "home" ? level : 1);
    if (level > 1) result = Math.max(result, buildingHome(id, level - 1, [...path, key]));
    for (const [b, l] of Object.entries(d.requiredBuildings)) result = Math.max(result, buildingHome(b, l, [...path, key]));
    homeCache.set(key, result); return result;
  }
  const definitionHome = d => Math.max(d.requiredHomeLevel,
    ...(d.buildingId ? [buildingHome(d.buildingId, d.buildingLevel)] : []),
    ...Object.entries(d.requiredBuildings ?? {}).map(([id, level]) => buildingHome(id, level)));
  const sourceHome = itemId => Math.min(...[...catalog.recipes, ...catalog.explorations].filter(d => d.rewards[itemId] > 0).map(definitionHome),
    ...(fish.has(itemId) || catalog.fishing?.baits.some(b => b.itemId === itemId) ? [1] : []));
  const primitive = new Map();
  for (const r of catalog.recipes.filter(r => r.seconds < 14400 && Object.keys(r.rewards).length === 1)) {
    const id = Object.keys(r.rewards)[0], prior = primitive.get(id);
    if (!prior || r.seconds / r.rewards[id] < prior.seconds / prior.rewards[id]) primitive.set(id, r);
  }
  function catchPortfolio(rodId = "reed_rod", baitId = null, routeId = "shore") {
    const route = catalog.explorations.find(r => r.id === routeId); assert(route && route.rewards.fish > 0);
    const bonus = (catalog.fishing.rods.find(r => r.id === rodId)?.rareBonus ?? 0) + (catalog.fishing.baits.find(b => b.itemId === baitId)?.rareBonus ?? 0);
    const weights = catalog.fishing.fish.map(f => ({ ...f, w: f.weight + f.affinity * bonus })), total = weights.reduce((sum, f) => sum + f.w, 0);
    const output = { ...route.rewards, fish: route.rewards.fish - 1 };
    for (const f of weights) output[f.itemId] = (output[f.itemId] ?? 0) + f.w / total;
    const baitCost = baitId ? catalog.fishing.baits.find(b => b.itemId === baitId).price : 0;
    return { slotMinutes: { mochlik: route.seconds / 60 }, output, probabilities: Object.fromEntries(weights.map(f => [f.itemId, f.w / total])),
      routeCoins: route.cost.coins, routeInputs: { ...route.cost.items }, baitPurchaseCoins: baitCost, expectedFishRevenue: Object.entries(output).filter(([id]) => fish.has(id)).reduce((sum, [id, q]) => sum + items.get(id).baseSellPrice * q, 0) };
  }
  const profiles = new Map();
  function profile(id, path = []) {
    if (profiles.has(id)) return profiles.get(id);
    assert(!path.includes(id), `Production cycle: ${[...path, id].join(" -> ")}`);
    const r = primitive.get(id);
    const result = { itemId: id, slotMinutes: {}, rawInputs: {}, coins: 0, depth: 0, sourceHome: sourceHome(id), referenceHome: 1, byproducts: {}, producerLevels: {} };
    if (r) {
      const output = r.rewards[id]; result.recipeId = r.id; result.referenceHome = definitionHome(r);
      requireLevels(result.producerLevels, { ...r.requiredBuildings, [r.buildingId]: r.buildingLevel, home: r.requiredHomeLevel });
      add(result.slotMinutes, { [r.buildingId]: (r.seconds + (r.collection?.seconds ?? 0)) / 60 / output }); result.coins += r.cost.coins / output;
      if (r.collection) add(result.slotMinutes, { mochlik: r.collection.seconds / 60 / output });
      if (!Object.keys(r.cost.items).length) result.rawInputs[id] = 1;
      for (const [input, quantity] of Object.entries(r.cost.items)) {
        const p = profile(input, [...path, id]), scale = quantity / output;
        add(result.slotMinutes, p.slotMinutes, scale); add(result.rawInputs, p.rawInputs, scale); add(result.byproducts, p.byproducts, scale);
        requireLevels(result.producerLevels, p.producerLevels);
        result.coins += p.coins * scale; result.depth = Math.max(result.depth, p.depth + 1); result.referenceHome = Math.max(result.referenceHome, p.referenceHome);
      }
    } else if (id === "fish") {
      const portfolio = catchPortfolio(), output = portfolio.output.fish;
      result.reference = "steady-state starter catch portfolio";
      add(result.slotMinutes, portfolio.slotMinutes, 1 / output); result.rawInputs.fish = 1;
      result.coins = (portfolio.routeCoins + portfolio.baitPurchaseCoins) / output;
      for (const [input, quantity] of Object.entries(portfolio.routeInputs)) {
        const p = profile(input, [...path, id]), scale = quantity / output;
        add(result.slotMinutes, p.slotMinutes, scale); add(result.rawInputs, p.rawInputs, scale); add(result.byproducts, p.byproducts, scale);
        requireLevels(result.producerLevels, p.producerLevels); result.coins += p.coins * scale;
        result.depth = Math.max(result.depth, p.depth + 1); result.referenceHome = Math.max(result.referenceHome, p.referenceHome);
      }
      for (const [other, quantity] of Object.entries(portfolio.output)) if (other !== "fish") result.byproducts[other] = quantity / output;
    } else {
      const purchase = catalog.fishing?.fish.find(f => f.itemId === id) ?? catalog.fishing?.baits.find(b => b.itemId === id);
      assert(purchase, `No elementary reference or NPC stock for ${id}`);
      result.reference = "NPC purchase; caught alternatives are portfolios"; result.coins = purchase.buyPrice ?? purchase.price;
    }
    result.totalSlotMinutes = Object.values(result.slotMinutes).reduce((sum, minutes) => sum + minutes, 0);
    profiles.set(id, result); return result;
  }
  function batch(recipe) {
    const stationMinutes = (recipe.seconds + (recipe.collection?.seconds ?? 0)) / 60;
    const slotMinutes = { [recipe.buildingId]: stationMinutes }, rawInputs = {}, byproducts = {};
    let coins = recipe.cost.coins, referenceHome = definitionHome(recipe);
    if (recipe.collection) add(slotMinutes, { mochlik: recipe.collection.seconds / 60 });
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
  for (const r of catalog.recipes) {
    const margin = liquidation(r.rewards) - liquidation(r.cost.items) - r.cost.coins;
    const stationMinutes = (r.seconds + (r.collection?.seconds ?? 0)) / 60;
    const rate = margin / stationMinutes, prior = stationBenchmarks[r.buildingId];
    if (!prior || rate > prior.coinsPerMinute) stationBenchmarks[r.buildingId] = { recipeId: r.id, coinsPerMinute: rate, marginPerBatch: margin, stationMinutes };
  }
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
    slotOpportunityCoins: Object.entries(math.profile(i.id).slotMinutes).reduce((sum, [slot, minutes]) => sum + minutes * math.stationBenchmarks[slot].coinsPerMinute, 0) }));
  const batches = catalog.recipes.map(math.batch);
  for (const p of profiles) assert(Object.values(p.slotMinutes).every(x => Number.isFinite(x) && x >= 0), `${p.itemId}: invalid minutes`);
  for (const r of batches) assert(r.incrementalMargin > 0, `${r.id}: nonpositive actual sale margin`);
  return { units: "minimum intrinsic occupied named slot-minutes, excluding waits to claim; coins; item units", profiles, batches, stationBenchmarks: math.stationBenchmarks,
    fishing: catalog.fishing.rods.map(r => ({ rodId: r.id, ...math.catchPortfolio(r.id) })) };
}
