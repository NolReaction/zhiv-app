import { z } from "zod";
import { gameplayGenerationHeaders, reportGameplayReset } from "@/lib/gameplay-generation";
import { ApiError } from "@/lib/check-in-api";
import { retryAfterMs, withRequestDeadline } from "@/lib/request-deadline";
import { mailboxPageSchema, mailReadResultSchema, mailClaimResultSchema } from "./model";

async function request<T>(path: string, owner: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal?: AbortSignal, body?: unknown) {
  return withRequestDeadline(10_000, signal, async requestSignal => {
    const generation = gameplayGenerationHeaders();
    const response = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: requestSignal,
      headers: { Accept: "application/json", ...generation, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(raw);
      reportGameplayReset(error.success ? error.data.code : undefined, generation);
      throw new ApiError(error.success ? error.data.message : "Не удалось открыть почту", response.status,
        error.success ? error.data : undefined, response.headers.get("X-Request-ID"), retryAfterMs(response.headers.get("Retry-After")));
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ApiError("Ответ почты не распознан. Обновите приложение.", 502);
    if ((parsed.data as { ownerPublicId?: string }).ownerPublicId !== owner)
      throw new ApiError("Аккаунт изменился. Откройте свой профиль заново.", 401);
    return parsed.data;
  });
}
export function getMailbox(owner: string, cursor: string | null, signal?: AbortSignal) {
  const query = new URLSearchParams({ expectedOwnerPublicId: owner, limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return request(`/api/v1/mail?${query}`, owner, mailboxPageSchema, signal);
}
export function markMailRead(owner: string, id: string, signal?: AbortSignal) {
  if (!z.string().uuid().safeParse(id).success) return Promise.reject(new ApiError("Письмо не найдено", 400));
  return request(`/api/v1/mail/${encodeURIComponent(id)}/read`, owner, mailReadResultSchema, signal, { expectedOwnerPublicId: owner });
}
export function claimMailGift(owner: string, id: string, signal?: AbortSignal) {
  if (!z.string().uuid().safeParse(id).success) return Promise.reject(new ApiError("Письмо не найдено", 400));
  return request(`/api/v1/mail/${encodeURIComponent(id)}/claim`, owner, mailClaimResultSchema, signal, { expectedOwnerPublicId: owner });
}
