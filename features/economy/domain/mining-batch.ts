import limits from "@/apps/api/src/main/resources/world/mining-batch-catalog.json";
import type { EconomyJob } from "./model";

export const miningBatchCatalog = limits;

/** Queue convenience grows with the quarry, without reserving more than an hour of base work. */
export function miningBatchLimit(quarryLevel: number, unitSeconds: number): number {
  const index = Math.max(0, Math.min(limits.maxUnitsByQuarryLevel.length - 1, Math.floor(quarryLevel) - 1));
  return Math.max(1, Math.min(limits.maxUnitsByQuarryLevel[index], Math.floor(limits.maxBaseSeconds / Math.max(1, unitSeconds))));
}

/** Saved unit time also works after a tap boost shifts both ends of the job clock. */
export function miningBatchProgress(job: EconomyJob, now: number) {
  const batch = job.miningBatch;
  const quantity = batch?.quantity ?? 1, claimed = batch?.claimed ?? 0;
  const unitMillis = batch ? batch.unitSeconds * 1000 : Date.parse(job.finishesAt) - Date.parse(job.startedAt);
  const elapsedUnits = Math.max(0, (now - Date.parse(job.startedAt)) / Math.max(1, unitMillis));
  const completed = Math.min(quantity, Math.floor(elapsedUnits));
  return { quantity, claimed, completed, ready: Math.max(0, completed - claimed),
    remaining: quantity - completed, nextAt: Date.parse(job.startedAt) + Math.min(quantity, completed + 1) * unitMillis,
    ratio: Math.min(1, elapsedUnits / quantity), unitRatio: completed === quantity ? 1 : elapsedUnits - completed };
}

/** Collection bookkeeping always observes one unit, not the duration of the complete queue. */
export function miningUnitDelivery(job: EconomyJob, rewards: Record<string, number>): EconomyJob {
  const batch = job.miningBatch!;
  const startedAt = Date.parse(job.startedAt) + batch.claimed * batch.unitSeconds * 1000;
  return { ...job, miningBatch: null, expeditionFinds: null, rewards,
    startedAt: new Date(startedAt).toISOString(), finishesAt: new Date(startedAt + batch.unitSeconds * 1000).toISOString() };
}
