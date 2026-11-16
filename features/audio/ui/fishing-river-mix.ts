import { isTimeZone } from "@/lib/time-zone";

export type FishingRiverAmbience = { now: number; timeZone: string };
type RiverClock = { format: Intl.DateTimeFormat; minute?: number; night?: number };
const clocks = new Map<string, RiverClock>();
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** Civil profile time controls only the sound mix; it never consults game draws or location. */
export function fishingRiverNightBlend(ambience?: FishingRiverAmbience): number {
  if (!ambience || !Number.isFinite(ambience.now) || Math.abs(ambience.now) > 8.64e15) return 0;
  let clock = clocks.get(ambience.timeZone);
  if (!clock) {
    const zone = isTimeZone(ambience.timeZone) ? ambience.timeZone : "UTC";
    clock = { format: new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) };
    if (clocks.size >= 4) clocks.delete(clocks.keys().next().value!);
    clocks.set(ambience.timeZone, clock);
  }
  const minute = Math.floor(ambience.now / 60000);
  if (clock.minute === minute && clock.night !== undefined) return clock.night;
  const parts = clock.format.formatToParts(ambience.now);
  const hour = Number(parts.find(part => part.type === "hour")?.value ?? 12) + Number(parts.find(part => part.type === "minute")?.value ?? 0) / 60;
  const night = hour < 5 || hour >= 21 ? 1 : hour < 8 ? 1 - smooth((hour - 5) / 3) : hour < 18 ? 0 : smooth((hour - 18) / 3);
  clock.minute = minute; clock.night = Math.round(night * 1000) / 1000;
  return clock.night;
}
