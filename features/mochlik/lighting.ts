import { isTimeZone } from "@/lib/time-zone";

const clocks = new Map<string, Intl.DateTimeFormat>();

/** Quantized profile hour; UI options refresh only when that hour changes. */
export function habitatLocalHour(nowMs: number, timeZone: string): number {
  const zone = isTimeZone(timeZone) ? timeZone : "UTC";
  let clock = clocks.get(zone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" });
    if (clocks.size >= 4) clocks.delete(clocks.keys().next().value!);
    clocks.set(zone, clock);
  }
  return Number(clock.format(Number.isFinite(nowMs) ? nowMs : 0));
}

/** Civil time in the profile timezone; no location permission or sunrise lookup. */
export function habitatLighting(nowMs: number, timeZone: string) {
  const hour = habitatLocalHour(nowMs, timeZone);
  const dusk = hour >= 19 || hour < 7;
  return { dusk, lampOn: dusk };
}
