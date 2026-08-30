import { NextResponse } from "next/server";
import type { DevResult } from "@/lib/dev-api-store";
import { NO_STORE_HEADERS } from "@/lib/dev-api-route";

export function directInviteResultError<T>(
  result: Exclude<DevResult<T>, { kind: "ok" }>,
) {
  const errors = {
    unauthorized: [401, "UNAUTHORIZED", "Сессия не найдена"],
    "not-found": [404, "INVITE_NOT_FOUND", "Приглашение не найдено"],
    self: [409, "CANNOT_ADD_SELF", "Нельзя принять свою ссылку"],
    expired: [410, "INVITE_EXPIRED", "Ссылка уже недействительна"],
    conflict: [409, "INVITE_CONFLICT", "Ссылка уже использована"],
    forbidden: [403, "INVITE_FORBIDDEN", "Действие недоступно"],
    "already-connected": [409, "INVITE_CONFLICT", "Вы уже на связи"],
    "limit-reached": [409, "INVITE_CONFLICT", "Состояние ссылки уже изменилось"],
  } as const;
  const [status, code, message] = errors[result.kind];
  return NextResponse.json({ code, message }, { status, headers: NO_STORE_HEADERS });
}
