import { LEGACY_GAME_ACHIEVEMENT_TARGETS } from "./achievement-progress";
import type { GameRewards } from "./game-rewards-api";

/** Cached clients can still read their original 21 or 33 reward rows. */
export function requestedRewardCatalog(parameters: URLSearchParams): 4 | 5 | 6 | 7 | 8 | null {
  if (![...parameters.keys()].length) return 4;
  if ([...parameters.keys()].some(key => key !== "catalog") || parameters.getAll("catalog").length !== 1) return null;
  return parameters.get("catalog") === "8" ? 8 : parameters.get("catalog") === "7" ? 7 : parameters.get("catalog") === "6" ? 6 : parameters.get("catalog") === "5" ? 5 : parameters.get("catalog") === "4" ? 4 : null;
}

export function rewardCatalogView(rewards: GameRewards, catalog: 4 | 5 | 6 | 7 | 8): GameRewards {
  return { ...rewards, catalogVersion: catalog, achievementRewards: catalog >= 8 ? rewards.achievementRewards : rewards.achievementRewards.filter(row => row.level <= LEGACY_GAME_ACHIEVEMENT_TARGETS[row.achievementId].length).slice(0, catalog >= 5 ? 33 : 21) };
}

export const REWARD_APP_UPDATE_MESSAGE = "Обновите приложение, чтобы получить награду. Сохранённые награды останутся доступны.";

/** Old claim validators require a full economy snapshot but reject catalog 15.
 * Reject before granting; returning a newer snapshot after crediting would leave
 * their exact receipt permanently uncertain until the bundle reloads. */
export function rewardClaimRequiresAppUpdate(catalog: number, economyVersion: number): boolean {
  return catalog < 8 && economyVersion >= 15;
}
