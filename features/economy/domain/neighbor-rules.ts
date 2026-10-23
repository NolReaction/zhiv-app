import { economyCatalog, type EconomyMarketListing, type EconomyState } from "./model";
import { economyMarketUnlocked, marketDay, marketItemUnlocked, marketListingEligible, marketMinimumPrice } from "./market-rules";
import type { NeighborSettings } from "./neighbor-model";

export type NeighborUsage = { day: string; usedLots: number; spentCoins: number };
export const freshNeighborUsage = (now: number): NeighborUsage => ({ day: marketDay(now), usedLots: 0, spentCoins: 0 });
export function neighborActiveHour(settings: NeighborSettings, now: number): boolean {
  const hour = new Date(now).getUTCHours(), from = settings.activeFromHourUtc, until = settings.activeUntilHourUtc;
  return from < until ? hour >= from && hour < until : hour >= from || hour < until;
}
const ceilCoins = (amount: number) => Math.ceil(amount / 10) * 10;
/** Retail always covers full immediate NPC resale value, including catalog overrides. */
export function neighborOfferPrice(itemId: string, quantity: number, settings: NeighborSettings): number {
  const minimum = marketMinimumPrice(itemId, quantity);
  const localPrice = economyCatalog.localBuyer?.unitPrices?.[itemId] ?? 0;
  return Number.isFinite(minimum) ? Math.max(ceilCoins(minimum * settings.sellPriceBps / 10000), ceilCoins(localPrice * quantity)) : Infinity;
}
/** Rounding down prevents a cheap stack's rounding from creating an arbitrage profit. */
export function neighborBuyPriceCeiling(itemId: string, quantity: number, settings: NeighborSettings): number {
  const minimum = marketMinimumPrice(itemId, quantity);
  return Number.isFinite(minimum) ? Math.floor(minimum * settings.buyPriceBps / 10000 / 10) * 10 : 0;
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
  if (!context.manual && age < (context.firstSale ? settings.firstDelaySeconds : settings.staleAfterSeconds) * 1000) return "too_early";
  if (context.usage.usedLots >= settings.maxLotsPerDay) return "lots_limit";
  if (context.usage.spentCoins + listing.totalPrice > settings.dailyBudgetCoins) return "daily_budget";
  if (context.globalSpentCoins + listing.totalPrice > settings.globalDailyBudgetCoins) return "global_budget";
  return null;
}
