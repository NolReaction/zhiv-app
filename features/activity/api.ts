import { ApiError } from "@/lib/check-in-api";
import { withRequestDeadline, retryAfterMs } from "@/lib/request-deadline";
import { presenceViewSchema, type PresenceCommand } from "./model";
export async function sendPresence(command: PresenceCommand, signal?: AbortSignal) {
  return withRequestDeadline(8_000, signal, async requestSignal => {
    const response = await fetch("/api/v1/presence", { method: "POST", credentials: "same-origin", cache: "no-store", signal: requestSignal,
      headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(command) });
    const body: unknown = await response.json();
    if (!response.ok) throw new ApiError("Не удалось подтвердить подключение к игре", response.status, undefined,
      response.headers.get("X-Request-ID"), retryAfterMs(response.headers.get("Retry-After")));
    const parsed = presenceViewSchema.safeParse(body);
    if (!parsed.success) throw new ApiError("Обновите приложение: изменился формат игровой сессии", 502);
    return parsed.data;
  });
}
