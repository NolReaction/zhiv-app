/** Canonical harvest goods, including legacy paid raspberry/strawberry jobs. */
export const GARDEN_BERRY_ITEM_IDS = ["berries", "strawberries", "blueberries", "currants", "blackberries", "cranberries"] as const;

export function hasGardenBerryReward(rewards: Readonly<Record<string, number>>): boolean {
  return GARDEN_BERRY_ITEM_IDS.some(id => (rewards[id] ?? 0) > 0);
}
