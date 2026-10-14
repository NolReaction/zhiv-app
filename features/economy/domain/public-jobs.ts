import { economyCatalog, type EconomyJob } from "./model";

const fishIds = new Set([...(economyCatalog.fishing?.fish.map(fish => fish.itemId) ?? ["fish"]),
  ...(economyCatalog.fishing?.classes.map(group => group.itemId) ?? [])]);

/** Hide an unfinished draw. Only authoritative server time reveals the saved
 * completed catch; projecting never rolls or awards any fish. */
export function publicEconomyJob(job: EconomyJob, now = Date.now()): EconomyJob {
  if (!job.fishing) return job;
  const finishesAt = Date.parse(job.finishesAt);
  if (Number.isFinite(now) && Number.isFinite(finishesAt) && now >= finishesAt)
    return { ...job, fishing: { ...job.fishing, catchRevealed: true } };
  const rewards: Record<string, number> = {};
  let fishCount = 0;
  for (const [itemId, count] of Object.entries(job.rewards)) {
    if (fishIds.has(itemId) || itemId === job.fishing.fishId) fishCount += count;
    else rewards[itemId] = count;
  }
  if (fishCount > 0) rewards.fish = fishCount;
  const fishing = { ...job.fishing, fishId: "fish" };
  delete fishing.catchRevealed;
  return { ...job, rewards, fishing };
}
