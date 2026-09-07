import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { devSessionToken, invalidIdempotencyResponse, isExactJsonObject, NO_STORE_HEADERS, parseIdempotencyKey } from "@/lib/dev-api-route";
import { updateDevTimeZone } from "@/lib/dev-api-store";
import { isTimeZone } from "@/lib/time-zone";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const key = parseIdempotencyKey(request);
  if (!key) return invalidIdempotencyResponse();
  const body: unknown = await request.json().catch(() => null);
  if (!isExactJsonObject(body, ["timeZone"]) || !isTimeZone(body.timeZone)) {
    return NextResponse.json({ code: "INVALID_TIME_ZONE", message: "Выберите часовой пояс" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const result = updateDevTimeZone(await devSessionToken(), body.timeZone, key);
  if (result.kind === "unauthorized") return NextResponse.json({ code: "UNAUTHORIZED", message: "Сессия не найдена" }, { status: 401, headers: NO_STORE_HEADERS });
  if (result.kind !== "ok") return NextResponse.json({ code: "IDEMPOTENCY_CONFLICT", message: "Этот запрос уже использован для другого часового пояса" }, { status: 409, headers: NO_STORE_HEADERS });
  return NextResponse.json(result.value, { headers: NO_STORE_HEADERS });
}
