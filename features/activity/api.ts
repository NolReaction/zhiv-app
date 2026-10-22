import { ApiError } from "@/lib/check-in-api";
import { withRequestDeadline, retryAfterMs } from "@/lib/request-deadline";
import { presenceViewSchema, type PresenceCommand } from "./model";
import { gamePresenceHeaders, reportInactivePresence } from "./transport-state";
import { z } from "zod";
export async function sendPresence(command: PresenceCommand, signal?: AbortSignal) {
  return withRequestDeadline(8_000, signal, async requestSignal => {
    const presence = gamePresenceHeaders();
    const response = await fetch("/api/v1/presence", { method: "POST", credentials: "same-origin", cache: "no-store", signal: requestSignal,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...presence }, body: JSON.stringify(command) });
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(body);
      reportInactivePresence(error.success ? error.data.code : undefined, presence);
      throw new ApiError(error.success ? error.data.message : "Не удалось подтвердить подключение к игре", response.status,
        error.success ? error.data : undefined, response.headers.get("X-Request-ID"), retryAfterMs(response.headers.get("Retry-After")));
    }
    const parsed = presenceViewSchema.safeParse(body);
    if (!parsed.success) throw new ApiError("Обновите приложение: изменился формат игровой сессии", 502);
    return parsed.data;
  });
}
