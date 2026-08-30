import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { DevResult } from "@/lib/dev-api-store";
import { NO_STORE_HEADERS } from "@/lib/dev-api-route";

const PRODUCTION_RECOVERY_COOKIE = "__Host-zhiv_recovery";
const DEVELOPMENT_RECOVERY_COOKIE = "zhiv_recovery";
export const RECOVERY_COOKIE = process.env.NODE_ENV === "production"
  ? PRODUCTION_RECOVERY_COOKIE
  : DEVELOPMENT_RECOVERY_COOKIE;
const RECOVERY_COOKIE_PATH = process.env.NODE_ENV === "production"
  ? "/"
  : "/api/v1/account-recovery";

export async function recoveryClaimToken(): Promise<string | undefined> {
  return (await cookies()).get(RECOVERY_COOKIE)?.value;
}

export function setRecoveryClaimCookie(response: NextResponse, token: string, maxAge = 10 * 60) {
  response.cookies.set(RECOVERY_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: RECOVERY_COOKIE_PATH,
    maxAge,
  });
}

export function clearRecoveryClaimCookie(response: NextResponse) {
  response.cookies.set(RECOVERY_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: RECOVERY_COOKIE_PATH,
    maxAge: 0,
  });
}

export function isExactJsonObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}

export function invalidRecoveryAttemptResponse() {
  return NextResponse.json(
    { code: "INVALID_RECOVERY_ATTEMPT", message: "Некорректная попытка восстановления" },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}

export function invalidRecoveryContactResponse() {
  return NextResponse.json(
    { code: "INVALID_RECOVERY_CONTACT", message: "Некорректный доверенный контакт" },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}

export function recoveryClaimRequiredResponse() {
  return NextResponse.json(
    { code: "RECOVERY_CLAIM_REQUIRED", message: "Начните восстановление на этом устройстве" },
    { status: 401, headers: NO_STORE_HEADERS },
  );
}

export function recoveryResultError<T>(result: Exclude<DevResult<T>, { kind: "ok" }>) {
  const errors = {
    unauthorized: [401, "UNAUTHORIZED", "Сессия не найдена"],
    "not-found": [404, "RECOVERY_NOT_FOUND", "Восстановление не найдено"],
    forbidden: [403, "RECOVERY_FORBIDDEN", "Друг больше не может восстановить этот профиль"],
    expired: [410, "RECOVERY_EXPIRED", "Попытка восстановления истекла"],
    conflict: [409, "RECOVERY_CONFLICT", "Состояние восстановления уже изменилось"],
    self: [409, "RECOVERY_CONFLICT", "Состояние восстановления уже изменилось"],
    "already-connected": [409, "RECOVERY_CONFLICT", "Состояние восстановления уже изменилось"],
    "limit-reached": [409, "RECOVERY_CONTACT_LIMIT", "Можно выбрать не больше трёх доверенных людей"],
  } as const;
  const [status, code, message] = errors[result.kind];
  return NextResponse.json({ code, message }, { status, headers: NO_STORE_HEADERS });
}
