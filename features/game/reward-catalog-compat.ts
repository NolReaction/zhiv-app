import type { GameRewards } from "./game-rewards-api";

/** Cached 0.7.1 clients know the original 21 reward rows. Negotiate before
 * returning new IDs, including the snapshot attached to an idempotent claim. */
export function requestedRewardCatalog(parameters: URLSearchParams): 4 | 5 | null {
  if (![...parameters.keys()].length) return 4;
  if ([...parameters.keys()].some(key => key !== "catalog") || parameters.getAll("catalog").length !== 1) return null;
  return parameters.get("catalog") === "5" ? 5 : parameters.get("catalog") === "4" ? 4 : null;
}

export function rewardCatalogView(rewards: GameRewards, catalog: 4 | 5): GameRewards {
  return catalog === 5 ? rewards : { ...rewards, catalogVersion: 4, achievementRewards: rewards.achievementRewards.slice(0, 21) };
}
