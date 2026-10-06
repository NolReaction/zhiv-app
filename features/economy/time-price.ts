/** Whole stored units, rounded up by the shared catalog quantum. Mirrors EconomyTimePrice.kt.
 * Callers supply authoritative time on writes; browser use is only an upper-limit quote. */
export function remainingTimePearlPrice(finishesAt: string, now: number, periodSeconds: number, periodPrice: number, step: number): number {
  const remainingMs = Math.ceil(Math.max(0, Date.parse(finishesAt) - now));
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  const numerator = BigInt(remainingMs) * BigInt(periodPrice);
  const denominator = BigInt(periodSeconds) * BigInt(1000) * BigInt(step);
  return Number((numerator + denominator - BigInt(1)) / denominator * BigInt(step));
}
