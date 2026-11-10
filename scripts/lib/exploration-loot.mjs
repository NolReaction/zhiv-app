import assert from "node:assert/strict";

/** Ordinary range rewards are independent uniform integer draws. Weighted
 * finds are a separate single draw: capacity reserves its largest outcome. */
export function explorationLootSummary(source) {
  const expectedRewards = { ...source.rewards };
  let maximumBaseCount = Object.values(source.rewards).reduce((sum, quantity) => sum + quantity, 0);
  for (const entry of source.loot ?? []) {
    assert(Number.isSafeInteger(entry.min) && Number.isSafeInteger(entry.max) && entry.min >= 0 && entry.max >= entry.min,
      `${source.id}: invalid ordinary loot range`);
    expectedRewards[entry.itemId] = (expectedRewards[entry.itemId] ?? 0) + (entry.min + entry.max) / 2;
    maximumBaseCount += entry.max;
  }
  const maximumFind = Math.max(0, ...(source.finds?.entries ?? []).map(entry => entry.quantity));
  return { expectedRewards, maximumBaseCount, maximumOutputCount: maximumBaseCount + maximumFind };
}
