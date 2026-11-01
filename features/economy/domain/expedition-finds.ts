import type { EconomyCatalog, EconomyJob } from "./model";
import { secureRareInteger, type RareRandomInteger } from "./rare-drops";

type Finds = NonNullable<EconomyCatalog["explorations"][number]["finds"]>;
type Loot = Pick<EconomyCatalog["explorations"][number], "finds" | "loot">;

/** Capacity uses the full offer, never the private outcome of one departure. */
export function expeditionMaximumBonus(route: Loot): number {
  return (route.loot?.reduce((total, entry) => total + entry.max, 0) ?? 0)
    + Math.max(0, ...(route.finds?.entries.map(entry => entry.quantity) ?? []));
}
export function expeditionMaximumRewards(route: Loot & { rewards: Record<string, number> }): number {
  return Object.values(route.rewards).reduce((total, count) => total + count, 0) + expeditionMaximumBonus(route);
}

/** Additional quantities are independent, uniform, and saved with the rare find. */
export function drawExpeditionLoot(route: Loot, random: RareRandomInteger = secureRareInteger): Record<string, number> {
  const rewards: Record<string, number> = {};
  for (const entry of route.loot ?? []) {
    const size = entry.max - entry.min + 1;
    const roll = size === 1 ? 0 : random(size);
    if (!Number.isSafeInteger(roll) || roll < 0 || roll >= size) throw new Error("Invalid trusted expedition draw");
    const quantity = entry.min + roll;
    if (quantity > 0) rewards[entry.itemId] = quantity;
  }
  for (const [id, quantity] of Object.entries(route.finds ? drawExpeditionFinds(route.finds, random) : {}))
    rewards[id] = (rewards[id] ?? 0) + quantity;
  return rewards;
}
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
