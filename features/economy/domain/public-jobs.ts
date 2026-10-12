import { economyCatalog, type EconomyJob } from "./model";

const fishIds = new Set(economyCatalog.fishing?.fish.map(fish => fish.itemId) ?? ["fish"]);

/** The saved catch is private until claim. Otherwise cancelling after inspecting
 * rewards lets a player probe different loadouts against the same draw. */
export function publicEconomyJob(job: EconomyJob): EconomyJob {
  if (!job.fishing) return job;
  const rewards: Record<string, number> = {};
  let fishCount = 0;
  for (const [itemId, count] of Object.entries(job.rewards)) {
    if (fishIds.has(itemId) || itemId === job.fishing.fishId) fishCount += count;
    else rewards[itemId] = count;
  }
  if (fishCount > 0) rewards.fish = fishCount;
  return { ...job, rewards, fishing: { ...job.fishing, fishId: "fish" } };
}
