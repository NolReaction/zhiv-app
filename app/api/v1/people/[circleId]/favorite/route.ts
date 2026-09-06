import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { devResultError, devSessionToken, invalidIdempotencyResponse, NO_STORE_HEADERS, parseIdempotencyKey, parseUuid } from "@/lib/dev-api-route";
import { updateDevFavorite } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ circleId: string }> }) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const circleId = parseUuid((await context.params).circleId);
  const body = await request.json().catch(() => null) as { isFavorite?: unknown } | null;
  if (!circleId || typeof body?.isFavorite !== "boolean") {
    return NextResponse.json({ code: "INVALID_FAVORITE", message: "Некорректная настройка избранного" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const result = updateDevFavorite(await devSessionToken(), circleId, body.isFavorite);
  return result.kind === "ok" ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS }) : devResultError(result);
}
