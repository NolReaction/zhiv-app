import { z } from "zod";
import { GAME_ITEMS, GAME_ACHIEVEMENTS, type GameItemId } from "@/features/game/game-rewards";
import type { GameAchievementId } from "@/features/game/game-api";
import { ApiError } from "@/lib/check-in-api";

const count = z.number().int().nonnegative().safe();
const publicId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
const instant = z.string().datetime();
const page = { serverTime: instant, total: count, offset: count, limit: z.number().int().min(1).max(100) };
const accessSchema = z.object({ publicId, displayName: z.string(), serverTime: instant });
const retentionSchema = z.object({ eligible: count, returned: count, rate: z.number().min(0).max(100).nullable() });
const overviewSchema = z.object({
  serverTime: instant, days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  totals: z.object({ users: count, checkIns: count, connections: count, groups: count, lifetimeTaps: count }),
  active: z.object({ last24Hours: count, last7Days: count, last30Days: count }),
  newUsersPeriod: count, checkInsPeriod: count,
  retention: z.object({ day1: retentionSchema, day7: retentionSchema }),
  daily: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), registrations: count, activeUsers: count, checkIns: count })).max(90),
  game: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), taps: count, bestSeries: count, participants: count, achievements: count }),
  services: z.object({ databaseReady: z.boolean(), databaseBytes: count, databaseConnections: count, activeSessions: count }),
});
const userSchema = z.object({
  publicId, displayName: z.string(), createdAt: instant, lastCheckInAt: instant.nullable(),
  checkInCount: count, friendCount: count, lifetimeTaps: count, bestSeries: count, monthlyTaps: count,
  leaderboardOptIn: z.boolean(), activeSessions: count, loginMethods: z.array(z.string()).max(10), isAdmin: z.boolean(),
});
const usersSchema = z.object({ ...page, users: z.array(userSchema).max(100) });
const auditSchema = z.object({ ...page, events: z.array(z.object({
  requestId: z.string().uuid(), actorPublicId: publicId, targetPublicId: publicId,
  action: z.enum(["revoke_sessions", "grant_item", "grant_achievement"]), rewardId: z.string().nullable().default(null), granted: z.boolean().nullable().default(null), reason: z.string().max(240), affectedSessions: count, createdAt: instant,
})).max(100) });
const metric = z.number().finite().nullable();
const monitoringSchema = z.object({
  serverTime: instant, configured: z.boolean(), available: z.boolean(), error: z.string().nullable(), rangeMinutes: z.union([z.literal(60), z.literal(360), z.literal(1440), z.literal(10080)]),
  summary: z.object({ cpuPercent: metric, memoryUsedBytes: metric, memoryTotalBytes: metric, load1: metric,
    diskUsedBytes: metric, diskTotalBytes: metric, requestRate: metric, errorRate: metric, throttledRate: metric.optional(),
    p95LatencyMs: metric, gameAcceptedRate: metric, gameRejectedRate: metric }),
  samples: z.array(z.object({ at: instant, cpuPercent: metric, memoryPercent: metric, requestRate: metric, errorRate: metric, throttledRate: metric.optional(), p95LatencyMs: metric })).max(121),
  health: z.array(z.object({ name: z.string(), status: z.enum(["up", "down", "unknown"]) })).max(10),
  alerts: z.array(z.object({ name: z.string(), severity: z.enum(["warning", "critical"]),
    state: z.enum(["pending", "firing"]), summary: z.string(), activeAt: instant.nullable() })).max(20),
});

export type AdminAccess = z.infer<typeof accessSchema>;
export type AdminOverview = z.infer<typeof overviewSchema>;
export type AdminUser = z.infer<typeof userSchema>;
export type AdminUsers = z.infer<typeof usersSchema>;
export type AdminAudit = z.infer<typeof auditSchema>;
export type AdminMonitoring = z.infer<typeof monitoringSchema>;
export type AdminRevokeRequest = { requestId: string; confirmationPublicId: string; reason: string };

async function adminRequest<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal?: AbortSignal, body?: AdminRevokeRequest | AdminGrantRequest): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/v1/admin/${path}`, {
      method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = z.object({ code: z.string(), message: z.string() }).safeParse(value);
      throw new ApiError(parsed.success ? parsed.data.message : "Не удалось обновить панель", response.status,
        parsed.success ? parsed.data : undefined, response.headers.get("X-Request-ID"));
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiError("Не удалось проверить данные панели", 502);
    return parsed.data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export const getAdminAccess = (signal?: AbortSignal) => adminRequest("access", accessSchema, signal);
export const getAdminOverview = (days: 7 | 30 | 90, signal?: AbortSignal) => adminRequest(`overview?days=${days}`, overviewSchema, signal);
export function getAdminUsers(options: { q: string; sort: "created" | "activity" | "taps"; offset: number; limit: number }, signal?: AbortSignal) {
  const query = new URLSearchParams({ q: options.q, sort: options.sort, offset: String(options.offset), limit: String(options.limit) });
  return adminRequest(`users?${query}`, usersSchema, signal);
}
export function getAdminAudit(options: { offset: number; limit: number }, signal?: AbortSignal) {
  return adminRequest(`audit?offset=${options.offset}&limit=${options.limit}`, auditSchema, signal);
}
export const getAdminMonitoring = (signal?: AbortSignal, rangeMinutes = 60) => adminRequest(`monitoring?rangeMinutes=${rangeMinutes}`, monitoringSchema, signal);
export function revokeAdminSessions(targetPublicId: string, body: AdminRevokeRequest, signal?: AbortSignal) {
  return adminRequest(`users/${encodeURIComponent(targetPublicId)}/revoke-sessions`,
    z.object({ requestId: z.string().uuid(), affectedSessions: count, createdAt: instant }), signal, body);
}

const rewardIdSchema = z.string().refine(id => [...GAME_ITEMS, ...GAME_ACHIEVEMENTS].some(item => item.id === id));
const rewardsSchema = z.object({ publicId, serverTime: instant,
  items: z.array(z.custom<GameItemId>(id => GAME_ITEMS.some(item => item.id === id))).max(4),
  achievements: z.array(z.custom<GameAchievementId>(id => GAME_ACHIEVEMENTS.some(item => item.id === id))).max(6),
});
export type AdminRewards = z.infer<typeof rewardsSchema>;
export type AdminGrantRequest = AdminRevokeRequest & { kind: "item" | "achievement"; rewardId: GameItemId | GameAchievementId };
export function getAdminRewards(target: string, signal?: AbortSignal) {
  return adminRequest(`users/${encodeURIComponent(target)}/rewards`, rewardsSchema, signal);
}
export function grantAdminReward(target: string, body: AdminGrantRequest, signal?: AbortSignal) {
  return adminRequest(`users/${encodeURIComponent(target)}/grant-reward`,
    z.object({ requestId: z.string().uuid(), kind: z.enum(["item", "achievement"]), rewardId: rewardIdSchema, granted: z.boolean(), createdAt: instant }), signal, body);
}

const incidentsSchema = z.object({ ...page, totalOccurrences: count, affectedUsers: count, events: z.array(z.object({
  id: count, publicId, displayName: z.string(), source: z.enum(["client", "server"]),
  operation: z.string().max(100), code: z.string().max(64), occurredAt: instant, receivedAt: instant,
  requestId: z.string().uuid().nullable(), httpStatus: z.number().int().min(100).max(599).nullable(), pendingTaps: count, occurrences: count,
})).max(100) });
export type AdminIncidents = z.infer<typeof incidentsSchema>;
export function getAdminIncidents(options: { rangeMinutes: number; q: string; offset: number; source?: "" | "client" | "server"; code?: string }, signal?: AbortSignal) {
  return adminRequest(`incidents?${new URLSearchParams({ rangeMinutes: String(options.rangeMinutes), q: options.q, source: options.source ?? "", code: options.code ?? "", offset: String(options.offset), limit: "25" })}`, incidentsSchema, signal);
}
