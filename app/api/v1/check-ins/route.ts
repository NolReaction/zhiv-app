import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createDevCheckIn, SESSION_COOKIE } from "@/lib/dev-api-store";
import { guardDevApi } from "@/lib/dev-api-guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;

  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (
    !idempotencyKey ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idempotencyKey,
    )
  ) {
    return NextResponse.json(
      { code: "INVALID_IDEMPOTENCY_KEY", message: "Некорректный ключ запроса" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const result = createDevCheckIn(token, idempotencyKey);

  if (result.kind === "unauthorized") {
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Сессия не найдена" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (result.kind === "cooldown") {
    const retryAfter = Math.max(
      1,
      Math.ceil((Date.parse(result.nextAllowedAt) - Date.parse(result.serverTime)) / 1_000),
    );
    return NextResponse.json(
      { code: "CHECK_IN_COOLDOWN", ...result },
      {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) },
      },
    );
  }

  return NextResponse.json(result.value, { headers: { "Cache-Control": "no-store" } });
}
