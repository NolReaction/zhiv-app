import { ApiError } from "@/lib/check-in-api";
import { withRequestDeadline } from "@/lib/request-deadline";
import { guestProfileSchema, type GuestProfile } from "./guest-profile-model";

export async function getGuestProfile(ownerPublicId: string, circleId: string, targetPublicId: string, signal?: AbortSignal): Promise<GuestProfile> {
  return withRequestDeadline(8_000, signal, async requestSignal => {
    const response = await fetch(`/api/v1/people/${encodeURIComponent(circleId)}/game-profile`, {
      cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: requestSignal,
    });
    if (!response.ok) throw new ApiError(response.status === 404 ? "Профиль недоступен. Возможно, изменились настройки видимости или связь." : "Не удалось открыть профиль", response.status);
    const parsed = guestProfileSchema.safeParse(await response.json());
    if (!parsed.success) throw new ApiError("Сервер вернул некорректный профиль", 502);
    if (parsed.data.ownerPublicId !== ownerPublicId || parsed.data.circleId !== circleId || parsed.data.user.publicId !== targetPublicId)
      throw new ApiError("Аккаунт или связь изменились. Откройте профиль заново.", 409);
    return parsed.data;
  });
}
