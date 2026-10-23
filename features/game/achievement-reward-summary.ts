import type { GameRewards } from "./game-rewards-api";

/** Only the current account's server-confirmed unclaimed rewards light the UI. */
export function achievementRewardSummary(rewards: GameRewards | null | undefined, ownerPublicId: string) {
  const rows = rewards?.ownerPublicId === ownerPublicId ? rewards.achievementRewards : [];
  const available = rows.filter(row => row.eligible && !row.claimedAt && !row.blockedReason && row.pearls > 0);
  return { count: available.length, pearls: available.reduce((total, row) => total + row.pearls, 0) };
}
