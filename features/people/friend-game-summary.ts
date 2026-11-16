import type { FriendGameSummary, FriendMarketPreview } from "@/lib/check-in-contract";
import type { EconomyState } from "@/features/economy/domain/model";
import { economyMarketUnlocked, marketCanTrade, marketListingEligible } from "@/features/economy/domain/market-rules";
import { getPlayerLevel } from "@/features/economy/domain/player-levels";

/** Safe, read-only card projection. Callers supply active lots in newest-first order
 * and a buyer state with legacy discovery already projected. */
export function friendGameSummary(seller: EconomyState | undefined, buyer: EconomyState | undefined,
  worldVisible: boolean, activeListings: readonly FriendMarketPreview[]): FriendGameSummary {
  const reason = !worldVisible ? "world_hidden" : !buyer || !economyMarketUnlocked(buyer) ? "buyer_locked"
    : !seller || !economyMarketUnlocked(seller) ? "seller_locked"
    : !marketCanTrade(buyer.buildings.home ?? 1, seller.buildings.home ?? 1) ? "home_band" : null;
  const visible = reason === null && buyer ? activeListings.filter(listing => Number.isSafeInteger(listing.quantity)
    && listing.quantity >= 1 && listing.quantity <= 99 && Number.isSafeInteger(listing.totalPrice)
    && marketListingEligible(listing, buyer)) : [];
  return { level: getPlayerLevel(seller?.progression.player?.xp ?? 0).level, market: { available: reason === null, reason,
    count: visible.length, listings: visible.slice(0, 3).map(({ id, itemId, quantity, totalPrice }) => ({ id, itemId, quantity, totalPrice })) } };
}
