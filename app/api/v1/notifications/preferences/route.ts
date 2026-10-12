import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken } from "@/lib/dev/api-route";
import { saveDevNotificationPreferences } from "@/lib/dev/notifications-store";
import { devNotificationResponse, notificationError } from "@/lib/dev/notifications-route";
import { notificationPreferenceRequestSchema } from "@/features/notifications/notification-contract";
export const dynamic = "force-dynamic";
export async function PUT(request: Request) {
  const rejected = guardDevApi(request, true, 4096);
  if (rejected) return rejected;
  const body = notificationPreferenceRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return notificationError(400, "INVALID_NOTIFICATION_PREFERENCES", "Проверьте настройки уведомлений и тихие часы");
  return devNotificationResponse(saveDevNotificationPreferences(await devSessionToken(), body.data.expectedOwnerPublicId, body.data.preferences));
}
