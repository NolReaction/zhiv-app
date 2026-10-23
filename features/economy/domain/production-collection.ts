import type { EconomyJob } from "./model";
import { hasGardenBerryReward } from "./garden-berries";

/** Only finished unattended work is collected here. Berries retain their
 * saved basket/actor stage, and expeditions and construction stay separate. */
export function readyProductionJobs(jobs: readonly EconomyJob[], stationId: string, now: number) {
  return jobs.filter(job => job.kind === "production" && job.targetId === stationId && !job.collection
    && !(stationId === "garden" && hasGardenBerryReward(job.rewards)) && now >= Date.parse(job.finishesAt));
}

export function productionCollectionRewards(jobs: readonly EconomyJob[]) {
  const rewards: Record<string, number> = {};
  for (const job of jobs) for (const [item, quantity] of Object.entries(job.rewards)) rewards[item] = (rewards[item] ?? 0) + quantity;
  return rewards;
}
