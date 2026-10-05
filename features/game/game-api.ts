import { playerTagSchema } from "@/lib/player-tag";
import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { GAME_ACHIEVEMENT_TARGETS } from "@/features/game/achievement-progress";

const count = z.number().int().nonnegative().safe();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const owner = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);

export const gameProgressSchema = z.object({
  ownerPublicId: owner,
  items: z.array(z.enum(["flower", "leaf_bed", "keepsakes", "leaf_garland"])).max(4).refine(items => new Set(items).size === items.length).default([]),
  lifetimeTaps: count,
  bestSeries: count,
  month,
  monthlyTaps: count,
  leaderboardOptIn: z.boolean(),
  visibilityVersion: count,
  serverTime: z.string().datetime(),
});
export const gameSessionSchema = z.object({
  sessionId: z.string().uuid(),
  nextSequence: count,
  expiresAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().optional(),
  closedAt: z.string().datetime().nullable().optional(),
  progress: gameProgressSchema,
});
const gameBatchSchema = z.object({
  sessionId: z.string().uuid(),
  sequence: count,
  acceptedTaps: count,
  runTaps: count,
  rejectedTaps: count,
  replayed: z.boolean(),
  rejectionCode: z.string().nullable().optional(),
  progress: gameProgressSchema,
});
const gameLeaderboardSchema = z.object({
  ownerPublicId: owner,
  scope: z.enum(["global", "friends"]),
  metric: z.enum(["monthly_taps", "best_series"]).default("monthly_taps"),
  bestSeries: count.default(0),
  month,
  serverTime: z.string().datetime(),
  entries: z.array(z.object({
    rank: z.number().int().positive().safe(),
    displayName: z.string().min(1).max(100),
    tag: playerTagSchema.nullable().optional(),
    taps: count,
    score: count.optional(),
    isMe: z.boolean(),
  }).transform(entry => ({ ...entry, score: entry.score ?? entry.taps }))).max(100),
  myRank: z.number().int().positive().safe().nullable(),
  monthlyTaps: count,
  leaderboardOptIn: z.boolean(),
});

const gameAchievementIdSchema = z.enum(["seven_day_streak", "thousand_taps", "five_friends", "ten_thousand_series", "linked_email", "saved_recovery_code", "full_collection",
  "first_path", "familiar_trails", "explorer", "master_recipes", "home_builder", "river_atlas", "first_sale", "lucky_find"]);
const gameAchievementTierSchema = z.object({ level: count.positive(), progress: count,
  target: count.positive(), unlockedAt: z.string().datetime().nullable() });
const gameAchievementSchema = z.object({
  id: gameAchievementIdSchema,
  progress: count,
  target: z.number().int().positive().safe(),
  unlockedAt: z.string().datetime().nullable(),
  tiers: z.array(gameAchievementTierSchema).min(1).max(4).optional(),
}).refine(value => {
  const targets: readonly number[] = GAME_ACHIEVEMENT_TARGETS[value.id];
  if (!value.tiers) return Object.keys(GAME_ACHIEVEMENT_TARGETS).indexOf(value.id) < 7 && value.target === targets[0]
    && value.progress <= value.target && (!value.unlockedAt || value.progress === value.target);
  if (value.tiers.length !== targets.length || value.tiers.some((tier, index) => tier.level !== index + 1 || tier.target !== targets[index]
    || tier.progress > tier.target || !!tier.unlockedAt && tier.progress !== tier.target
    || !!tier.unlockedAt && index > 0 && !value.tiers![index - 1].unlockedAt)) return false;
  const current = value.tiers.find(tier => !tier.unlockedAt) ?? value.tiers[value.tiers.length - 1];
  return value.unlockedAt === value.tiers[0].unlockedAt && value.target === current.target && value.progress === current.progress;
});
export const gameAchievementsSchema = z.object({
  ownerPublicId: owner,
  serverTime: z.string().datetime(),
  achievements: z.array(gameAchievementSchema).min(3).max(15)
    .refine(items => new Set(items.map(item => item.id)).size === items.length
      && ([3, 6, 7, 15].includes(items.length))
      && items.every((item, index) => item.id === Object.keys(GAME_ACHIEVEMENT_TARGETS)[index])
      && (items.length === 15 ? items.every(item => !!item.tiers) : items.every(item => !item.tiers))),
});

export type GameProgress = z.infer<typeof gameProgressSchema>;
export type GameSession = z.infer<typeof gameSessionSchema>;
export type GameBatchResponse = z.infer<typeof gameBatchSchema>;
export type GameLeaderboard = z.infer<typeof gameLeaderboardSchema>;
export type GameLeaderboardMetric = GameLeaderboard["metric"];
export type GameLeaderboardScope = GameLeaderboard["scope"];
export type GameAchievementId = z.infer<typeof gameAchievementIdSchema>;
export type GameAchievement = z.infer<typeof gameAchievementSchema>;
export type GameAchievementTier = z.infer<typeof gameAchievementTierSchema>;
export type GameAchievements = z.infer<typeof gameAchievementsSchema>;
export type GameSessionRequest = { requestId: string; ownerPublicId: string };
export type GameBatchRequest = { sessionId: string; sequence: number; tapCount: number; runId: string; tapTimes?: number[] };
export type GameVisibilityRequest = { leaderboardOptIn: boolean; expectedVersion: number; ownerPublicId: string };

async function gameRequest<T>(
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  method: "GET" | "POST" | "PATCH",
  body: unknown,
  externalSignal?: AbortSignal,
): Promise<T> {
  // A caller-owned signal must not remove the network timeout.
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      keepalive: method !== "GET",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = (response.headers.get("content-type") ?? "").includes("application/json")
      ? await response.json().catch(() => undefined) : undefined;
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(value);
      throw new ApiError(error.success ? error.data.message : "Не удалось загрузить игровой прогресс", response.status,
        error.success ? error.data : undefined, response.headers.get("X-Request-ID"), parseRetryAfter(response.headers.get("Retry-After")));
    }
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError("Сервер вернул некорректный игровой ответ", 502);
    return result.data;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

export function getGameProgress(signal?: AbortSignal): Promise<GameProgress> {
  return gameRequest("/api/v1/game/progress", gameProgressSchema, "GET", undefined, signal);
}
export function createGameSession(body: GameSessionRequest, signal?: AbortSignal): Promise<GameSession> {
  return gameRequest("/api/v1/game/sessions", gameSessionSchema, "POST", body, signal);
}
export function submitGameBatch(body: GameBatchRequest, signal?: AbortSignal): Promise<GameBatchResponse> {
  return gameRequest("/api/v1/game/batches", gameBatchSchema, "POST", body, signal);
}
export function getGameLeaderboard(scope: GameLeaderboardScope = "global", signal?: AbortSignal, metric: GameLeaderboardMetric = "monthly_taps"): Promise<GameLeaderboard> {
  return gameRequest(`/api/v1/game/leaderboard?scope=${scope}&metric=${metric}`, gameLeaderboardSchema, "GET", undefined, signal);
}
export function getGameAchievements(signal?: AbortSignal): Promise<GameAchievements> {
  return gameRequest("/api/v1/game/achievements?catalog=5", gameAchievementsSchema, "GET", undefined, signal);
}
export function updateGameVisibility(body: GameVisibilityRequest, signal?: AbortSignal): Promise<GameProgress> {
  return gameRequest("/api/v1/game/visibility", gameProgressSchema, "PATCH", body, signal);
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(1000, Math.min(3_600_000, delay)) : undefined;
}
