import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { devResultError, devSessionToken, invalidIdempotencyResponse, NO_STORE_HEADERS, parseIdempotencyKey, parseUuid } from "@/lib/dev-api-route";
import { updateDevNickname } from "@/lib/dev-api-store";
import { normalizePersonNickname } from "@/lib/person-nickname";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ circleId: string }> }) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const circleId = parseUuid((await context.params).circleId);
  const body: unknown = await request.json().catch(() => null);
  const nickname = body && typeof body === "object" && !Array.isArray(body)
    && Object.keys(body).length === 1 && "nickname" in body && typeof body.nickname === "string"
      ? normalizePersonNickname(body.nickname) : null;
  if (!circleId || nickname === null) {
    return NextResponse.json({ code: "INVALID_NICKNAME", message: "Подпись — до 50 символов без переносов строк" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const result = updateDevNickname(await devSessionToken(), circleId, nickname);
  return result.kind === "ok" ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS }) : devResultError(result);
}
