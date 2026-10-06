import rawCatalog from "@/apps/api/src/main/resources/world/progression-rewards-catalog.json";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_ITEMS, ECONOMY_MAX_PEARLS } from "@/features/economy/money";
import { GAME_ACHIEVEMENT_TARGETS } from "./achievement-progress";
import type { GameAchievementId } from "./game-api";
import type { AchievementReward, GameReward, GameRewards } from "./game-rewards-api";

const catalog = rawCatalog as unknown as { version: number; currencyScale: number; pearlScale: number; dailyMinimumHours: number; daily: GameReward[];
  dailyByHomeLevel: Record<string, GameReward[]>;
  achievementPearls: Record<GameAchievementId, number[]> };
export const progressionRewardsCatalog = catalog;
export type DailyRewardState = { step: number; lastClaimAt: string | null; lastClaimDate: string | null };
export const initialDailyRewardState = (): DailyRewardState => ({ step: 1, lastClaimAt: null, lastClaimDate: null });
const DAY = 86_400_000;
/** Saved, completed home level only: unfinished construction and purchased slots never multiply gifts. */
export function dailyRewardCycle(homeLevel = 1): GameReward[] {
  const level = Number.isSafeInteger(homeLevel) ? Math.min(5, Math.max(1, homeLevel)) : 1;
  return structuredClone(level === 1 ? catalog.daily : catalog.dailyByHomeLevel[String(level)]);
}
export function dailyRewardView(state: DailyRewardState, now: number, homeLevel = 1): GameRewards["daily"] {
  const level = Number.isSafeInteger(homeLevel) ? Math.min(5, Math.max(1, homeLevel)) : 1;
  const cycle = dailyRewardCycle(level);
  const last = state.lastClaimAt === null ? null : Date.parse(state.lastClaimAt);
  const next = last === null ? now : Math.max(Math.floor(last / DAY) * DAY + DAY, last + catalog.dailyMinimumHours * 3_600_000);
  return { ...state, homeLevel: level, claimable: now >= next, nextClaimAt: new Date(next).toISOString(),
    reward: structuredClone(cycle[state.step - 1]), cycle: cycle.map((reward, index) => ({ step: index + 1, reward })) };
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
/** Daily bundles are authoritative and finite; the finale also grants one relic. */
export function assertProgressionRewardCatalog(): void {
  if (catalog.version !== 1 || catalog.currencyScale !== 10 || catalog.pearlScale !== 50 || catalog.daily.length !== 7 || catalog.dailyMinimumHours !== 20) throw new Error("Invalid rewards cycle");
  if (Object.keys(catalog.dailyByHomeLevel).sort().join() !== "2,3,4,5") throw new Error("Invalid daily home tiers");
  const ids = Object.keys(GAME_ACHIEVEMENT_TARGETS) as GameAchievementId[];
  if (Object.keys(catalog.achievementPearls).length !== ids.length || ids.some(id => catalog.achievementPearls[id].length !== GAME_ACHIEVEMENT_TARGETS[id].length)) throw new Error("Invalid achievement rewards");
  const itemIds = new Set(["wood", "stone", "fiber", "berries", "fish", "hardwood", "resin", "planks", "rope", "bricks", "iron_ingot", "cloth", "metal_parts", "glass", "beams", "cut_stone", "tools", "reinforced_parts", "ancient_core"]);
  for (const cycle of [catalog.daily, ...Object.values(catalog.dailyByHomeLevel)]) {
    if (cycle.length !== 7 || cycle.reduce((sum, reward) => sum + reward.pearls, 0) !== 450
      || cycle.reduce((sum, reward) => sum + (reward.items.ancient_core ?? 0), 0) !== 1) throw new Error("Invalid daily tier budget");
    for (const [index, reward] of cycle.entries()) {
      if ([reward.coins, reward.pearls].some(value => !Number.isSafeInteger(value) || value < 0)
        || reward.coins > ECONOMY_MAX_BALANCE || reward.pearls > ECONOMY_MAX_PEARLS
        || Object.entries(reward.items).some(([id, value]) => !itemIds.has(id) || !Number.isSafeInteger(value) || value <= 0 || value > ECONOMY_MAX_ITEMS)
        || reward.pearls !== catalog.daily[index].pearls) throw new Error("Invalid daily reward");
    }
  }
}
assertProgressionRewardCatalog();
