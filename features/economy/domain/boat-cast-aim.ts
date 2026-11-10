/** The marker and both target waves repeat within this transmitted interval. */
export const BOAT_CAST_CYCLE_MS = 60_000;
export const BOAT_CAST_GREEN_RADIUS = 8;

function triangle(time: number, period: number, height: number) {
  const phase = time % period;
  return Math.floor(2 * height * Math.min(phase, period - phase) / period);
}

/** Integer arithmetic is shared with EconomyBoatAim.kt, including UTF-16 code units in voyage IDs. */
export function boatCastAim(voyageId: string, castNumber: number, heldMs: number) {
  let seed = 0;
  for (let i = 0; i < voyageId.length; i++) seed = (31 * seed + voyageId.charCodeAt(i)) % 65_521;
  seed = (seed + 977 * castNumber) % 65_521;

  const elapsed = Math.max(0, Math.floor(heldMs)) % BOAT_CAST_CYCLE_MS;
  const marker = triangle(elapsed, 2000, 100);
  const drift = triangle(elapsed + seed, 2400, 26);
  const ripple = triangle(elapsed + (seed % 251) * 19, 500, 6);
  const target = 48 + drift + ripple;
  const distance = Math.abs(marker - target);
  const quality = Math.max(0, 100 - 2 * distance - Math.max(0, distance - BOAT_CAST_GREEN_RADIUS));
  return { marker, target, quality, power: 15 + Math.round(85 * marker / 100) };
}
