import type { BoatChallenge } from "@/features/economy/domain/boat-model";

export const BOAT_CAST_MIN_HOLD_MS = 280;
export const BOAT_CAST_RESULT_MS = 3200;

/** Presentation follows server timestamps. Older saved attempts had no waiting phase. */
export function boatCastStage(challenge: BoatChallenge, now: number): "casting" | "soaking" | "bite" {
  const biteAt = Date.parse(challenge.biteAt ?? challenge.startedAt);
  if (now >= biteAt) return "bite";
  return now < Math.min(Date.parse(challenge.startedAt) + 1200, biteAt) ? "casting" : "soaking";
}
