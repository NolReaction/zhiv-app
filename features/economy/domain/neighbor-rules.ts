import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_ITEMS, economyCatalog, type EconomyCatalog, type EconomyMarketListing, type EconomyState } from "./model";
import { economyMarketUnlocked, marketDay, marketItemUnlocked, marketListingEligible } from "./market-rules";
import type { NeighborSettings } from "./neighbor-model";

export type NeighborUsage = { day: string; usedLots: number; spentCoins: number };
export const freshNeighborUsage = (now: number): NeighborUsage => ({ day: marketDay(now), usedLots: 0, spentCoins: 0 });
export function neighborActiveHour(settings: NeighborSettings, now: number): boolean {
  const hour = new Date(now).getUTCHours(), from = settings.activeFromHourUtc, until = settings.activeUntilHourUtc;
  return from < until ? hour >= from && hour < until : hour >= from || hour < until;
}
/** Use exact integer arithmetic even when an administrator chooses a very large multiplier. */
function quote(unitPrice: number, quantity: number, bps: number, roundUp: boolean): bigint | null {
  if (![unitPrice, quantity, bps].every(Number.isSafeInteger) || unitPrice < 0 || quantity < 1
    || quantity > ECONOMY_MAX_ITEMS || bps < 0) return null;
  const numerator = BigInt(unitPrice) * BigInt(quantity) * BigInt(bps);
  return ((numerator + (roundUp ? BigInt(99999) : BigInt(0))) / BigInt(100000)) * BigInt(10);
}
/** Default pricing covers resale; an administrator can deliberately configure cheaper or free stock. */
export function neighborOfferPrice(itemId: string, quantity: number, settings: NeighborSettings): number {
  const item = economyCatalog.items.find(item => item.id === itemId && item.tradable);
  if (!item) return Infinity;
  const unitPrice = Math.max(item.baseSellPrice, economyCatalog.localBuyer?.unitPrices?.[itemId] ?? 0);
  const value = quote(unitPrice, quantity, settings.sellPriceBps, true);
  return value !== null && value <= BigInt(ECONOMY_MAX_BALANCE) ? Number(value) : Infinity;
}
/** Seller market limits still apply; rounding down preserves the administrator's maximum quote. */
export function neighborBuyPriceCeiling(itemId: string, quantity: number, settings: Pick<NeighborSettings, "buyPriceBps">,
  catalog: EconomyCatalog = economyCatalog): number {
  const item = catalog.items.find(item => item.id === itemId && item.tradable);
  if (!item) return 0;
  const value = quote(item.baseSellPrice, quantity, settings.buyPriceBps, false);
  if (value === null) return 0;
  // Repeatable supplies from other residents cannot fund a subsidised resale loop.
  // Use the best possible discount, not the seller's current rank or activity.
  const acquisition = neighborCheapestUnitAcquisition(itemId, catalog);
  const acquisitionCap = Number.isFinite(acquisition) ? BigInt(acquisition) * BigInt(quantity) / BigInt(10) * BigInt(10) : null;
  return Number([value, BigInt(ECONOMY_MAX_BALANCE), ...(acquisitionCap === null ? [] : [acquisitionCap])]
    .reduce((minimum, candidate) => candidate < minimum ? candidate : minimum));
}
/** Gross buyback cannot exceed even the cheapest discounted resident supply. */
export function neighborCheapestUnitAcquisition(itemId: string, catalog: EconomyCatalog = economyCatalog): number {
  const prices: number[] = [];
  const discount = Math.min(catalog.tradeRelations?.maxBonusBps ?? 0,
    Math.max(0, ...(catalog.tradeRelations?.ranks ?? []).map(rank => rank.bonusBps)));
  const discounted = (price: number) => Math.ceil(price * (10000 - discount) / 10000);
  const bait = catalog.fishing?.baits.find(item => item.itemId === itemId);
  if (bait) prices.push(Math.max(1, discounted(bait.price)));
  const shop = catalog.leaftailShop;
  for (const offer of shop?.supplyOffers ?? []) if (offer.itemId === itemId) prices.push(offer.unitPriceCoins);
  // Legacy bundles remain a possible source only while the catalog still uses them.
  for (const offer of [...(shop?.supplyOffers?.length ? [] : shop?.offers ?? []), ...(shop?.travelOffers ?? [])]) {
    if (offer.itemId !== itemId || offer.kind && !["item", "bait"].includes(offer.kind)) continue;
    const quantity = offer.quantity ?? 1;
    const unitSales = Boolean(shop?.supplyOffers?.length || shop?.pearlOffers?.length);
    const price = unitSales ? offer.priceCoins / quantity : offer.priceCoins;
    const paid = offer.kind === "bait" ? Math.max(1, discounted(price)) : price;
    prices.push(unitSales ? paid : Math.floor(paid / quantity));
  }
  return Math.min(...prices);
}
export function neighborOfferItems(state: EconomyState, settings: NeighborSettings): string[] {
  return settings.allowedItemIds.filter(id => marketItemUnlocked(state, id) && Number.isFinite(neighborOfferPrice(id, settings.offerQuantity, settings)));
}
export function neighborShopReason(state: EconomyState, settings: NeighborSettings): string | null {
  return !settings.enabled ? "paused" : !economyMarketUnlocked(state) ? "market_locked" : null;
}
/** Pure quote used by both the periodic task and the administrator's transaction. */
export function neighborListingReason(listing: Pick<EconomyMarketListing, "itemId" | "quantity" | "totalPrice" | "status" | "createdAt">,
  state: EconomyState, settings: NeighborSettings, context: { now: number; firstSale: boolean; usage: NeighborUsage; globalSpentCoins: number; boughtItemIds: readonly string[]; manual?: boolean }): string | null {
  if (!settings.enabled) return "paused";
  if (!context.manual && !settings.autoBuyEnabled) return "auto_paused";
  if (!neighborActiveHour(settings, context.now)) return "outside_hours";
  if (listing.status !== "active") return "not_active";
  if (!economyMarketUnlocked(state)) return "market_locked";
  if (!settings.allowedItemIds.includes(listing.itemId) || !marketListingEligible(listing, state)) return "item_unavailable";
  if (context.boughtItemIds.includes(listing.itemId)) return "shop_resale";
  if (listing.totalPrice > settings.maxLotCoins || listing.totalPrice > neighborBuyPriceCeiling(listing.itemId, listing.quantity, settings)) return "price_too_high";
  const age = context.now - Date.parse(listing.createdAt);
  if (!Number.isFinite(age) || age < 0) return "invalid_age";
  if (!context.manual && age / 1000 < (context.firstSale ? settings.firstDelaySeconds : settings.staleAfterSeconds)) return "too_early";
  if (context.usage.usedLots >= settings.maxLotsPerDay) return "lots_limit";
  if (listing.totalPrice > settings.dailyBudgetCoins - context.usage.spentCoins) return "daily_budget";
  if (listing.totalPrice > settings.globalDailyBudgetCoins - context.globalSpentCoins) return "global_budget";
  return null;
}
