/** Whole stored units, rounded up by the shared catalog quantum. Mirrors EconomyTimePrice.kt.
 * Callers supply authoritative time on writes; browser use is only an upper-limit quote. */
export type PearlPricePoint = { seconds: number; pearls: number };

/** Points and step use stored wallet units; ceil to step preserves whole visible pearls.
 * Beyond the last point the final segment continues, rather than charging a flat price. */
export function durationPearlPrice(milliseconds: number, periodSeconds: number, periodPrice: number, step: number,
  pricingPoints: readonly PearlPricePoint[] = []): number {
  const remainingMs = Math.ceil(Math.max(0, milliseconds));
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  const quantum = BigInt(step), remaining = BigInt(remainingMs);
  let numerator: bigint, denominator: bigint;
  if (pricingPoints.length >= 2) {
    const first = pricingPoints[0];
    if (remaining <= BigInt(first.seconds) * BigInt(1000)) {
      numerator = BigInt(first.pearls); denominator = BigInt(1);
    } else {
      const rightIndex = pricingPoints.findIndex(point => remaining <= BigInt(point.seconds) * BigInt(1000));
      const right = pricingPoints[rightIndex < 0 ? pricingPoints.length - 1 : rightIndex];
      const left = pricingPoints[rightIndex < 0 ? pricingPoints.length - 2 : rightIndex - 1];
      const leftMs = BigInt(left.seconds) * BigInt(1000);
      denominator = BigInt(right.seconds - left.seconds) * BigInt(1000);
      numerator = BigInt(left.pearls) * denominator + (remaining - leftMs) * BigInt(right.pearls - left.pearls);
    }
  } else {
    numerator = remaining * BigInt(periodPrice);
    denominator = BigInt(periodSeconds) * BigInt(1000);
  }
  const divisor = denominator * quantum;
  return Number((numerator + divisor - BigInt(1)) / divisor * quantum);
}

export function remainingTimePearlPrice(finishesAt: string, now: number, periodSeconds: number, periodPrice: number, step: number,
  pricingPoints: readonly PearlPricePoint[] = []): number {
  return durationPearlPrice(Date.parse(finishesAt) - now, periodSeconds, periodPrice, step, pricingPoints);
}
