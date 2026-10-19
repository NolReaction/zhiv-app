import { ApiError } from "@/lib/check-in-api";
import { withRequestDeadline } from "@/lib/request-deadline";
import { guestWorldSchema, type GuestWorld, type GuestWorldTarget } from "./guest-world-model";

/** Bind even a valid response to the exact account and friend that requested it. */
export async function getGuestWorld(ownerPublicId: string, target: GuestWorldTarget, signal?: AbortSignal): Promise<GuestWorld> {
  return withRequestDeadline(10_000, signal, async requestSignal => {
    const response = await fetch(`/api/v1/people/${encodeURIComponent(target.circleId)}/world`, {
      cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: requestSignal,
    });
    if (!response.ok) throw new ApiError(response.status === 404
      ? "Мир недоступен. Возможно, изменились настройки видимости или дружба."
      : response.status === 401 ? "Войдите в аккаунт, чтобы прийти в гости." : "Не удалось открыть мир друга. Попробуйте ещё раз.", response.status);
    const parsed = guestWorldSchema.safeParse(await response.json());
    if (!parsed.success) throw new ApiError("Не удалось прочитать мир друга. Обновите приложение.", 502);
    if (parsed.data.ownerPublicId !== ownerPublicId || parsed.data.circleId !== target.circleId || parsed.data.user.publicId !== target.targetPublicId)
      throw new ApiError("Аккаунт или друг изменились. Откройте мир заново.", 409);
    return parsed.data;
  });
}
