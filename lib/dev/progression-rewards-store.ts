// Development adapter only; the production equivalent locks the owner in PostgreSQL.
import { getDevIdentity, getDevAchievementRewardEligibility } from "./api-store";
import { getDevGameAchievements } from "./game-store";
import { creditDevProgressionReward, getDevEconomy, DevEconomyError } from "./economy-store";
import { gameRewardClaimSchema, type GameRewardClaim, type GameRewardResult, type GameRewards } from "@/features/game/game-rewards-api";
import { ECONOMY_CURRENCY_SCALE, ECONOMY_PEARL_SCALE, nominalEconomyMoney, nominalEconomyPearls } from "@/features/economy/money";
import { achievementRewardRows, afterDailyClaim, dailyRewardView, initialDailyRewardState, type DailyRewardState } from "@/features/game/progression-rewards";

type Receipt = { signature: string; claim: GameRewardResult["claim"]; acceptedRevision: number; currencyScale?: 1 | 10; pearlScale?: 1 | 10 | 50 };
type Profile = { daily: DailyRewardState; claims: Map<string, string>; receipts: Map<string, Receipt> };
const globalStore = globalThis as typeof globalThis & { __zhivDevProgressionRewards?: Map<string, Profile> };
const store = () => globalStore.__zhivDevProgressionRewards ??= new Map();
export const resetDevProgressionRewardsForTests = () => { delete globalStore.__zhivDevProgressionRewards; };
function fail(code: string, message: string, status = 409): never { throw new DevEconomyError(code, message, status); }
function profile(token: string | undefined, expectedOwner?: string) {
  const identity = getDevIdentity(token);
  if (!identity) fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401);
  const owner = identity.user.publicId;
  if (expectedOwner && owner !== expectedOwner) fail("ECONOMY_OWNER_CHANGED", "Аккаунт изменился. Обновите награды");
  let value = store().get(owner);
  if (!value) store().set(owner, value = { daily: initialDailyRewardState(), claims: new Map(), receipts: new Map() });
  return { owner, value };
}
function view(token: string | undefined, owner: string, value: Profile, now: number): GameRewards {
  // Reconcile verified progress before reading dates; dates are never inferred from ownership in the browser.
  const result = getDevGameAchievements(token, now, 5);
  if (result.kind !== "ok") fail("UNAUTHORIZED", "Войдите в профиль ещё раз", 401);
  return { ownerPublicId: owner, serverTime: new Date(now).toISOString(), catalogVersion: 1,
    daily: dailyRewardView(value.daily, now),
    achievementRewards: achievementRewardRows((id, level) => ({
      at: result.value.achievements.find(row => row.id === id)?.tiers?.find(tier => tier.level === level)?.unlockedAt ?? null,
      eligible: getDevAchievementRewardEligibility(owner, id, level),
    }), (id, level) => value.claims.get(`${id}:${level}`) ?? null) };
}
export function getDevProgressionRewards(token: string | undefined, now = Date.now()): GameRewards {
  const { owner, value } = profile(token);
  getDevEconomy(token, now, owner);
  return view(token, owner, value, now);
}
export function claimDevProgressionReward(token: string | undefined, input: unknown, now = Date.now()): GameRewardResult {
  const parsed = gameRewardClaimSchema.safeParse(input);
  if (!parsed.success || !/^\w{8}-\w{4}-4\w{3}-[89ab]\w{3}-\w{12}$/i.test(parsed.success ? parsed.data.requestId : ""))
    fail("INVALID_REWARD_CLAIM", "Некорректный запрос награды", 400);
  const command: GameRewardClaim = parsed.data, { owner, value } = profile(token, command.ownerPublicId);
  const signature = JSON.stringify(command), key = command.requestId.toLowerCase(), receipt = value.receipts.get(key);
  if (receipt) {
    if (receipt.signature !== signature) fail("REWARD_REQUEST_CONFLICT", "Этот запрос уже использован для другой награды");
    return { requestId: command.requestId, rewards: view(token, owner, value, now), economy: getDevEconomy(token, now, owner),
      acceptedRevision: receipt.acceptedRevision, replayed: true, claim: { ...structuredClone(receipt.claim), reward: { ...structuredClone(receipt.claim.reward),
        coins: nominalEconomyMoney(receipt.claim.reward.coins, receipt.currencyScale ?? 1),
        pearls: nominalEconomyPearls(receipt.claim.reward.pearls, receipt.pearlScale ?? receipt.currencyScale ?? 1) } }, message: "Награда получена" };
  }
  const current = getDevProgressionRewards(token, now), claimedAt = new Date(now).toISOString();
  let claim: GameRewardResult["claim"];
  if (command.kind === "daily") {
    if (!current.daily.claimable) fail("DAILY_REWARD_COOLDOWN", "Следующая награда пока недоступна");
    claim = { kind: "daily", step: current.daily.step, reward: current.daily.reward, claimedAt };
  } else {
    const row = current.achievementRewards.find(row => row.achievementId === command.achievementId && row.level === command.level);
    if (!row) fail("INVALID_REWARD_CLAIM", "Такой ступени достижения нет", 400);
    if (row.claimedAt) fail("ACHIEVEMENT_REWARD_CLAIMED", "Награда за эту ступень уже получена");
    if (!row.eligible) fail("ACHIEVEMENT_REWARD_UNAVAILABLE", "Награда за эту ступень пока недоступна");
    claim = { kind: "achievement", achievementId: row.achievementId, level: row.level, reward: { coins: 0, pearls: row.pearls, items: {} }, claimedAt };
  }
  // Capacity failure leaves daily sequence, stage payout and receipt untouched.
  const economy = creditDevProgressionReward(token, owner, key, claim.reward, signature, now);
  if (claim.kind === "daily") value.daily = afterDailyClaim(value.daily, now);
  else value.claims.set(`${claim.achievementId}:${claim.level}`, claimedAt);
  value.receipts.set(key, { signature, claim: structuredClone(claim), acceptedRevision: economy.revision, currencyScale: ECONOMY_CURRENCY_SCALE, pearlScale: ECONOMY_PEARL_SCALE });
  return { requestId: command.requestId, rewards: view(token, owner, value, now), economy, acceptedRevision: economy.revision,
    replayed: false, claim, message: "Награда получена" };
}
