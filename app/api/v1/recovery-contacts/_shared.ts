import { NextResponse } from "next/server";
import type { DevResult } from "@/lib/dev-api-store";
import { NO_STORE_HEADERS } from "@/lib/dev-api-route";

export function recoveryContactResultError<T>(
  result: Exclude<DevResult<T>, { kind: "ok" }>,
) {
  const errors = {
    unauthorized: [401, "UNAUTHORIZED", "Сессия не найдена"],
    "not-found": [404, "RECOVERY_NOT_FOUND", "Доверенный контакт не найден"],
    forbidden: [403, "RECOVERY_FORBIDDEN", "Действие недоступно"],
    expired: [410, "RECOVERY_EXPIRED", "Запрос восстановления истёк"],
    conflict: [409, "RECOVERY_CONFLICT", "Состояние восстановления уже изменилось"],
    "limit-reached": [409, "RECOVERY_CONTACT_LIMIT", "Можно выбрать не больше трёх доверенных людей"],
    self: [409, "RECOVERY_CONFLICT", "Нельзя выбрать себя"],
    "already-connected": [409, "RECOVERY_CONFLICT", "Состояние восстановления уже изменилось"],
  } as const;
  const [status, code, message] = errors[result.kind];
  return NextResponse.json({ code, message }, { status, headers: NO_STORE_HEADERS });
}
