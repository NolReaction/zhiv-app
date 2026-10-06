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
  const minimum = marketMinimumPrice(listing.itemId, listing.quantity, catalog);
  return homeLevel >= marketRequiredHomeLevel(listing.itemId, catalog) && listing.totalPrice >= minimum
    && listing.totalPrice <= minimum * catalog.market.maxPriceMultiplier;
}

/** Match current progression, never the level captured when a lot was posted. */
export function marketHomeBand(home: number): { min: number; max: number } {
  return home === 4 || home === 5 ? { min: 4, max: 5 } : home === 2 || home === 3 ? { min: 2, max: 3 } : { min: 1, max: 1 };
}
export function marketSameHomeBand(buyerHome: number, sellerHome: number): boolean {
  const band = marketHomeBand(buyerHome);
  return Number.isInteger(buyerHome) && Number.isInteger(sellerHome) && buyerHome >= 2 && buyerHome <= 5
    && sellerHome >= band.min && sellerHome <= band.max;
}
export function marketDailyLimit(home: number, catalog: EconomyCatalog = economyCatalog): number {
  return catalog.market.dailyTradeValueByHome[home - 1] ?? 0;
}
/** Round the fee up once per lot; splitting cannot eliminate the fee. */
export function marketSaleFee(totalPrice: number, feeBps: number): number {
  return Math.ceil(totalPrice * feeBps / 10000);
}
export function marketDay(now: number): string { return new Date(now).toISOString().slice(0, 10); }
export function marketBudgetReset(now: number): string {
  return new Date(Date.parse(`${marketDay(now)}T00:00:00Z`) + 86400000).toISOString();
}
