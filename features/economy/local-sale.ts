import { ECONOMY_MAX_BALANCE } from "./model";

type LocalBuyerConfig = { payoutBps: number } | null | undefined;
/** Floor the WHOLE stack once: splitting a sale can never improve its proceeds.
 * Quotient/remainder avoids unsafe intermediate products for the largest commands. */
export function economyLocalSellPrice(basePrice: number, quantity = 1, config?: LocalBuyerConfig): number {
  if (!Number.isSafeInteger(quantity) || quantity < 0) return 0;
  const total = basePrice * quantity, rate = config?.payoutBps ?? 10_000;
  return Math.floor(total / 10_000) * rate + Math.floor(total % 10_000 * rate / 10_000);
}
export function economyLocalSaleMinimumQuantity(basePrice: number, config?: LocalBuyerConfig): number {
  return Math.max(1, Math.ceil(10_000 / (basePrice * (config?.payoutBps ?? 10_000))));
}
/** Largest legal stack with a nonzero payout that fits the actual wallet headroom. */
export function economyLocalSaleLimit(basePrice: number, stock: number, walletCoins: number, config?: LocalBuyerConfig): number {
  let low = 0, high = Math.max(0, Math.min(stock, 10_000));
  const headroom = ECONOMY_MAX_BALANCE - walletCoins;
  while (low < high) {
    const quantity = Math.ceil((low + high) / 2);
    if (economyLocalSellPrice(basePrice, quantity, config) <= headroom) low = quantity;
    else high = quantity - 1;
  }
  return low >= economyLocalSaleMinimumQuantity(basePrice, config) ? low : 0;
}
