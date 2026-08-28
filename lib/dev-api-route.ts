import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { DevResult } from "@/lib/dev-api-store";
import { SESSION_COOKIE } from "@/lib/dev-api-store";

export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export async function devSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export function parseIdempotencyKey(request: Request): string | null {
  const value = request.headers.get("Idempotency-Key");
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return null;
  }
  return value;
}

export function parseUuid(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

export function invalidIdempotencyResponse() {
  return NextResponse.json(
    { code: "INVALID_IDEMPOTENCY_KEY", message: "Некорректный ключ запроса" },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}

export function devResultError<T>(result: Exclude<DevResult<T>, { kind: "ok" }>) {
  const errors = {
    unauthorized: [401, "UNAUTHORIZED", "Сессия не найдена"],
    "not-found": [404, "NOT_FOUND", "Объект не найден"],
    self: [409, "CANNOT_ADD_SELF", "Это ваш ID 😄"],
    "already-connected": [409, "ALREADY_CONNECTED", "Этот человек уже в ваших"],
    forbidden: [403, "FORBIDDEN", "Действие недоступно"],
    expired: [409, "DIRECT_REQUEST_EXPIRED", "Срок заявки истёк"],
    conflict: [409, "RELATIONSHIP_CONFLICT", "Состояние уже изменилось"],
  } as const;
  const [status, code, message] = errors[result.kind];
  return NextResponse.json({ code, message }, { status, headers: NO_STORE_HEADERS });
}
