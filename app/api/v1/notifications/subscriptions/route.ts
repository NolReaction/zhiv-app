import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken } from "@/lib/dev/api-route";
import { getDevNotifications } from "@/lib/dev/notifications-store";
import { devNotificationResponse, notificationError } from "@/lib/dev/notifications-route";
import { notificationSubscriptionRequestSchema, notificationUnsubscribeRequestSchema } from "@/features/notifications/notification-contract";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const rejected = guardDevApi(request, true, 4096);
  if (rejected) return rejected;
  const body = notificationSubscriptionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return notificationError(400, "INVALID_PUSH_SUBSCRIPTION", "Не удалось проверить подписку устройства");
  const result = getDevNotifications(await devSessionToken(), body.data.expectedOwnerPublicId);
  if (result.kind !== "ok") return devNotificationResponse(result);
  return notificationError(503, "PUSH_NOT_CONFIGURED", "Отправка уведомлений ещё не подключена");
}
export async function DELETE(request: Request) {
  const rejected = guardDevApi(request, true, 4096);
  if (rejected) return rejected;
  const body = notificationUnsubscribeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return notificationError(400, "INVALID_PUSH_SUBSCRIPTION", "Не удалось проверить подписку устройства");
  return devNotificationResponse(getDevNotifications(await devSessionToken(), body.data.expectedOwnerPublicId));
}
