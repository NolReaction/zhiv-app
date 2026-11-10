import { z } from "zod";
import config from "@/apps/api/src/main/resources/world/tap-boost-catalog.json";

export const TAP_BOOST_MAX_CHARGE = config.maxCharge;
export const TAP_BOOST_MAX_SECONDS = config.maxSeconds;
export const TAP_BOOST_SECONDS_PER_TAP = config.secondsPerTap;
export const TAP_BOOST_MAX_POWER_BPS = config.powerPoints.at(-1)!.powerBps;

export const economyTapBoostSchema = z.object({
  charge: z.number().int().min(0).max(TAP_BOOST_MAX_CHARGE).prefault(0),
  powerBps: z.number().int().min(0).max(TAP_BOOST_MAX_POWER_BPS).prefault(0),
  grantedAt: z.string().datetime().nullable().prefault(null),
  appliedAt: z.string().datetime().nullable().prefault(null),
  expiresAt: z.string().datetime().nullable().prefault(null),
  jobId: z.string().max(80).nullable().prefault(null),
});
export type EconomyTapBoost = z.infer<typeof economyTapBoostSchema>;
export function emptyTapBoost(): EconomyTapBoost {
  return { charge: 0, powerBps: 0, grantedAt: null, appliedAt: null, expiresAt: null, jobId: null };
}

/** An active charge grows with ordinary tapping; frequency cannot raise the cap. */
export function tapBoostPowerBps(charge: number): number {
  const points = config.powerPoints.map(point => [point.charge, point.powerBps]);
  const bounded = Math.max(0, Math.min(TAP_BOOST_MAX_CHARGE, Math.floor(charge)));
  for (let index = 1; index < points.length; index++) {
    const [end, power] = points[index], [start, prior] = points[index - 1];
    if (bounded <= end) return prior + Math.floor((power - prior) * (bounded - start) / (end - start));
  }
  return TAP_BOOST_MAX_POWER_BPS;
}
