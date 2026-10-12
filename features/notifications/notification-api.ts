import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { withRequestDeadline } from "@/lib/request-deadline";
import { notificationSnapshotSchema, type NotificationPreferences } from "./notification-contract";

async function request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, body?: unknown, method = body === undefined ? "GET" : "POST", signal?: AbortSignal): Promise<T> {
  return withRequestDeadline(15_000, signal, async requestSignal => {
    const response = await fetch(`/api/v1/notifications${path}`, { method, credentials: "same-origin", cache: "no-store", signal: requestSignal,
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(value);
      throw new ApiError(error.success ? error.data.message : "Не удалось сохранить настройки уведомлений", response.status, error.success ? error.data : undefined);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiError("Сервер вернул некорректные настройки уведомлений", 502);
    return parsed.data;
  });
}
export async function getNotificationSettings(owner: string, signal?: AbortSignal) {
  const result = await request(`?expectedOwnerPublicId=${encodeURIComponent(owner)}`, notificationSnapshotSchema, undefined, "GET", signal);
  if (result.ownerPublicId !== owner) throw new ApiError("Профиль изменился. Откройте настройки заново", 409);
  return result;
}
export const saveNotificationPreferences = (expectedOwnerPublicId: string, preferences: NotificationPreferences) =>
  request("/preferences", notificationSnapshotSchema, { expectedOwnerPublicId, preferences }, "PUT");
export const saveNotificationSubscription = (expectedOwnerPublicId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
  request("/subscriptions", notificationSnapshotSchema, { expectedOwnerPublicId, subscription });
export const removeNotificationSubscription = (expectedOwnerPublicId: string, endpoint: string) =>
  request("/subscriptions", notificationSnapshotSchema, { expectedOwnerPublicId, endpoint }, "DELETE");
export const reportNotificationPresence = (expectedOwnerPublicId: string) =>
  request("/presence", z.object({ status: z.literal("ok") }), { expectedOwnerPublicId });
