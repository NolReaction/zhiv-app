import type { EconomyCatalog, EconomyJob } from "./model";
import { secureRareInteger, type RareRandomInteger } from "./rare-drops";

type Finds = NonNullable<EconomyCatalog["explorations"][number]["finds"]>;
/** One trusted draw at start. Its saved result is private until the atomic claim. */
export function drawExpeditionFinds(spec: Finds, random: RareRandomInteger = secureRareInteger): Record<string, number> {
  const total = spec.emptyWeight + spec.entries.reduce((sum, entry) => sum + entry.weight, 0);
  let draw = random(total);
  if (!Number.isSafeInteger(draw) || draw < 0 || draw >= total) throw new Error("Invalid trusted expedition draw");
  if (draw < spec.emptyWeight) return {};
  draw -= spec.emptyWeight;
  for (const entry of spec.entries) {
    if (draw < entry.weight) return { [entry.itemId]: entry.quantity };
    draw -= entry.weight;
  }
  throw new Error("Invalid expedition weights");
}
/** Old jobs have no bonus field and keep exactly their original rewards. */
export function expeditionJobRewards(job: Pick<EconomyJob, "rewards" | "expeditionFinds">): Record<string, number> {
  const rewards = { ...job.rewards };
  for (const [itemId, quantity] of Object.entries(job.expeditionFinds ?? {})) rewards[itemId] = (rewards[itemId] ?? 0) + quantity;
  return rewards;
}
