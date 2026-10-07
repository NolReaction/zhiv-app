import { gamePresenceHeaders, reportInactivePresence } from "@/features/activity/transport-state";
import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { economyViewSchema } from "@/features/economy/model";
import { GAME_ACHIEVEMENT_TARGETS } from "./achievement-progress";
import type { GameAchievementId } from "./game-api";

const count = z.number().int().nonnegative().safe();
const owner = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
const step = z.number().int().min(1).max(7);
const achievementId = z.enum(Object.keys(GAME_ACHIEVEMENT_TARGETS) as [GameAchievementId, ...GameAchievementId[]]);
export const gameRewardSchema = z.object({ coins: count, pearls: count,
  items: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), count.positive()) });
const achievementRewardSchema = z.object({ achievementId, level: count.positive().max(4), target: count.positive(),
  pearls: count, earnedAt: z.string().datetime().nullable(), claimedAt: z.string().datetime().nullable(),
  eligible: z.boolean(), blockedReason: z.enum(["not_earned", "admin_grant", "no_reward"]).nullable() })
  .refine(value => GAME_ACHIEVEMENT_TARGETS[value.achievementId][value.level - 1] === value.target
    && (!value.eligible || Boolean(value.earnedAt && !value.claimedAt && !value.blockedReason && value.pearls > 0)));
export const gameRewardsSchema = z.object({ ownerPublicId: owner, serverTime: z.string().datetime(), catalogVersion: z.literal(1),
  daily: z.object({ step, homeLevel: z.number().int().min(1).max(5).optional(), claimable: z.boolean(), nextClaimAt: z.string().datetime(), lastClaimAt: z.string().datetime().nullable(),
    lastClaimDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), reward: gameRewardSchema,
    cycle: z.array(z.object({ step, reward: gameRewardSchema })).length(7).refine(rows => rows.every((row, index) => row.step === index + 1)) }),
  achievementRewards: z.array(achievementRewardSchema).length(21).refine(rows => new Set(rows.map(row => `${row.achievementId}:${row.level}`)).size === 21),
});
export const gameRewardClaimSchema = z.discriminatedUnion("kind", [
  z.object({ requestId: z.string().uuid(), ownerPublicId: owner, kind: z.literal("daily") }).strict(),
  z.object({ requestId: z.string().uuid(), ownerPublicId: owner, kind: z.literal("achievement"), achievementId, level: count.positive().max(4) }).strict(),
]);
const claim = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), step, reward: gameRewardSchema, claimedAt: z.string().datetime() }),
  z.object({ kind: z.literal("achievement"), achievementId, level: count.positive().max(4), reward: gameRewardSchema, claimedAt: z.string().datetime() }),
]);
export const gameRewardResultSchema = z.object({ requestId: z.string().uuid(), rewards: gameRewardsSchema, economy: economyViewSchema,
  acceptedRevision: count, replayed: z.boolean(), claim, message: z.string().max(500) })
  .refine(value => value.rewards.ownerPublicId === value.economy.ownerPublicId && value.acceptedRevision <= value.economy.revision);

export type GameReward = z.infer<typeof gameRewardSchema>;
export type GameRewards = z.infer<typeof gameRewardsSchema>;
export type AchievementReward = GameRewards["achievementRewards"][number];
export type GameRewardClaim = z.infer<typeof gameRewardClaimSchema>;
export type GameRewardResult = z.infer<typeof gameRewardResultSchema>;

async function request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal?: AbortSignal, command?: GameRewardClaim): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 8000);
  try {
    const presence = gamePresenceHeaders();
    const response = await fetch(path, { method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { ...presence, Accept: "application/json", ...(command ? { "Content-Type": "application/json" } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const problem = z.object({ code: z.string(), message: z.string() }).safeParse(body);
      const retry = response.headers.get("Retry-After");
      const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : undefined;
      reportInactivePresence(problem.success ? problem.data.code : undefined, presence);
      throw new ApiError(problem.success ? problem.data.message : "Не удалось получить награды", response.status,
        problem.success ? problem.data : undefined, response.headers.get("X-Request-ID"), delay);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError("Сервер вернул некорректный ответ о награде", 502);
    return parsed.data;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
export const getGameRewards = (signal?: AbortSignal) => request("/api/v1/game/rewards", gameRewardsSchema, signal);
export const claimGameReward = (command: GameRewardClaim, signal?: AbortSignal) => request("/api/v1/game/rewards/claims", gameRewardResultSchema, signal, gameRewardClaimSchema.parse(command));
