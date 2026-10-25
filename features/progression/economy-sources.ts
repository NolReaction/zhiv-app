import { economyCatalog, recipeBuildingLevel, type EconomyCatalog, type EconomyCost } from "@/features/economy/domain/model";

export type ProductionSource = {
  id: string; kind: "recipe" | "exploration"; name: string; stationId: string;
  seconds: number; collectionSeconds: number; cost: EconomyCost; rewards: Record<string, number>;
  homeLevel: number; requiredBuildings: Record<string, number>; requiredRecipes: Record<string, number>;
  retired: boolean;
};
export type ProductionAccess = { buildings?: Record<string, number>; completedRecipes?: Record<string, number> };
export type TimeEconomyPolicy = {
  coinsPerMinute: number; orderBonusBps: number;
  baselineRecipes: Record<string, string>; baselineExplorations: Record<string, string>; externalPrices: Record<string, number>;
};
export function timeEconomyPolicy(catalog: EconomyCatalog): TimeEconomyPolicy | undefined {
  return (catalog as EconomyCatalog & { timeEconomy?: TimeEconomyPolicy }).timeEconomy;
}
export function sourceRetired(source: object): boolean {
  return "retired" in source && source.retired === true;
}

/** Representative completed buildings, not a claim about the player's progress.
 * Every prerequisite must fit before the next level can be included. */
export function buildingsAtHomeLevel(homeLevel: number, catalog: EconomyCatalog = economyCatalog): Record<string, number> {
  if (!Number.isSafeInteger(homeLevel) || homeLevel < 1 || homeLevel > 5) throw new RangeError("Home level must be 1–5");
  const result: Record<string, number> = { home: homeLevel };
  for (let pass = 0; pass < 100; pass++) {
    let changed = false;
    for (const building of catalog.buildings) {
      if (building.id === "home") continue;
      const next = building.levels.find(level => level.level === (result[building.id] ?? 0) + 1);
      if (!next || next.requiredHomeLevel > homeLevel || Object.entries(next.requiredBuildings).some(([id, level]) => (result[id] ?? 0) < level)) continue;
      result[building.id] = next.level; changed = true;
    }
    if (!changed) return result;
  }
  throw new RangeError("Building requirements did not settle");
}

export function productionSources(catalog: EconomyCatalog = economyCatalog): ProductionSource[] {
  const homes = Array.from({ length: 5 }, (_, index) => buildingsAtHomeLevel(index + 1, catalog));
  const earliest = (home: number, requirements: Record<string, number>) => {
    const index = homes.findIndex((buildings, index) => index + 1 >= home && Object.entries(requirements).every(([id, level]) => (buildings[id] ?? 0) >= level));
    return index < 0 ? 6 : index + 1;
  };
  return [
    ...catalog.recipes.map(recipe => {
      const requiredBuildings = { ...recipe.requiredBuildings, [recipe.buildingId]: Math.max(recipeBuildingLevel(recipe), recipe.requiredBuildings[recipe.buildingId] ?? 0) };
      return { id: `recipe:${recipe.id}`, kind: "recipe" as const, name: recipe.name, stationId: recipe.buildingId,
        seconds: recipe.seconds, collectionSeconds: recipe.collection?.seconds ?? 0,
        cost: { coins: recipe.cost.coins, items: { ...recipe.cost.items } }, rewards: { ...recipe.rewards },
        homeLevel: earliest(recipe.requiredHomeLevel, requiredBuildings), requiredBuildings,
        requiredRecipes: { ...recipe.requiredRecipes }, retired: sourceRetired(recipe) };
    }),
    ...catalog.explorations.filter(route => !catalog.fishing?.routeIds.includes(route.id)).map(route => ({
      id: `exploration:${route.id}`, kind: "exploration" as const, name: route.name,
      stationId: route.activity === "mining" ? "quarry" : "hero", seconds: route.seconds, collectionSeconds: 0,
      cost: { coins: route.cost.coins, items: { ...route.cost.items } }, rewards: { ...route.rewards },
      homeLevel: earliest(route.requiredHomeLevel, route.requiredBuildings), requiredBuildings: { ...route.requiredBuildings },
      requiredRecipes: {}, retired: sourceRetired(route),
    })),
  ];
}

export function sourceAvailable(source: ProductionSource, access: ProductionAccess): boolean {
  if (source.retired || source.homeLevel > 5) return false;
  if (access.buildings && ((access.buildings.home ?? 1) < source.homeLevel
    || Object.entries(source.requiredBuildings).some(([id, level]) => (access.buildings![id] ?? 0) < level))) return false;
  if ((access.completedRecipes || access.buildings) && Object.entries(source.requiredRecipes)
    .some(([id, count]) => (access.completedRecipes?.[id] ?? 0) < count)) return false;
  return true;
}

/** Explicit policy baseline wins; alternatives remain visible and selectable.
 * Without metadata choose the earliest sustainable source, never a future fast recipe. */
export function sortItemSources(itemId: string, sources: ProductionSource[], catalog: EconomyCatalog): ProductionSource[] {
  const policy = timeEconomyPolicy(catalog);
  const baseline = policy?.baselineRecipes[itemId] ? `recipe:${policy.baselineRecipes[itemId]}`
    : policy?.baselineExplorations[itemId] ? `exploration:${policy.baselineExplorations[itemId]}` : undefined;
  return sources.filter(source => (source.rewards[itemId] ?? 0) > 0 && !source.retired).sort((a, b) =>
    Number(b.id === baseline) - Number(a.id === baseline) || a.homeLevel - b.homeLevel
    || Object.keys(a.requiredRecipes).length - Object.keys(b.requiredRecipes).length
    || Number(b.kind === "recipe") - Number(a.kind === "recipe") || a.id.localeCompare(b.id));
}
