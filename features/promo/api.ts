import { gamePresenceHeaders, reportInactivePresence } from "@/features/activity/transport-state";
import { ApiError } from "@/lib/check-in-api";
import { promoResultSchema, type PromoRequest } from "./model";

export async function redeemPromoCode(command: PromoRequest) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000);
  const presence = gamePresenceHeaders();
  try {
    const response = await fetch("/api/v1/economy/promo", { method: "POST", credentials: "same-origin", cache: "no-store",
      signal: controller.signal, headers: { ...presence, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(command) });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      reportInactivePresence(body?.code, presence);
      throw new ApiError(typeof body?.message === "string" ? body.message : "Не удалось проверить промокод", response.status,
        typeof body?.code === "string" ? { code: body.code, message: body.message } : undefined, response.headers.get("X-Request-ID"),
        response.status === 429 ? Number(response.headers.get("Retry-After") ?? 60) * 1000 : undefined);
    }
    const result = promoResultSchema.safeParse(body);
    if (!result.success || result.data.state.ownerPublicId !== command.ownerPublicId) throw new ApiError("Не удалось подтвердить подарок. Повторите проверку.", 502);
    return result.data;
  } finally { clearTimeout(timeout); }
}
