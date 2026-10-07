import { gamePresenceHeaders, reportInactivePresence } from "@/features/activity/transport-state";
import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { retryAfterMs, withRequestDeadline } from "@/lib/request-deadline";
import { barterResultSchema, barterViewSchema, type BarterCommand } from "./barter-model";

async function request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, command?: BarterCommand, signal?: AbortSignal): Promise<T> {
  return withRequestDeadline(10_000, signal, async requestSignal => {
    const presence = gamePresenceHeaders();
    const response = await fetch(path, {
      method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: requestSignal,
      headers: { ...presence, Accept: "application/json", ...(command ? { "Content-Type": "application/json" } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(body);
      reportInactivePresence(error.success ? error.data.code : undefined, presence);
      throw new ApiError(error.success ? error.data.message : "Не удалось открыть обмен", response.status,
        error.success ? error.data : undefined, response.headers.get("X-Request-ID"), retryAfterMs(response.headers.get("Retry-After")));
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError("Ответ обмена не распознан. Обновите приложение.", 502);
    return parsed.data;
  });
}
export async function getEconomyBarter(owner: string, signal?: AbortSignal) {
  const result = await request("/api/v1/economy/barter", barterViewSchema, undefined, signal);
  if (result.ownerPublicId !== owner) throw new ApiError("Аккаунт изменился. Войдите в свой профиль заново.", 401);
  return result;
}
export async function sendBarterCommand(command: BarterCommand, signal?: AbortSignal) {
  const result = await request("/api/v1/economy/barter/commands", barterResultSchema, command, signal);
  if (result.state.ownerPublicId !== command.ownerPublicId) throw new ApiError("Аккаунт изменился. Войдите в свой профиль заново.", 401);
  return result;
}
