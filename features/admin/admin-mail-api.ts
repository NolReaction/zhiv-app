import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { hasUserTextControls } from "@/lib/user-text";
import { adminRequest, verifyAdminActor } from "./admin-api";
import { validAdminReason } from "./admin-input";
import { readAdminAttempt, saveAdminAttempt } from "./admin-attempt-journal";

const publicId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
const title = z.string().min(1).refine(value => !!value.trim() && Array.from(value).length <= 120 && !hasUserTextControls(value));
const body = z.string().min(1).refine(value => !!value.trim() && Array.from(value).length <= 2000 && !hasUserTextControls(value, true));
const count = z.number().int().nonnegative().safe();
export const adminBroadcastSchema = z.object({ requestId: z.string().uuid(), reason: z.string().refine(validAdminReason),
  title, body, audience: z.enum(["all", "players"]), publicIds: z.array(publicId).max(100), notify: z.boolean(), confirmation: z.literal("ОТПРАВИТЬ"),
}).strict().refine(value => new Set(value.publicIds).size === value.publicIds.length
  && (value.audience === "all" ? value.publicIds.length === 0 : value.publicIds.length > 0));
export type AdminBroadcastRequest = z.infer<typeof adminBroadcastSchema>;
const historySchema = z.object({ serverTime: z.string().datetime(), total: count, offset: count, limit: z.number().int().min(1).max(100),
  broadcasts: z.array(z.object({ requestId: z.string().uuid(), actorPublicId: publicId, title, body,
    audience: z.enum(["all", "players"]), notify: z.boolean(), recipientCount: count,
    createdAt: z.string().datetime(), reason: z.string().max(240),
  })).max(100),
});
export type AdminBroadcastHistory = z.infer<typeof historySchema>;
export const readBroadcastAttempt = (actor: string) => readAdminAttempt("mail", actor, "broadcast", adminBroadcastSchema);
export const saveBroadcastAttempt = (actor: string, request: AdminBroadcastRequest | null) => saveAdminAttempt("mail", actor, "broadcast", request);
export async function loadAdminBroadcasts(actor: string, offset: number, signal: AbortSignal) {
  await verifyAdminActor(actor, signal);
  const result = await adminRequest(`mail/broadcast?offset=${offset}&limit=20`, historySchema.refine(value => value.offset === offset && value.limit === 20), signal);
  await verifyAdminActor(actor, signal);
  return result;
}
export async function sendAdminBroadcast(actor: string, request: AdminBroadcastRequest, signal: AbortSignal) {
  if (!adminBroadcastSchema.safeParse(request).success) throw new ApiError("Проверьте текст и получателей рассылки.", 400);
  await verifyAdminActor(actor, signal);
  const result = await adminRequest("mail/broadcast", z.object({ requestId: z.string().uuid(), recipientCount: count,
    createdAt: z.string().datetime(), changed: z.boolean(),
  }).refine(value => value.requestId === request.requestId), signal, request);
  await verifyAdminActor(actor, signal);
  return result;
}
