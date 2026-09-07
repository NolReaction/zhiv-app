import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { invalidIdempotencyResponse, NO_STORE_HEADERS, parseIdempotencyKey } from "@/lib/dev-api-route";
import { SESSION_COOKIE, updateDevStatus } from "@/lib/dev-api-store";
import { MAX_STATUS_LENGTH, normalizeUserStatus, validStatusDuration } from "@/lib/user-status";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  const key = parseIdempotencyKey(request);
  if (!key) return invalidIdempotencyResponse();
  const body: unknown = await request.json().catch(() => null);
  const text = body && typeof body === "object" && "text" in body && typeof body.text === "string"
    ? normalizeUserStatus(body.text) : null;
  if (text === null) return NextResponse.json({ code: "INVALID_STATUS", message: `До ${MAX_STATUS_LENGTH} символов, без управляющих символов` }, { status: 400, headers: NO_STORE_HEADERS });
  const duration = body && typeof body === "object" && "expiresInMinutes" in body ? body.expiresInMinutes : null;
  if (!validStatusDuration(duration)) return NextResponse.json({ code: "INVALID_STATUS_DURATION", message: "Выберите срок из списка" }, { status: 400, headers: NO_STORE_HEADERS });
  const result = updateDevStatus((await cookies()).get(SESSION_COOKIE)?.value, text, key, duration ?? null);
  if (result.kind === "ok") return NextResponse.json(result.value, { headers: NO_STORE_HEADERS });
  const unauthorized = result.kind === "unauthorized";
  return NextResponse.json({ code: unauthorized ? "UNAUTHORIZED" : "IDEMPOTENCY_CONFLICT", message: unauthorized ? "Сессия не найдена" : "Повторите сохранение" }, { status: unauthorized ? 401 : 409, headers: NO_STORE_HEADERS });
}
