import rawCatalog from "@/apps/api/src/main/resources/world/progression-rewards-catalog.json";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_ITEMS, ECONOMY_MAX_PEARLS } from "@/features/economy/domain/money";
import type { EconomyState } from "@/features/economy/domain/model";
import { tutorialOrderProgress } from "@/features/economy/domain/tutorial-order";
import { GAME_ACHIEVEMENT_TARGETS, LEGACY_GAME_ACHIEVEMENT_TARGETS } from "./achievement-progress";
import type { GameAchievementId } from "./game-api";
import type { AchievementReward, GameReward, GameRewards } from "./game-rewards-api";

const catalog = rawCatalog as unknown as { version: 8; currencyScale: number; pearlScale: number; dailyMinimumHours: number; daily: GameReward[];
  onboarding: GameReward; legacyOnboarding: GameReward; legacyDailyPearls: number[]; v6Onboarding: GameReward; v6DailyPearls: number[];
  dailyByHomeLevel: Record<string, GameReward[]>;
  legacyAchievementPearls: Record<GameAchievementId, number[]>; achievementPearls: Record<GameAchievementId, number[]> };
export const progressionRewardsCatalog = catalog;
export type RewardPromiseVersion = 5 | 6 | 7;
export type DailyRewardState = { step: number; lastClaimAt: string | null; lastClaimDate: string | null; completed: boolean; rewardVersion?: RewardPromiseVersion };
type SavedDailyRewardState = Omit<DailyRewardState, "completed"> & { completed?: boolean };
export const initialDailyRewardState = (): DailyRewardState => ({ step: 1, lastClaimAt: null, lastClaimDate: null, completed: false, rewardVersion: 7 });
/** Upgrade a live DEV store created before the one-time chain. Receipts remain immutable. */
export function normalizeDailyRewardState(state: SavedDailyRewardState, paidSteps: Iterable<number> = []): DailyRewardState {
  let highestPaid = 0;
  for (const step of paidSteps) highestPaid = Math.max(highestPaid, step);
  const completed = state.completed === true || highestPaid >= catalog.daily.length || (state.step === 1 && state.lastClaimAt !== null);
  return { ...state, completed, step: completed ? catalog.daily.length : Math.max(state.step, Math.min(catalog.daily.length, highestPaid + 1)) };
}
const DAY = 86_400_000;
/** Match the practical order lesson, including saved legacy progress. The server
 * owns these fields; local tutorial screens cannot qualify an early payout. */
export function onboardingRewardEligible(state: Pick<EconomyState, "tutorialOrder">): boolean {
  const progress = tutorialOrderProgress(state);
  return progress.completed || progress.step > 0;
}
/** Existing profiles retain the tutorial grant they were shown in their version. */
export function onboardingRewardForState(state: Pick<EconomyState, "tutorialOrder">): GameReward {
  const version = state.tutorialOrder?.rewardVersion ?? 5;
  return structuredClone(version === 7 ? catalog.onboarding : version === 6 ? catalog.v6Onboarding : catalog.legacyOnboarding);
}
/** Saved, completed home level only: unfinished construction and purchased slots never multiply gifts. */
export function dailyRewardCycle(homeLevel = 1, rewardVersion: RewardPromiseVersion = 7): GameReward[] {
  const level = Number.isSafeInteger(homeLevel) ? Math.min(5, Math.max(1, homeLevel)) : 1;
  const cycle = structuredClone(level === 1 ? catalog.daily : catalog.dailyByHomeLevel[String(level)]);
  const promisedPearls = rewardVersion === 5 ? catalog.legacyDailyPearls : rewardVersion === 6 ? catalog.v6DailyPearls : null;
  return promisedPearls ? cycle.map((reward, index) => ({ ...reward, pearls: promisedPearls[index] })) : cycle;
}
export function dailyRewardView(saved: SavedDailyRewardState, now: number, homeLevel = 1): GameRewards["daily"] {
  const state = normalizeDailyRewardState(saved);
  const level = Number.isSafeInteger(homeLevel) ? Math.min(5, Math.max(1, homeLevel)) : 1;
  const cycle = dailyRewardCycle(level, state.rewardVersion ?? 5);
  const last = state.lastClaimAt === null ? null : Date.parse(state.lastClaimAt);
  const next = last === null ? now : Math.max(Math.floor(last / DAY) * DAY + DAY, last + catalog.dailyMinimumHours * 3_600_000);
  return { ...state, homeLevel: level, claimable: !state.completed && now >= next, nextClaimAt: state.completed ? null : new Date(next).toISOString(),
    reward: structuredClone(cycle[state.step - 1]), cycle: cycle.map((reward, index) => ({ step: index + 1, reward })) };
}
export function afterDailyClaim(saved: SavedDailyRewardState, now: number): DailyRewardState {
  const state = normalizeDailyRewardState(saved);
  if (state.completed) return state;
  return { step: Math.min(state.step + 1, catalog.daily.length), completed: state.step === catalog.daily.length,
    rewardVersion: state.rewardVersion ?? 5, lastClaimAt: new Date(now).toISOString(), lastClaimDate: new Date(now).toISOString().slice(0, 10) };
}
/** Neither a newer claim nor a merge can revive gifts already received on either account. */
export function mergeDailyRewards(leftSaved: SavedDailyRewardState, rightSaved: SavedDailyRewardState): DailyRewardState {
  const left = normalizeDailyRewardState(leftSaved), right = normalizeDailyRewardState(rightSaved);
  const latest = !left.lastClaimAt || (right.lastClaimAt && Date.parse(right.lastClaimAt) > Date.parse(left.lastClaimAt)) ? right : left;
  const completed = left.completed || right.completed;
  return { ...latest, rewardVersion: Math.min(left.rewardVersion ?? 5, right.rewardVersion ?? 5) as RewardPromiseVersion,
    step: completed ? catalog.daily.length : Math.max(left.step, right.step), completed };
}
export function achievementRewardRows(earned: (id: GameAchievementId, level: number) => { at: string | null; eligible: boolean },
  claimed: (id: GameAchievementId, level: number) => string | null, rewardVersion: 6 | 7 = 7, paidPearls?: (id: GameAchievementId, level: number) => number | undefined): AchievementReward[] {
  return Object.entries(GAME_ACHIEVEMENT_TARGETS).flatMap(([rawId, targets]) => {
    const achievementId = rawId as GameAchievementId;
    return targets.map((target, index) => {
      const level = index + 1, pearls = paidPearls?.(achievementId, level) ?? achievementPearlsForVersion(achievementId, level, rewardVersion), ownership = earned(achievementId, level), claimedAt = claimed(achievementId, level);
      const blockedReason = pearls === 0 ? "no_reward" : !ownership.at ? "not_earned" : !ownership.eligible ? "admin_grant" : null;
      return { achievementId, level, target, pearls, earnedAt: ownership.at, claimedAt, blockedReason,
        eligible: Boolean(ownership.at && ownership.eligible && pearls > 0 && !claimedAt) };
    });
  });
}
/** Existing profiles keep the original award promises; appended tiers are new rewards for everyone. */
export function achievementPearlsForVersion(id: GameAchievementId, level: number, version: 6 | 7 = 7): number {
  return (version === 6 ? catalog.legacyAchievementPearls[id][level - 1] : undefined) ?? catalog.achievementPearls[id][level - 1];
}
/** Daily bundles are authoritative and finite; the finale also grants one relic. */
export function assertProgressionRewardCatalog(): void {
  if (catalog.version !== 8 || catalog.currencyScale !== 10 || catalog.pearlScale !== 50 || catalog.daily.length !== 7 || catalog.dailyMinimumHours !== 20) throw new Error("Invalid rewards cycle");
  if (catalog.onboarding.coins !== 100 || catalog.onboarding.pearls !== 20 || Object.keys(catalog.onboarding.items).length !== 0)
    throw new Error("Invalid onboarding reward");
  if (catalog.legacyOnboarding.coins !== 1_000 || catalog.legacyOnboarding.pearls !== 200
    || catalog.legacyDailyPearls.join() !== "80,100,120,140,160,180,220"
    || catalog.v6Onboarding.coins !== 100 || catalog.v6Onboarding.pearls !== 40 || Object.keys(catalog.v6Onboarding.items).length !== 0
    || catalog.v6DailyPearls.join() !== "20,30,40,40,50,50,70") throw new Error("Invalid legacy reward promises");
  if (Object.keys(catalog.dailyByHomeLevel).sort().join() !== "2,3,4,5") throw new Error("Invalid daily home tiers");
  const ids = Object.keys(GAME_ACHIEVEMENT_TARGETS) as GameAchievementId[];
  if (Object.keys(catalog.legacyAchievementPearls).length !== ids.length
    || Object.values(catalog.legacyAchievementPearls).flat().reduce((sum, value) => sum + value, 0) !== 4_120
    || ids.some(id => catalog.legacyAchievementPearls[id].length !== LEGACY_GAME_ACHIEVEMENT_TARGETS[id].length
      || LEGACY_GAME_ACHIEVEMENT_TARGETS[id].some((target, index) => GAME_ACHIEVEMENT_TARGETS[id][index] !== target)
      || catalog.legacyAchievementPearls[id].some(value => !Number.isSafeInteger(value) || value < 0 || value % 2 !== 0)))
    throw new Error("Invalid legacy achievement promises");
  if (Object.keys(catalog.achievementPearls).length !== ids.length || ids.some(id => catalog.achievementPearls[id].length !== GAME_ACHIEVEMENT_TARGETS[id].length)) throw new Error("Invalid achievement rewards");
  if (Object.values(catalog.achievementPearls).flat().reduce((sum, value) => sum + value, 0) !== 4_120
    || ids.some(id => catalog.achievementPearls[id].some((value, index, values) => !Number.isSafeInteger(value)
      || value > ECONOMY_MAX_PEARLS || value % 2 !== 0 || (id === "full_collection" ? value !== 0 : value <= 0)
      || (index > 0 && value < values[index - 1])))) throw new Error("Invalid achievement pearl budget");
  const itemIds = new Set(["wood", "stone", "fiber", "berries", "fish", "hardwood", "resin", "planks", "rope", "bricks", "iron_ingot", "cloth", "metal_parts", "glass", "beams", "cut_stone", "tools", "reinforced_parts", "ancient_core"]);
  for (const cycle of [catalog.daily, ...Object.values(catalog.dailyByHomeLevel)]) {
    if (cycle.length !== 7 || cycle.reduce((sum, reward) => sum + reward.pearls, 0) !== 140
      || cycle.reduce((sum, reward) => sum + (reward.items.ancient_core ?? 0), 0) !== 1) throw new Error("Invalid daily tier budget");
    for (const [index, reward] of cycle.entries()) {
      if ([reward.coins, reward.pearls].some(value => !Number.isSafeInteger(value) || value < 0) || reward.pearls % 2 !== 0
        || reward.coins > ECONOMY_MAX_BALANCE || reward.pearls > ECONOMY_MAX_PEARLS
        || Object.entries(reward.items).some(([id, value]) => !itemIds.has(id) || !Number.isSafeInteger(value) || value <= 0 || value > ECONOMY_MAX_ITEMS)
        || reward.pearls !== catalog.daily[index].pearls) throw new Error("Invalid daily reward");
    }
  }
}
assertProgressionRewardCatalog();
