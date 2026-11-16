import type { EconomyView } from "@/features/economy/domain/model";
import { tapBoostView } from "@/features/economy/domain/tap-boost";
import { TAP_BOOST_MAX_SECONDS } from "@/features/economy/domain/tap-boost-model";

export const TAP_BOOST_MILESTONES = [5, 10, 15, 20] as const;
export type TapOrbitReading = {
  ownerKey: string; known: boolean; active: boolean; jobId: string | null; hasJob: boolean;
  finished: boolean; targetName: string; charge: number; powerPercent: number;
  grantedAt: number; expiresAt: number; remainingRatio: number;
};
export type TapOrbitMemory = TapOrbitReading & { highestStep: number };
export type TapOrbitEvent = { kind: "milestone"; powerPercent: number } | { kind: "complete"; targetName: string };

export function tapOrbitReading(snapshot: EconomyView | null, now: number, ownerKey: string): TapOrbitReading {
  const boost = snapshot?.tapBoost;
  const view = snapshot ? tapBoostView(snapshot, now) : null;
  const job = snapshot?.jobs.find(candidate => candidate.id === boost?.jobId);
  const expiresAt = boost?.expiresAt ? Date.parse(boost.expiresAt) : 0;
  return { ownerKey, known: snapshot !== null, active: view?.active ?? false,
    jobId: boost?.jobId ?? null, hasJob: Boolean(job), finished: Boolean(job && Date.parse(job.finishesAt) <= now),
    targetName: view?.targetName ?? "Производство", charge: boost?.charge ?? 0,
    powerPercent: view?.powerPercent ?? 0, grantedAt: boost?.grantedAt ? Date.parse(boost.grantedAt) : 0, expiresAt,
    remainingRatio: view?.active ? Math.max(0, Math.min(1, (expiresAt - now) / (TAP_BOOST_MAX_SECONDS * 1000))) : 0,
  };
}

/** Every observation advances the baseline, including hidden/inactive observations.
 * A restored snapshot is never a celebration. A missing job is never a completion. */
export function advanceTapOrbit(previous: TapOrbitMemory | null, current: TapOrbitReading, localInput: boolean) {
  const step = TAP_BOOST_MILESTONES.filter(value => value <= current.powerPercent).length;
  const sameOwner = previous?.known && current.known && previous.ownerKey === current.ownerKey;
  const sameJob = sameOwner && previous.jobId !== null && previous.jobId === current.jobId;
  const continuing = sameJob && previous.expiresAt >= current.grantedAt && current.charge >= previous.charge;
  const highestStep = continuing ? Math.max(previous.highestStep, step) : step;
  const memory: TapOrbitMemory = { ...current, highestStep };
  let event: TapOrbitEvent | null = null;
  if (sameJob && previous.hasJob && !previous.finished && current.hasJob && current.finished && previous.charge > 0) {
    event = { kind: "complete", targetName: current.targetName };
  } else if (sameOwner && current.active && localInput && step > (continuing ? previous.highestStep : 0)) {
    event = { kind: "milestone", powerPercent: TAP_BOOST_MILESTONES[step - 1] };
  }
  return { memory, event };
}
