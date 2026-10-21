import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { adminRequest, verifyAdminActor } from "./admin-api";

const count = z.number().int().nonnegative().safe();
const publicId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
const instant = z.string().datetime();
const reason = z.enum(["REQUEST_BURST", "ACCESS_DENIED_BURST", "THROTTLED_BURST"]);
const signalSchema = z.object({
  publicId: publicId.nullable(), displayName: z.string().max(200).nullable(),
  operation: z.string().min(1).max(120), method: z.string().regex(/^[A-Z]{1,12}$/),
  windowStartedAt: instant, lastAt: instant, requests: count,
  denied: count, throttled: count, serverErrors: count,
  reasons: z.array(reason).min(1).max(3),
}).refine(value => value.requests > 0 && value.denied <= value.requests
  && value.throttled <= value.requests && value.serverErrors <= value.requests
  && new Set(value.reasons).size === value.reasons.length
  && (value.publicId !== null || value.displayName === null)
  && Date.parse(value.windowStartedAt) <= Date.parse(value.lastAt));
const trafficSchema = z.object({
  actorPublicId: publicId, serverTime: instant, startedAt: instant,
  retentionSeconds: z.literal(900), capacity: count.min(1), evicted: count,
  signals: z.array(signalSchema).max(100),
}).refine(value => Date.parse(value.startedAt) <= Date.parse(value.serverTime)
  && value.signals.length <= value.capacity
  && value.signals.every(signal => Date.parse(signal.lastAt) <= Date.parse(value.serverTime))
  && new Set(value.signals.map(signal => JSON.stringify([
    signal.publicId, signal.operation, signal.method, signal.windowStartedAt,
  ]))).size === value.signals.length);

export type AdminRequestTraffic = z.infer<typeof trafficSchema>;

export async function loadAdminRequestTraffic(actor: string, signal: AbortSignal): Promise<AdminRequestTraffic> {
  await verifyAdminActor(actor, signal);
  const result = await adminRequest("request-traffic", trafficSchema, signal);
  if (result.actorPublicId !== actor) throw new ApiError("Аккаунт администратора сменился. Откройте панель заново.", 403);
  await verifyAdminActor(actor, signal);
  return result;
}
