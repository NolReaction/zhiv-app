import assert from "node:assert/strict";
import { economicMath, recipeBuildingLevel } from "./economy-math.mjs";
import { residentOrderBaseRecipes, residentOrderPricing } from "./resident-order-pricing.mjs";

export const tradeResidentIds = Object.freeze(["builder", "lopukh", "kamneshmyg", "plesk", "leaftail"]);
// The ten-completion hardwood shift is a later optimization, not an opening
// prerequisite for beams. Use the first repeatable source for authored work.
const acquisitionBaselines = Object.freeze({ hardwood: "gather_hardwood" });

export function tradeGuaranteedBuildings(template) {
  return { home: template.requiredHomeLevel, garden: 1, warehouse: 1, ...template.requiredBuildings };
}

const levelsPermit = (definition, buildings) => !definition.retired && buildings.home >= definition.requiredHomeLevel
  && Object.entries(definition.requiredBuildings ?? {}).every(([id, level]) => (buildings[id] ?? 0) >= level)
  && (!definition.buildingId || (buildings[definition.buildingId] ?? 0) >= recipeBuildingLevel(definition));

/** Independent fixed-point source proof. A recipe prerequisite must itself be
 * makeable; a bought item never substitutes for the required source chain. */
export function tradeSourceAvailability(catalog, buildings) {
  const items = new Set(), recipes = new Set();
  let changed = true;
  while (changed) {
    const before = items.size + recipes.size;
    for (const source of [...catalog.explorations, ...catalog.recipes]) {
      if (!levelsPermit(source, buildings) || Object.keys(source.requiredRecipes ?? {}).some(id => !recipes.has(id))) continue;
      const fishOptions = source.fishInput?.itemIds;
      if (Object.keys(source.cost.items).some(id => !items.has(id) && !fishOptions?.includes(id))
        || fishOptions && !fishOptions.some(id => items.has(id))) continue;
      for (const [id, count] of Object.entries(source.rewards)) if (count > 0) items.add(id);
      if (source.buildingId) recipes.add(source.id);
      if (catalog.fishing.routeIds.includes(source.id)) for (const group of catalog.fishing.classes) {
        if (catalog.fishing.rods.some(rod => rod.requiredHomeLevel <= buildings.home
          && (group.rarity !== "legendary" || rod.rarity === "legendary") && rod.classOddsBps[group.rarity] > 0)) {
          items.add(group.itemId);
          for (const species of catalog.fishing.fish.filter(fish => fish.rarity === group.rarity)) items.add(species.itemId);
        }
      }
    }
    changed = before !== items.size + recipes.size;
  }
  return { items, recipes };
}

/** Work-scaled XP with bounded individual awards and a separate daily cap.
 * A long, nested delivery earns more than a handful of raw ingredients. */
export function reputationXpForEffort(seconds) {
  assert(Number.isSafeInteger(seconds) && seconds > 0, "Effort must be positive whole seconds");
  return Math.min(30, Math.max(4, 4 + Math.ceil(seconds / 900)));
}

export function weeklyReputationXpForEffort(seconds) {
  assert(Number.isSafeInteger(seconds) && seconds > 0, "Effort must be positive whole seconds");
  return Math.min(100, Math.max(20, 10 + Math.ceil(seconds / 600)));
}

/** Baseline occupied work from an empty pantry, not a completion deadline.
 * Includes ingredient acquisition and upstream processing. Parallel stations
 * can overlap; joint expedition byproducts and existing stock can reduce time.
 * A mining job counts once even though it occupies both quarry and miner.
 * Fish use expected stock with the first affordable eligible tackle and have
 * no finite guarantee. Production bonuses, merchant stock waits and unlock
 * construction are deliberately outside this intrinsic work reference. */
export function tradeOrderEffort(catalog) {
  const math = economicMath(catalog), price = residentOrderPricing(catalog);
  const known = new Map(catalog.items.map(item => [item.id, item]));
  const fish = new Map([...catalog.fishing.classes, ...catalog.fishing.fish].map(group => [group.itemId, group]));
  return template => {
    const buildings = tradeGuaranteedBuildings(template), reachable = tradeSourceAvailability(catalog, buildings);
    const work = new Map(), references = {};
    const candidates = [];
    for (const source of [...catalog.recipes, ...catalog.explorations]) {
      if (!levelsPermit(source, buildings)
        || Object.keys(source.requiredRecipes ?? {}).some(id => !reachable.recipes.has(id))
        || Object.keys(source.cost.items).some(id => !reachable.items.has(id))) continue;
      for (const [itemId, output] of Object.entries(source.rewards)) {
        if (!known.has(itemId) || fish.has(itemId) || output <= 0) continue;
        const baseline = catalog.timeEconomy?.baselineRecipes[itemId] ?? catalog.timeEconomy?.baselineExplorations[itemId]
          ?? residentOrderBaseRecipes[itemId] ?? acquisitionBaselines[itemId];
        const reference = baseline && [...catalog.recipes, ...catalog.explorations].find(candidate => candidate.id === baseline);
        const baselineAvailable = reference && levelsPermit(reference, buildings)
          && Object.keys(reference.requiredRecipes ?? {}).every(id => reachable.recipes.has(id))
          && Object.keys(reference.cost.items).every(id => reachable.items.has(id));
        if (baselineAvailable && source.id !== baseline) continue;
        candidates.push({ itemId, id: source.id, output, seconds: source.seconds + (source.collection?.seconds ?? 0),
          inputs: source.cost.items, fishingUncertain: false });
      }
    }
    for (const [itemId, group] of fish) {
      if (!reachable.items.has(itemId)) continue;
      const rod = catalog.fishing.rods.filter(rod => rod.requiredHomeLevel <= buildings.home
        && (group.rarity !== "legendary" || rod.rarity === "legendary") && rod.classOddsBps[group.rarity] > 0)
        .sort((a, b) => a.price - b.price || a.id.localeCompare(b.id))[0];
      assert(rod, `${template.id}: no available tackle for ${itemId}`);
      const route = catalog.explorations.find(route => route.id === "shore");
      assert(route && levelsPermit(route, buildings), `${template.id}: baseline fishing route is unavailable`);
      const portfolio = math.catchPortfolio(rod.id, null, route.id, "bare_hook");
      const output = portfolio.output[itemId] ?? portfolio.probabilities[itemId] * portfolio.speciesDrawsPerJob;
      assert(output > 0, `${template.id}: zero chance of ${itemId}`);
      candidates.push({ itemId, id: `${route.id}:${rod.id}`, output, seconds: route.seconds,
        inputs: route.cost.items, fishingUncertain: true });
    }
    // Positive-cost graph relaxation ignores cyclic alternatives such as a
    // provision-consuming expedition which happens to return its own inputs.
    // Reaching the raw source first avoids recursion-order-dependent quotes.
    let changed = true, iterations = 0;
    while (changed) {
      changed = false; iterations++;
      assert(iterations <= catalog.items.length + 1, `${template.id}: source work did not converge`);
      for (const source of candidates) {
        if (Object.keys(source.inputs).some(id => !work.has(id))) continue;
        let seconds = source.seconds, fishingUncertain = source.fishingUncertain;
        for (const [input, quantity] of Object.entries(source.inputs)) {
          const effort = work.get(input);
          seconds += effort.seconds * quantity; fishingUncertain ||= effort.fishingUncertain;
        }
        seconds /= source.output;
        const previous = work.get(source.itemId);
        if (!previous || seconds < previous.seconds || seconds === previous.seconds && source.id < previous.id) {
          work.set(source.itemId, { id: source.id, seconds, fishingUncertain });
          references[source.itemId] = source.id; changed = true;
        }
      }
    }
    function itemEffort(itemId) {
      assert(known.has(itemId) && known.get(itemId).category !== "special", `${template.id}: invalid order item ${itemId}`);
      assert(reachable.items.has(itemId), `${template.id}: unavailable complete source chain for ${itemId}`);
      assert(work.has(itemId), `${template.id}: baseline source unavailable for ${itemId}`);
      return work.get(itemId);
    }
    let seconds = 0, fishingUncertain = false;
    for (const [itemId, quantity] of Object.entries(template.items)) {
      assert(Number.isSafeInteger(quantity) && quantity > 0, `${template.id}: invalid ingredient quantity`);
      const effort = itemEffort(itemId);
      seconds += quantity * effort.seconds; fishingUncertain ||= effort.fishingUncertain;
    }
    const effortSeconds = Math.ceil(seconds), manufacturingSeconds = price(template).manufacturingSeconds;
    assert(Number.isSafeInteger(effortSeconds) && effortSeconds >= manufacturingSeconds && effortSeconds > 0,
      `${template.id}: intrinsic work must include all manufacturing`);
    return { effortSeconds, manufacturingSeconds, fishingUncertain, reputationXp: reputationXpForEffort(effortSeconds), references };
  };
}
