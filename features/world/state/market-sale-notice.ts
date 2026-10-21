import type { EconomyMarketListing, MarketView } from "@/features/economy/domain/model";

export const WORLD_MARKET_POLL_MS = 30_000;

/** Only the owner's confirmed, uncollected receipts can put a notice on their map. */
export function pendingMarketSales(owner: string, market: MarketView | null): readonly EconomyMarketListing[] {
  if (!owner || market?.ownerPublicId !== owner) return [];
  return market.mine.filter(lot => lot.owned && lot.status === "sold" && lot.sale?.claimedAt === null);
}

/** One lightweight market read on entry, then at most every 30 seconds while
 * the world is visible. The economy session owns deduplication and backoff. */
export function watchWorldMarketSales(refresh: () => Promise<void>) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  let disposed = false;
  const check = () => {
    if (!disposed && !document.hidden && (typeof navigator === "undefined" || navigator.onLine)) void refresh();
  };
  check();
  const timer = window.setInterval(check, WORLD_MARKET_POLL_MS);
  document.addEventListener("visibilitychange", check);
  window.addEventListener("online", check);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("online", check);
  };
}
