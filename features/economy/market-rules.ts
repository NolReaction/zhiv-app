import { economyCatalog, type EconomyCatalog, type EconomyMarketListing, type EconomyState } from "./model";

/** A market purchase substitutes for a workshop, but cannot skip its home tier. */
export function marketRequiredHomeLevel(itemId: string, catalog: EconomyCatalog = economyCatalog): number {
  const buildingHome = (id: string, level: number, seen = new Set<string>()): number => {
    if (id === "home") return level;
    const key = `${id}:${level}`;
    if (seen.has(key)) return Infinity;
    const definition = catalog.buildings.find(item => item.id === id)?.levels.find(item => item.level === level);
    if (!definition) return Infinity;
    const path = new Set(seen).add(key);
    return Math.max(definition.requiredHomeLevel, ...Object.entries(definition.requiredBuildings)
      .map(([required, amount]) => buildingHome(required, amount, path)));
  };
  const requirements = (home: number, buildings: Record<string, number>) =>
    Math.max(home, ...Object.entries(buildings).map(([id, level]) => buildingHome(id, level)));
  const sources = [
    ...catalog.recipes.filter(recipe => (recipe.rewards[itemId] ?? 0) > 0).map(recipe => requirements(recipe.requiredHomeLevel,
      { ...recipe.requiredBuildings, [recipe.buildingId]: Math.max(recipe.buildingLevel, recipe.requiredBuildings[recipe.buildingId] ?? 0) })),
    ...catalog.explorations.filter(route => (route.rewards[itemId] ?? 0) > 0).map(route => requirements(route.requiredHomeLevel, route.requiredBuildings)),
  ];
  const bait = catalog.fishing?.baits.find(item => item.itemId === itemId);
  if (bait) sources.push(bait.requiredHomeLevel);
  const fish = catalog.fishing?.fish.find(item => item.itemId === itemId);
  if (fish) {
    const hookHome = fish.requiredHookId
      ? catalog.fishing?.hooks.find(hook => hook.id === fish.requiredHookId)?.requiredHomeLevel ?? Infinity : 1;
    for (const route of catalog.explorations.filter(route => catalog.fishing?.routeIds.includes(route.id)))
      sources.push(Math.max(hookHome, requirements(route.requiredHomeLevel, route.requiredBuildings)));
  }
  return Math.min(...sources);
}

/** The full catalog value prevents buying a cheap lot and minting coins at either NPC. */
export function marketMinimumPrice(itemId: string, quantity: number, catalog: EconomyCatalog = economyCatalog): number {
  const item = catalog.items.find(item => item.id === itemId && item.tradable);
  return item && Number.isSafeInteger(quantity) && quantity > 0 ? item.baseSellPrice * quantity : Infinity;
}

export function marketItemUnlocked(state: Pick<EconomyState, "buildings">, itemId: string, catalog: EconomyCatalog = economyCatalog): boolean {
  return (state.buildings.home ?? 1) >= marketRequiredHomeLevel(itemId, catalog);
}

export function marketListingEligible(listing: Pick<EconomyMarketListing, "itemId" | "quantity" | "totalPrice">, homeLevel: number, catalog: EconomyCatalog = economyCatalog): boolean {
  return homeLevel >= marketRequiredHomeLevel(listing.itemId, catalog) && listing.totalPrice >= marketMinimumPrice(listing.itemId, listing.quantity, catalog);
}
