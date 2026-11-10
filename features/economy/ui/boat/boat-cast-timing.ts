import type { BoatChallenge } from "@/features/economy/domain/boat-model";

/** Presentation follows server timestamps. Older saved attempts had no waiting phase. */
export function boatCastStage(challenge: BoatChallenge, now: number): "casting" | "soaking" | "bite" {
  const biteAt = Date.parse(challenge.biteAt ?? challenge.startedAt);
  if (now >= biteAt) return "bite";
  return now < Math.min(Date.parse(challenge.startedAt) + 1200, biteAt) ? "casting" : "soaking";
}

/** A tap lands near the boat. Holding for one second reaches the far end of the swim. */
export function boatCastPower(heldMs: number) {
  return Math.max(15, Math.min(100, Math.round(15 + heldMs * .085)));
}
