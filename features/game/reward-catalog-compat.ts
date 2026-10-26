import type { GameRewards } from "./game-rewards-api";

/** Cached 0.7.1 clients know the original 21 reward rows. Negotiate before
 * returning new IDs, including the snapshot attached to an idempotent claim. */
export function requestedRewardCatalog(parameters: URLSearchParams): 4 | 5 | 6 | null {
  if (![...parameters.keys()].length) return 4;
  if ([...parameters.keys()].some(key => key !== "catalog") || parameters.getAll("catalog").length !== 1) return null;
  return parameters.get("catalog") === "6" ? 6 : parameters.get("catalog") === "5" ? 5 : parameters.get("catalog") === "4" ? 4 : null;
}

export function rewardCatalogView(rewards: GameRewards, catalog: 4 | 5 | 6): GameRewards {
  return { ...rewards, catalogVersion: catalog, achievementRewards: rewards.achievementRewards.slice(0, catalog >= 5 ? 33 : 21) };
}
