import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken } from "@/lib/dev/api-route";
import { getDevNotifications } from "@/lib/dev/notifications-store";
import { devNotificationResponse, notificationError } from "@/lib/dev/notifications-route";
import { notificationOwnerSchema } from "@/features/notifications/notification-contract";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const owner = notificationOwnerSchema.safeParse(new URL(request.url).searchParams.get("expectedOwnerPublicId"));
  if (!owner.success) return notificationError(400, "INVALID_NOTIFICATION_REQUEST", "Укажите профиль для настройки уведомлений");
  return devNotificationResponse(getDevNotifications(await devSessionToken(), owner.data));
}
