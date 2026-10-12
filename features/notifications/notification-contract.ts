import { z } from "zod";
import { isValidPublicId, normalizePublicId } from "@/lib/check-in-presentation";
import { isTimeZone } from "@/lib/time-zone";

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const notificationPreferencesSchema = z.object({
  constructionCompleted: z.boolean(),
  explorationCompleted: z.boolean(),
  productionCompleted: z.boolean(),
  checkinReminder: z.boolean(),
  quietHoursEnabled: z.boolean(),
  quietStart: clock,
  quietEnd: clock,
  timeZone: z.string().refine(isTimeZone),
  rateLimitsEnabled: z.boolean().default(true),
  maxPerDay: z.number().int().min(1).max(2),
  minIntervalMinutes: z.number().int().min(60).max(1440),
}).strict().refine(value => value.quietStart !== value.quietEnd, {
  message: "Начало и конец тихих часов должны отличаться", path: ["quietEnd"],
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export function defaultNotificationPreferences(timeZone = "UTC"): NotificationPreferences {
  return { constructionCompleted: true, explorationCompleted: true, productionCompleted: true,
    checkinReminder: false, quietHoursEnabled: true, quietStart: "23:00", quietEnd: "10:00",
    timeZone: isTimeZone(timeZone) ? timeZone : "UTC", rateLimitsEnabled: true, maxPerDay: 2, minIntervalMinutes: 120 };
}
export const notificationSnapshotSchema = z.object({
  ownerPublicId: z.string().min(1), preferences: notificationPreferencesSchema,
  delivery: z.object({ configured: z.boolean(), publicKey: z.string().nullable(), reason: z.string().nullable() }),
  subscription: z.object({ subscribed: z.boolean() }),
});
export type NotificationSnapshot = z.infer<typeof notificationSnapshotSchema>;
/** Match production's push-service allowlist; this is never a generic URL fetch. */
export function isNotificationPushEndpoint(value: string): boolean {
  if (value.length < 20 || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    const authority = /^https:\/\/([^/]+)\//.exec(value)?.[1]?.toLowerCase();
    if (!authority || authority !== url.hostname || url.hash || url.pathname === "/") return false;
    const host = url.hostname;
    return host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" || host === "web.push.apple.com"
      || host.endsWith(".push.apple.com") || host === "wns.windows.com" || host.endsWith(".notify.windows.com");
  } catch { return false; }
}
function validPushKey(value: string, bytes: number, publicKey = false): boolean {
  try {
    const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.length === bytes && (!publicKey || decoded.charCodeAt(0) === 4);
  } catch { return false; }
}
const pushEndpointSchema = z.string().max(2048).refine(isNotificationPushEndpoint);
export const notificationSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}=?$/).refine(value => validPushKey(value, 65, true)),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}(?:==)?$/).refine(value => validPushKey(value, 16)) }).strict(),
}).strict();
export const notificationOwnerSchema = z.string().max(128).transform(normalizePublicId).refine(isValidPublicId);
export const notificationPreferenceRequestSchema = z.object({ expectedOwnerPublicId: notificationOwnerSchema, preferences: notificationPreferencesSchema }).strict();
export const notificationSubscriptionRequestSchema = z.object({ expectedOwnerPublicId: notificationOwnerSchema, subscription: notificationSubscriptionSchema }).strict();
export const notificationUnsubscribeRequestSchema = z.object({ expectedOwnerPublicId: notificationOwnerSchema, endpoint: pushEndpointSchema }).strict();
export const notificationPresenceRequestSchema = z.object({ expectedOwnerPublicId: notificationOwnerSchema }).strict();
