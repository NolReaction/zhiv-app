import rawCatalog from "@/apps/api/src/main/resources/world/progression-rewards-catalog.json";
import { GAME_ACHIEVEMENT_TARGETS } from "./achievement-progress";
import type { GameAchievementId } from "./game-api";
import type { AchievementReward, GameReward, GameRewards } from "./game-rewards-api";

const catalog = rawCatalog as unknown as { version: number; currencyScale: number; dailyMinimumHours: number; daily: GameReward[];
  achievementPearls: Record<GameAchievementId, number[]> };
export const progressionRewardsCatalog = catalog;
export type DailyRewardState = { step: number; lastClaimAt: string | null; lastClaimDate: string | null };
export const initialDailyRewardState = (): DailyRewardState => ({ step: 1, lastClaimAt: null, lastClaimDate: null });
const DAY = 86_400_000;
export function dailyRewardView(state: DailyRewardState, now: number): GameRewards["daily"] {
  const last = state.lastClaimAt === null ? null : Date.parse(state.lastClaimAt);
  const next = last === null ? now : Math.max(Math.floor(last / DAY) * DAY + DAY, last + catalog.dailyMinimumHours * 3_600_000);
  return { ...state, claimable: now >= next, nextClaimAt: new Date(next).toISOString(),
    reward: structuredClone(catalog.daily[state.step - 1]),
    cycle: catalog.daily.map((reward, index) => ({ step: index + 1, reward: structuredClone(reward) })) };
}
export function afterDailyClaim(state: DailyRewardState, now: number): DailyRewardState {
  return { step: state.step % catalog.daily.length + 1, lastClaimAt: new Date(now).toISOString(), lastClaimDate: new Date(now).toISOString().slice(0, 10) };
}
/** Preserve the sequence attached to the latest actual claim; skips never reset it. */
export function mergeDailyRewards(left: DailyRewardState, right: DailyRewardState): DailyRewardState {
  if (!left.lastClaimAt) return structuredClone(right);
  if (!right.lastClaimAt) return structuredClone(left);
  // Deterministic tie: target's state wins when two events have the same timestamp.
  return structuredClone(Date.parse(right.lastClaimAt) > Date.parse(left.lastClaimAt) ? right : left);
}
export function achievementRewardRows(earned: (id: GameAchievementId, level: number) => { at: string | null; eligible: boolean },
  claimed: (id: GameAchievementId, level: number) => string | null): AchievementReward[] {
  return Object.entries(GAME_ACHIEVEMENT_TARGETS).flatMap(([rawId, targets]) => {
    const achievementId = rawId as GameAchievementId;
    return targets.map((target, index) => {
      const level = index + 1, pearls = catalog.achievementPearls[achievementId][index], ownership = earned(achievementId, level), claimedAt = claimed(achievementId, level);
      const blockedReason = pearls === 0 ? "no_reward" : !ownership.at ? "not_earned" : !ownership.eligible ? "admin_grant" : null;
      return { achievementId, level, target, pearls, earnedAt: ownership.at, claimedAt, blockedReason,
        eligible: Boolean(ownership.at && ownership.eligible && pearls > 0 && !claimedAt) };
    });
  });
}
/** This catalog may issue ordinary starter materials only; rare drops have their own rules. */
export function assertProgressionRewardCatalog(): void {
  if (catalog.version !== 1 || catalog.currencyScale !== 10 || catalog.daily.length !== 7 || catalog.dailyMinimumHours !== 20) throw new Error("Invalid rewards cycle");
  const ids = Object.keys(GAME_ACHIEVEMENT_TARGETS) as GameAchievementId[];
  if (Object.keys(catalog.achievementPearls).length !== ids.length || ids.some(id => catalog.achievementPearls[id].length !== GAME_ACHIEVEMENT_TARGETS[id].length)) throw new Error("Invalid achievement rewards");
  for (const reward of catalog.daily as GameReward[]) {
    if ([reward.coins, reward.pearls, ...Object.values(reward.items)].some(value => !Number.isSafeInteger(value) || value < 0)
      || Object.keys(reward.items).some(id => !["wood", "stone", "fiber"].includes(id))) throw new Error("Invalid ordinary daily reward");
  }
}
assertProgressionRewardCatalog();
