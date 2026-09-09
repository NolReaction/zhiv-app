import { isTimeZone } from "@/lib/time-zone";

/** Civil time in the profile timezone; no location permission or sunrise lookup. */
export function habitatLighting(nowMs: number, timeZone: string) {
  const zone = isTimeZone(timeZone) ? timeZone : "UTC";
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, hour: "2-digit", hourCycle: "h23",
  }).format(Number.isFinite(nowMs) ? nowMs : 0));
  const dusk = hour >= 19 || hour < 7;
  return { dusk, lampOn: dusk };
}
