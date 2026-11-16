import { z } from "zod";
import { apiFetch } from "@/lib/api-fetch";
import { ApiError } from "@/lib/check-in-api";
import { withRequestDeadline } from "@/lib/request-deadline";
import { notificationPreferencesSchema } from "./notification-contract";
import type { RemotePushPlatform, RemotePushServerSnapshot } from "./native-remote-push";

const nativeSnapshotSchema = z.object({
  ownerPublicId: z.string().min(1), preferences: notificationPreferencesSchema,
  delivery: z.object({ configured: z.boolean(), reason: z.string().nullable(), platform: z.enum(["ios", "android"]), categories: z.array(z.string()) }),
  subscription: z.object({ subscribed: z.boolean() }),
});
async function request(owner: string, platform: RemotePushPlatform, method: "GET" | "POST" | "DELETE", token?: string): Promise<RemotePushServerSnapshot> {
  return withRequestDeadline(15_000, undefined, async signal => {
    const path = method === "GET" ? `?expectedOwnerPublicId=${encodeURIComponent(owner)}&platform=${platform}` : "/subscriptions";
    const response = await apiFetch(`/api/v1/notifications/native${path}`, {
      method, signal, cache: "no-store", headers: { Accept: "application/json", ...(method === "GET" ? {} : { "Content-Type": "application/json" }) },
      body: method === "GET" ? undefined : JSON.stringify({ expectedOwnerPublicId: owner, platform, ...(token ? { token } : {}) }),
    });
    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const problem = z.object({ code: z.string(), message: z.string() }).safeParse(raw);
      throw new ApiError(problem.success ? problem.data.message : "Не удалось обновить сообщения сервера.", response.status, problem.success ? problem.data : undefined);
    }
    const parsed = nativeSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new ApiError("Сервер вернул некорректное подключение уведомлений.", 502);
    if (parsed.data.ownerPublicId !== owner || parsed.data.delivery.platform !== platform) throw new ApiError("Профиль изменился. Откройте настройки заново.", 409);
    return parsed.data;
  });
}
export const getNativePushSettings = (owner: string, platform: RemotePushPlatform) => request(owner, platform, "GET");
export const subscribeNativePush = (owner: string, platform: RemotePushPlatform, token: string) => request(owner, platform, "POST", token);
export const unsubscribeNativePush = (owner: string, platform: RemotePushPlatform) => request(owner, platform, "DELETE");
