type Resident = "lopukh" | "kamneshmyg" | "leaftail" | "plesk" | "builder";

/** Personal rest windows use the existing active scene clock, never wall-time
 * catch-up. A paused scene or a different camera reads the same routine. */
const evenings: Record<Resident, { start: number; duration: number }> = {
  lopukh: { start: 170, duration: 150 },
  kamneshmyg: { start: 45, duration: 220 },
  leaftail: { start: 280, duration: 120 },
  plesk: { start: 110, duration: 170 },
  builder: { start: 230, duration: 160 },
};
const eveningHour = (hour?: number) => Number.isInteger(hour) && hour! >= 19 && hour! <= 23;

export function residentNightRest(id: Resident, elapsed: number, dusk: number | boolean, localHour?: number): boolean {
  if (Number(dusk) < .6) return false;
  // Callers without a profile clock (including explicit DEV night) retain a
  // genuine night. After midnight everyone may sleep, unless real work calls.
  if (!eveningHour(localHour)) return true;
  const clock = Number.isFinite(elapsed) ? Math.max(0, elapsed) % 420 : 0;
  const { start, duration } = evenings[id];
  return clock >= start && clock < start + duration;
}

export function residentEveningActive(id: Resident, elapsed: number, dusk: number | boolean, localHour?: number): boolean {
  return Number(dusk) >= .6 && eveningHour(localHour) && !residentNightRest(id, elapsed, dusk, localHour);
}
