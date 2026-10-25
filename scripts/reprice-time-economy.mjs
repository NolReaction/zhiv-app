import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { timeEconomyPricing } from "./lib/time-economy-pricing.mjs";
import { reputationXpForEffort, tradeOrderEffort } from "./lib/trade-relations-effort.mjs";

/** Reproducible derivations only: recipes, their timings, requirements and basket
 * contents remain authored inputs. Never reads player wallets or saved jobs. */
export function repriceTimeEconomy(source) {
  const catalog = structuredClone(source), policy = catalog.timeEconomy;
  assert(policy?.version === 1 && catalog.version >= 13, "A v13 time catalogue is required");
  const pricing = timeEconomyPricing(catalog);
  const itemById = new Map(catalog.items.map(item => [item.id, item]));
  const recipeById = new Map(catalog.recipes.map(recipe => [recipe.id, recipe]));
  const routeById = new Map(catalog.explorations.map(route => [route.id, route]));
  const buildingById = new Map(catalog.buildings.map(building => [building.id, building]));
  for (const item of catalog.items) item.baseSellPrice = pricing.price(item.id);
  catalog.localBuyer.unitPrices = Object.fromEntries(catalog.items.filter(item => item.tradable).map(item => [item.id, item.baseSellPrice]));
  for (const building of catalog.buildings) for (const level of building.levels)
    level.cost.coins = building.id === "warehouse" && level.level >= 4 ? 0
      : Math.ceil(level.seconds * policy.constructionCoinsPerMinute / 60);
  for (const offer of catalog.leaftailShop.supplyOffers ?? []) offer.unitPriceCoins = pricing.price(offer.itemId) * 2;
  for (const offer of catalog.leaftailShop.offers ?? [])
    if (itemById.has(offer.itemId) && (!offer.kind || offer.kind === "item")) offer.priceCoins = pricing.price(offer.itemId) * offer.quantity * 2;

  // Transitive requirements protect every new order from an inaccessible input.
  // Early free forest trips remain an alternative for stone/fibre before mining.
  function requirements(items, initialHome, initialBuildings = {}) {
    const levels = Object.fromEntries(Object.entries(initialBuildings).filter(([, level]) => level > 0)), seen = new Set(); let home = initialHome;
    function building(id, level) {
      if (level <= 0) return;
      if (id === "home") { home = Math.max(home, level); return; }
      if ((levels[id] ?? 0) >= level && seen.has(`building:${id}:${level}`)) return;
      levels[id] = Math.max(levels[id] ?? 0, level);
      for (const spec of buildingById.get(id)?.levels.filter(spec => spec.level <= level) ?? []) {
        const key = `building:${id}:${spec.level}`; if (seen.has(key)) continue; seen.add(key);
        home = Math.max(home, spec.requiredHomeLevel);
      }
    }
    function recipe(id) { const source = recipeById.get(id); assert(source && !source.retired, `Unavailable recipe: ${id}`); visit(source); }
    function visit(source) {
      const key = `source:${source.id}`; if (seen.has(key)) return; seen.add(key);
      home = Math.max(home, source.requiredHomeLevel);
      for (const [id, level] of Object.entries(source.requiredBuildings)) building(id, level);
      if (source.buildingId) building(source.buildingId, source.baseCampfire ? 0 : source.buildingLevel);
      for (const id of Object.keys(source.requiredRecipes ?? {})) recipe(id);
      for (const id of Object.keys(source.cost.items)) item(id);
    }
    function item(id) {
      const recipeId = policy.baselineRecipes[id], routeId = policy.baselineExplorations[id];
      let source = recipeId ? recipeById.get(recipeId) : routeId ? routeById.get(routeId) : null;
      const initialLevel = id => initialBuildings[id] ?? (id === "garden" || id === "warehouse" ? 1 : 0);
      if (source && !Object.keys(source.cost.items).length && (source.requiredHomeLevel > initialHome
        || source.buildingId && initialLevel(source.buildingId) < source.buildingLevel
        || Object.entries(source.requiredBuildings).some(([id, level]) => initialLevel(id) < level))) {
        const earlier = catalog.explorations.find(route => !route.retired && route.requiredHomeLevel <= initialHome
          && !Object.keys(route.requiredBuildings).length && !Object.keys(route.cost.items).length && route.rewards[id] > 0);
        if (earlier) source = earlier;
      }
      if (source) visit(source);
    }
    for (const [id, level] of Object.entries(initialBuildings)) building(id, level);
    for (const id of Object.keys(items)) item(id);
    return { requiredHomeLevel: home, requiredBuildings: levels };
  }
  for (const template of catalog.food.orders.templates)
    Object.assign(template, requirements(template.items, template.requiredHomeLevel, template.requiredBuildings));
  for (const weekly of catalog.tradeRelations.weekly.templates) {
    const items = Object.assign({}, ...weekly.stages.map(stage => stage.items));
    Object.assign(weekly, requirements(items, weekly.requiredHomeLevel, weekly.requiredBuildings));
  }
  const effort = tradeOrderEffort(catalog);
  for (const template of catalog.food.orders.templates) {
    const work = effort(template);
    Object.assign(template, { coins: pricing.order(template.items), effortSeconds: work.effortSeconds,
      manufacturingSeconds: work.manufacturingSeconds, fishingUncertain: work.fishingUncertain,
      reputationXp: reputationXpForEffort(work.effortSeconds) });
  }
  for (const weekly of catalog.tradeRelations.weekly.templates) for (const stage of weekly.stages) {
    const work = effort({ ...weekly, ...stage });
    Object.assign(stage, { coins: pricing.order(stage.items), effortSeconds: work.effortSeconds,
      manufacturingSeconds: work.manufacturingSeconds, fishingUncertain: work.fishingUncertain });
  }
  for (const course of catalog.stageOrders ?? []) for (const order of course.orders) order.coins = pricing.order(order.items);
  for (const order of [catalog.onboarding.residentOrder, ...(catalog.onboarding.residentOrders ?? [])]) order.coins = pricing.order(order.items);
  return catalog;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const url = new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url);
  const current = readFileSync(url, "utf8"), next = `${JSON.stringify(repriceTimeEconomy(JSON.parse(current)), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    assert.equal(current, next, "Derived prices or order effort are stale; run node scripts/reprice-time-economy.mjs");
    console.log("Time-economy prices and order effort are current.");
  } else { writeFileSync(url, next); console.log("Recalculated item, order, merchant and construction prices."); }
}
