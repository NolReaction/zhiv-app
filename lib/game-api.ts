import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";

const count = z.number().int().nonnegative().safe();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const owner = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);

export const gameProgressSchema = z.object({
  ownerPublicId: owner,
  lifetimeTaps: count,
  bestSeries: count,
  month,
  monthlyTaps: count,
  leaderboardOptIn: z.boolean(),
  visibilityVersion: count,
  serverTime: z.string().datetime(),
});
const gameSessionSchema = z.object({
  sessionId: z.string().uuid(),
  nextSequence: count,
  expiresAt: z.string().datetime(),
  progress: gameProgressSchema,
});
const gameBatchSchema = z.object({
  sessionId: z.string().uuid(),
  sequence: count,
  acceptedTaps: count,
  runTaps: count,
  rejectedTaps: count,
  replayed: z.boolean(),
  progress: gameProgressSchema,
});
const gameLeaderboardSchema = z.object({
  ownerPublicId: owner,
  scope: z.enum(["global", "friends"]),
  month,
  serverTime: z.string().datetime(),
  entries: z.array(z.object({
    rank: z.number().int().positive().safe(),
    displayName: z.string().min(1).max(100),
    taps: count,
    isMe: z.boolean(),
  })).max(100),
  myRank: z.number().int().positive().safe().nullable(),
  monthlyTaps: count,
  leaderboardOptIn: z.boolean(),
});

const gameAchievementIdSchema = z.enum(["seven_day_streak", "thousand_taps", "five_friends"]);
const gameAchievementSchema = z.object({
  id: gameAchievementIdSchema,
  progress: count,
  target: z.number().int().positive().safe(),
  unlockedAt: z.string().datetime().nullable(),
}).refine(value => value.target === ({ seven_day_streak: 7, thousand_taps: 1000, five_friends: 5 })[value.id]
  && value.progress <= value.target && (!value.unlockedAt || value.progress === value.target));
const gameAchievementsSchema = z.object({
  ownerPublicId: owner,
  serverTime: z.string().datetime(),
  achievements: z.array(gameAchievementSchema).length(3)
    .refine(items => new Set(items.map(item => item.id)).size === 3),
});

export type GameProgress = z.infer<typeof gameProgressSchema>;
export type GameSession = z.infer<typeof gameSessionSchema>;
export type GameBatchResponse = z.infer<typeof gameBatchSchema>;
export type GameLeaderboard = z.infer<typeof gameLeaderboardSchema>;
export type GameLeaderboardScope = GameLeaderboard["scope"];
export type GameAchievementId = z.infer<typeof gameAchievementIdSchema>;
export type GameAchievement = z.infer<typeof gameAchievementSchema>;
export type GameAchievements = z.infer<typeof gameAchievementsSchema>;
export type GameSessionRequest = { requestId: string; ownerPublicId: string };
export type GameBatchRequest = { sessionId: string; sequence: number; tapCount: number; runId: string };
export type GameVisibilityRequest = { leaderboardOptIn: boolean; expectedVersion: number; ownerPublicId: string };

async function gameRequest<T>(
  path: string,
  schema: z.ZodType<T>,
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
        error.success ? error.data : undefined, response.headers.get("X-Request-ID"));
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
export function getGameLeaderboard(scope: GameLeaderboardScope = "global", signal?: AbortSignal): Promise<GameLeaderboard> {
  return gameRequest(`/api/v1/game/leaderboard?scope=${scope}`, gameLeaderboardSchema, "GET", undefined, signal);
}
export function getGameAchievements(signal?: AbortSignal): Promise<GameAchievements> {
  return gameRequest("/api/v1/game/achievements", gameAchievementsSchema, "GET", undefined, signal);
}
export function updateGameVisibility(body: GameVisibilityRequest, signal?: AbortSignal): Promise<GameProgress> {
  return gameRequest("/api/v1/game/visibility", gameProgressSchema, "PATCH", body, signal);
}
