import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { adminRequest, verifyAdminActor } from "./admin-api";

export const adminApiUsagePeriodSchema = z.enum(["current_billing_period", "past_30_days", "past_90_days"]);
export type AdminApiUsagePeriod = z.infer<typeof adminApiUsagePeriodSchema>;
const count = z.number().int().nonnegative().safe();
const instant = z.string().datetime();
const date = z.string().date();
const providerValue = z.number().finite().nonnegative();
const bucket = z.object({ date, value: providerValue });
const group = z.object({
  group: z.enum(["request", "session", "export"]), total: providerValue.nullable(),
  daily: z.array(bucket).max(366), estimated: z.array(bucket).max(366),
}).refine(value => {
  const total = value.daily.reduce((sum, item) => sum + item.value, 0);
  return new Set(value.daily.map(item => item.date)).size === value.daily.length
    && new Set(value.estimated.map(item => item.date)).size === value.estimated.length
    && (value.daily.length === 0 ? value.total === null : value.total !== null
      && Number.isFinite(total) && Math.abs(total - value.total) <= Math.max(1, total, value.total) * Number.EPSILON * 366);
});
const maptiler = z.object({
  configured: z.boolean(), available: z.boolean(),
  error: z.enum(["MAPTILER_DISABLED", "MAPTILER_ACCESS_DENIED", "MAPTILER_RATE_LIMITED", "MAPTILER_PERIOD_UNAVAILABLE", "MAPTILER_UNAVAILABLE"]).nullable(),
  period: adminApiUsagePeriodSchema, scope: z.literal("account"),
  since: date.nullable(), until: date.nullable(), updatedAt: instant.nullable(),
  groups: z.array(group).max(3),
}).refine(value => new Set(value.groups.map(item => item.group)).size === value.groups.length
  && (value.available
    ? value.configured && value.error === null && value.since !== null && value.until !== null && value.updatedAt !== null && value.since <= value.until
    : value.error !== null && value.groups.length === 0 && value.since === null && value.until === null && value.updatedAt === null)
  && (value.configured ? value.error !== "MAPTILER_DISABLED" : !value.available && value.error === "MAPTILER_DISABLED")
  && value.groups.every(item => item.daily.every(bucket => value.since !== null && value.until !== null && bucket.date >= value.since && bucket.date <= value.until)));

export const adminApiUsageSchema = z.object({
  actorPublicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/),
  serverTime: instant,
  api: z.object({ startedAt: instant, requests: count, errors: count, throttled: count })
    .refine(value => value.errors <= value.requests && value.throttled <= value.requests && value.errors + value.throttled <= value.requests),
  maptiler,
}).refine(value => Date.parse(value.api.startedAt) <= Date.parse(value.serverTime)
  && (value.maptiler.updatedAt === null || Date.parse(value.maptiler.updatedAt) <= Date.parse(value.serverTime)));

export type AdminApiUsage = z.infer<typeof adminApiUsageSchema>;

export async function loadAdminApiUsage(actor: string, period: AdminApiUsagePeriod, signal: AbortSignal): Promise<AdminApiUsage> {
  const selected = adminApiUsagePeriodSchema.parse(period);
  await verifyAdminActor(actor, signal);
  const result = await adminRequest(`api-usage?period=${encodeURIComponent(selected)}`, adminApiUsageSchema, signal);
  if (result.actorPublicId !== actor) throw new ApiError("Аккаунт администратора сменился. Откройте панель заново.", 403);
  if (result.maptiler.period !== selected) throw new ApiError("Получен другой период статистики API. Повторите запрос.", 502);
  await verifyAdminActor(actor, signal);
  return result;
}
