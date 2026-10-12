import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken, NO_STORE_HEADERS } from "@/lib/dev/api-route";
import { getDevNotifications } from "@/lib/dev/notifications-store";
import { devNotificationResponse, notificationError } from "@/lib/dev/notifications-route";
import { notificationPresenceRequestSchema } from "@/features/notifications/notification-contract";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  const body = notificationPresenceRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return notificationError(400, "INVALID_NOTIFICATION_REQUEST", "Укажите профиль");
  const result = getDevNotifications(await devSessionToken(), body.data.expectedOwnerPublicId);
  if (result.kind !== "ok") return devNotificationResponse(result);
  return NextResponse.json({ status: "ok" }, { headers: NO_STORE_HEADERS });
}
