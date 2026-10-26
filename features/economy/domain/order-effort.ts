import { economyCatalog, recipeBuildingLevel, type EconomyCatalog, type EconomyState } from "./model";
import { fishingClassWeights, fishingState, fishingClassItemId, fishingCollectionDraws, fishingSpeciesWeights, fishingWeights, fishClassForItem } from "./fishing";

export type OrderEffortSource = Pick<EconomyState, "buildings"> & Partial<Pick<EconomyState, "fishing" | "progression">> & { catalog?: EconomyCatalog };
/** Reachability is a fixed point over all unlocked production and expedition
 * inputs. Inventory and unfinished buildings cannot unlock an unsustainable chain. */
export function obtainableResidentOrderItems(state: OrderEffortSource, catalog = state.catalog ?? economyCatalog): Set<string> {
  const reachable = new Set<string>();
  const tackle = fishingState(state);
  const fishing = catalog.fishing;
  const catchable = new Set<string>();
  if (fishing) for (const rod of fishing.rods.filter(rod => tackle.ownedRods.includes(rod.id)))
    for (const hook of fishing.hooks.filter(hook => tackle.ownedHooks.includes(hook.id)))
      for (const group of fishingClassWeights(rod.id, null, fishing, hook.id)) if (group.weight > 0) {
        catchable.add(group.itemId);
        for (const fish of fishingSpeciesWeights(rod.id, group.rarity, fishing, hook.id)) if (fish.weight > 0) catchable.add(fish.itemId);
      }
  const unlocked = (source: { requiredHomeLevel: number; requiredBuildings: Record<string, number> }) =>
    (state.buildings.home ?? 1) >= source.requiredHomeLevel && Object.entries(source.requiredBuildings).every(([id, level]) => (state.buildings[id] ?? 0) >= level);
  let changed = true;
  while (changed) {
    const before = reachable.size;
    for (const source of [...catalog.explorations, ...catalog.recipes]) {
      if (source.retired) continue;
      if (!unlocked(source) || "buildingId" in source && (state.buildings[source.buildingId] ?? 0) < recipeBuildingLevel(source)) continue;
      if ("requiredRecipes" in source && Object.entries(source.requiredRecipes).some(([id, count]) => (state.progression?.recipes[id] ?? 0) < count)) continue;
      const fishInput = "fishInput" in source ? source.fishInput?.itemIds.map(id => source.fishInput?.exactSpecies ? id : fishing ? fishingClassItemId(id, fishing) : id) : undefined;
      if (Object.keys(source.cost.items).some(id => { const key = "fishInput" in source && !source.fishInput?.exactSpecies && fishing ? fishingClassItemId(id, fishing) : id; return !reachable.has(key) && !fishInput?.includes(key); })) continue;
      if (fishInput && !fishInput.some(id => reachable.has(id))) continue;
      const fishingRoute = fishing?.routeIds.includes(source.id);
      for (const [id, quantity] of Object.entries(source.rewards)) if (quantity > 0 && (!fishingRoute || id !== "fish"))
        reachable.add(fishing ? fishingClassItemId(id, fishing) : id);
      if (fishingRoute) for (const itemId of catchable) reachable.add(itemId);
    }
    changed = reachable.size > before;
  }
  return reachable;
}


export type OrderEffort = { effortSeconds: number; manufacturingSeconds: number; criticalPathSeconds: number; fishingUncertain: boolean; obtainable: boolean };
/** Approximate work from zero stock with the player's available technology.
 * Work across stations can overlap; expected catches never promise a deadline.
 * Separate displayed work from authored, frozen reputation and coin rewards. */
export function orderEffort(state: OrderEffortSource, items: Record<string, number>, catalog = state.catalog ?? economyCatalog): OrderEffort {
  const reachable = obtainableResidentOrderItems(state, catalog), tackle = fishingState(state), fishing = catalog.fishing;
  type Plan = { work: number; manufacturing: number; critical: number; uncertain: boolean };
  const sourceUnlocked = (source: { requiredHomeLevel: number; requiredBuildings: Record<string, number> }) =>
    (state.buildings.home ?? 1) >= source.requiredHomeLevel && Object.entries(source.requiredBuildings).every(([id, level]) => (state.buildings[id] ?? 0) >= level);
  const recipes = catalog.recipes.filter(recipe => !recipe.retired && sourceUnlocked(recipe) && (state.buildings[recipe.buildingId] ?? 0) >= recipeBuildingLevel(recipe)
    && Object.entries(recipe.requiredRecipes).every(([id, count]) => (state.progression?.recipes[id] ?? 0) >= count));
  const routes = catalog.explorations.filter(route => !route.retired && sourceUnlocked(route));
  const memo = new Map<string, Plan | null>();
  function plan(itemId: string, quantity: number, path: string[]): Plan | null {
    if (quantity <= 0) return { work: 0, manufacturing: 0, critical: 0, uncertain: false };
    if (path.includes(itemId) || !reachable.has(itemId)) return null;
    // Alternatives can revisit an ancestor through provisions or packaging.
    // A plan rejected inside that path is not unavailable to another target.
    const key = JSON.stringify([itemId, quantity, [...path].sort()]);
    if (memo.has(key)) return memo.get(key) ?? null;
    const choices: Plan[] = [];
    for (const source of [...recipes, ...routes]) {
      const isRecipe = "buildingId" in source;
      const isFishing = !isRecipe && fishing?.routeIds.includes(source.id);
      const reward = source.rewards[itemId] ?? 0;
      let expectedYield = reward, uncertain = false;
      if (isFishing && fishing && fishClassForItem(itemId, fishing)) {
        const draws = fishingCollectionDraws(source.id, fishing), species = fishing.fish.some(fish => fish.itemId === itemId);
        const gear = fishing.rods.filter(rod => tackle.ownedRods.includes(rod.id)).flatMap(rod =>
          fishing.hooks.filter(hook => tackle.ownedHooks.includes(hook.id)).map(hook => ({ rod, hook })));
        const probabilities = gear.map(({ rod, hook }) => {
          const groups = fishingClassWeights(rod.id, null, fishing, hook.id), total = groups.reduce((sum, group) => sum + group.weight, 0);
          const weight = species ? fishingWeights(rod.id, null, fishing, hook.id).find(fish => fish.itemId === itemId)?.weight ?? 0
            : groups.find(group => group.itemId === itemId)?.weight ?? 0;
          return total ? weight / total : 0;
        });
        const bestProbability = Math.max(0, ...probabilities);
        expectedYield = (!species && itemId === fishing.classes.find(group => group.rarity === "common")?.itemId
          ? Math.max(0, (source.rewards.fish ?? 0) - draws) : 0) + draws * bestProbability;
        uncertain = bestProbability > 0 && bestProbability < 1;
      }
      if (expectedYield <= 0) continue;
      const batches = Math.ceil(quantity / expectedYield), seconds = source.seconds * batches;
      const prerequisites: Plan[] = [];
      let valid = true;
      for (const [input, count] of Object.entries(source.cost.items)) {
        const candidates = (isRecipe && source.fishInput?.itemIds.includes(input) ? source.fishInput.itemIds : [input])
          .map(id => isRecipe && !source.fishInput?.exactSpecies && fishing ? fishingClassItemId(id, fishing) : id);
        const options = candidates.flatMap(id => { const result = plan(id, count * batches, [...path, itemId]); return result ? [result] : []; });
        options.sort((a, b) => a.work - b.work || a.critical - b.critical);
        if (!options.length) { valid = false; break; }
        prerequisites.push(options[0]);
      }
      if (!valid) continue;
      const collection = isRecipe && source.collection ? source.collection.seconds * batches : 0;
      choices.push({ work: seconds + collection + prerequisites.reduce((sum, input) => sum + input.work, 0),
        manufacturing: (isRecipe && Object.keys(source.cost.items).length ? seconds : 0) + prerequisites.reduce((sum, input) => sum + input.manufacturing, 0),
        critical: seconds + collection + Math.max(0, ...prerequisites.map(input => input.critical)),
        uncertain: uncertain || prerequisites.some(input => input.uncertain) });
    }
    choices.sort((a, b) => a.work - b.work || a.critical - b.critical);
    const best = choices[0] ?? null;
    memo.set(key, best);
    return best;
  }
  const plans = Object.entries(items).map(([itemId, quantity]) => plan(itemId, quantity, []));
  const obtainable = plans.every((value): value is Plan => value !== null);
  return { effortSeconds: Math.ceil(plans.reduce((sum, value) => sum + (value?.work ?? 0), 0)),
    manufacturingSeconds: Math.ceil(plans.reduce((sum, value) => sum + (value?.manufacturing ?? 0), 0)),
    criticalPathSeconds: Math.ceil(Math.max(0, ...plans.map(value => value?.critical ?? 0))),
    fishingUncertain: plans.some(value => value?.uncertain), obtainable };
}
