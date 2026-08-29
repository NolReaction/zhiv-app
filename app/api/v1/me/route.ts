import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getDevIdentity,
  SESSION_COOKIE,
  updateDevDisplayName,
} from "@/lib/dev-api-store";
import { guardDevApi } from "@/lib/dev-api-guard";
import {
  invalidIdempotencyResponse,
  NO_STORE_HEADERS,
  parseIdempotencyKey,
} from "@/lib/dev-api-route";
import {
  isValidDisplayName,
  normalizeDisplayName,
} from "@/lib/check-in-presentation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const me = getDevIdentity(token);

  if (!me) {
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Сессия не найдена" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(me, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;

  const idempotencyKey = parseIdempotencyKey(request);
  if (!idempotencyKey) return invalidIdempotencyResponse();

  const body: unknown = await request.json().catch(() => null);
  const rawDisplayName = body && typeof body === "object" && "displayName" in body
    && typeof body.displayName === "string"
    ? body.displayName
    : "";
  const displayName = normalizeDisplayName(rawDisplayName);
  if (!isValidDisplayName(rawDisplayName)) {
    return NextResponse.json(
      { code: "INVALID_DISPLAY_NAME", message: "Введите имя длиной до 50 символов" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const result = updateDevDisplayName(token, displayName, idempotencyKey);

  if (result.kind === "unauthorized") {
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Сессия не найдена" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }
  if (result.kind === "conflict") {
    return NextResponse.json(
      { code: "IDEMPOTENCY_CONFLICT", message: "Ключ уже использован для другого имени" },
      { status: 409, headers: NO_STORE_HEADERS },
    );
  }
  if (result.kind === "cooldown") {
    const retryAfter = Math.max(
      1,
      Math.ceil((Date.parse(result.availableAt) - Date.parse(result.serverTime)) / 1_000),
    );
    return NextResponse.json(
      {
        code: "DISPLAY_NAME_COOLDOWN",
        message: "Имя можно менять раз в 24 часа",
        availableAt: result.availableAt,
        serverTime: result.serverTime,
      },
      {
        status: 429,
        headers: { ...NO_STORE_HEADERS, "Retry-After": String(retryAfter) },
      },
    );
  }

  return NextResponse.json(result.value, { headers: NO_STORE_HEADERS });
}
