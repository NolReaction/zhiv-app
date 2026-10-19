import { fishClassForItem, fishingClassItemId, fishingIneligibility } from "./fishing";
import { economyCatalog, recipeBuildingLevel, type EconomyCatalog, type EconomyMarketListing, type EconomyState } from "./model";
import { unlockedEconomyItems, type ItemUnlockSource } from "./item-unlocks";

/** Only confirmed restoration opens trade; paid, ready and unclaimed jobs do not. */
export function economyMarketUnlocked(state: Pick<EconomyState, "buildings" | "completedExplorations">, catalog: EconomyCatalog = economyCatalog): boolean {
  return (state.buildings.home ?? 1) >= catalog.market.requiredHomeLevel
    && state.completedExplorations >= catalog.market.requiredExplorations
    && Object.entries(catalog.market.requiredBuildings).every(([id, level]) => (state.buildings[id] ?? 0) >= level);
}

/** Catalog source threshold for descriptions; permanent discovery controls actual trades. */
export function marketRequiredHomeLevel(itemId: string, catalog: EconomyCatalog = economyCatalog): number {
  const buildingHome = (id: string, level: number, seen = new Set<string>()): number => {
    if (id === "dryer" && level === 0) return 1;
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
      { ...recipe.requiredBuildings, [recipe.buildingId]: Math.max(recipeBuildingLevel(recipe), recipe.requiredBuildings[recipe.buildingId] ?? 0) })),
    ...catalog.explorations.filter(route => (route.rewards[itemId] ?? 0) > 0).map(route => requirements(route.requiredHomeLevel, route.requiredBuildings)),
  ];
  const bait = catalog.fishing?.baits.find(item => item.itemId === itemId);
  if (bait) sources.push(bait.requiredHomeLevel);
  const group = catalog.fishing && fishClassForItem(itemId, catalog.fishing);
  if (group && catalog.fishing) {
    const fishing = catalog.fishing;
    const gearHomes = fishing.rods.flatMap(rod => fishing.hooks.flatMap(hook =>
      fishing.fish.some(fish => fish.rarity === group.rarity && !fishingIneligibility(fish, rod.id, hook.id, fishing))
        ? [Math.max(rod.requiredHomeLevel, hook.requiredHomeLevel)] : []));
    const tackleHome = Math.min(...gearHomes);
    for (const route of catalog.explorations.filter(route => fishing.routeIds.includes(route.id)))
      sources.push(Math.max(tackleHome, requirements(route.requiredHomeLevel, route.requiredBuildings)));
  }
  return Math.min(...sources);
}

/** The full catalog value prevents buying a cheap lot and minting coins at either NPC. */
export function marketMinimumPrice(itemId: string, quantity: number, catalog: EconomyCatalog = economyCatalog): number {
  const item = catalog.items.find(item => item.id === itemId && item.tradable);
  return item && Number.isSafeInteger(quantity) && quantity > 0 ? item.baseSellPrice * quantity : Infinity;
}

export function marketItemUnlocked(state: ItemUnlockSource, itemId: string, catalog: EconomyCatalog = economyCatalog): boolean {
  return unlockedEconomyItems(state, [], catalog).includes(fishingClassItemId(itemId, catalog.fishing));
}

export function marketListingEligible(listing: Pick<EconomyMarketListing, "itemId" | "quantity" | "totalPrice">, state: ItemUnlockSource, catalog: EconomyCatalog = economyCatalog): boolean {
  const minimum = marketMinimumPrice(listing.itemId, listing.quantity, catalog);
  return marketItemUnlocked(state, listing.itemId, catalog) && listing.totalPrice >= minimum
    && listing.totalPrice <= minimum * catalog.market.maxPriceMultiplier;
}

export function marketSlotCount(state: Pick<EconomyState, "marketSlots">, catalog = economyCatalog): number {
  const slots = state.marketSlots;
  return Number.isInteger(slots) ? Math.max(catalog.market.baseSlots, Math.min(catalog.market.maxListings, slots!)) : catalog.market.baseSlots;
}
export function marketSlotOffer(state: Pick<EconomyState, "marketSlots">, catalog = economyCatalog):
  { slots: number; targetId: string; pricePearls: number } | null {
  const slots = marketSlotCount(state, catalog) + 1;
  const pricePearls = catalog.market.slotPricesPearls[slots - catalog.market.baseSlots - 1];
  return slots <= catalog.market.maxListings && pricePearls ? { slots, targetId: `market:${slots}`, pricePearls } : null;
}

/** One trading pool for every unlocked settlement; item discovery remains individual. */
export function marketHomeRange(home: number): { min: number; max: number } {
  return Number.isInteger(home) && home >= 2 && home <= 5 ? { min: 2, max: 5 } : { min: 1, max: 1 };
}
export function marketCanTrade(buyerHome: number, sellerHome: number): boolean {
  const band = marketHomeRange(buyerHome);
  return Number.isInteger(buyerHome) && Number.isInteger(sellerHome) && buyerHome >= 2 && buyerHome <= 5
    && sellerHome >= band.min && sellerHome <= band.max;
}

/** Persisted selections from the old, longer refresh interval cannot extend today's lease. */
export function marketShowcaseCurrent(refreshAt: number, now: number, catalog: EconomyCatalog = economyCatalog): boolean {
  return Number.isFinite(refreshAt) && Number.isFinite(now) && refreshAt > now
    && refreshAt <= now + catalog.market.showcaseRefreshSeconds * 1000;
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
