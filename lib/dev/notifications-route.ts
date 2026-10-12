import { NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "./api-route";
import type { DevNotificationResult } from "./notifications-store";
export function notificationError(status: number, code: string, message: string) {
  return NextResponse.json({ code, message }, { status, headers: NO_STORE_HEADERS });
}
export function devNotificationResponse(result: DevNotificationResult) {
  if (result.kind === "unauthorized") return notificationError(401, "UNAUTHORIZED", "Сессия не найдена");
  if (result.kind === "owner-mismatch") return notificationError(409, "NOTIFICATION_OWNER_MISMATCH", "Профиль изменился. Откройте настройки заново");
  return NextResponse.json(result.value, { headers: NO_STORE_HEADERS });
}
