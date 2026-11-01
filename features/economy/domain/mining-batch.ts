import type { EconomyJob } from "./model";

export const MINING_BATCH_LIMIT = 100;

/** Saved unit time also works after a tap boost shifts both ends of the job clock. */
export function miningBatchProgress(job: EconomyJob, now: number) {
  const batch = job.miningBatch;
  const quantity = batch?.quantity ?? 1, claimed = batch?.claimed ?? 0;
  const unitMillis = batch ? batch.unitSeconds * 1000 : Date.parse(job.finishesAt) - Date.parse(job.startedAt);
  const completed = Math.min(quantity, Math.max(0, Math.floor((now - Date.parse(job.startedAt)) / Math.max(1, unitMillis))));
  return { quantity, claimed, completed, ready: Math.max(0, completed - claimed),
    remaining: quantity - completed, nextAt: Date.parse(job.startedAt) + Math.min(quantity, completed + 1) * unitMillis };
}

/** Collection bookkeeping always observes one unit, not the duration of the complete queue. */
export function miningUnitDelivery(job: EconomyJob, rewards: Record<string, number>): EconomyJob {
  const batch = job.miningBatch!;
  const startedAt = Date.parse(job.startedAt) + batch.claimed * batch.unitSeconds * 1000;
  return { ...job, miningBatch: null, expeditionFinds: null, rewards,
    startedAt: new Date(startedAt).toISOString(), finishesAt: new Date(startedAt + batch.unitSeconds * 1000).toISOString() };
}
