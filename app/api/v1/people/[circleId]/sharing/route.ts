import { NextResponse } from "next/server";
import type { SharingMode } from "@/lib/check-in-contract";
import { guardDevApi } from "@/lib/dev-api-guard";
import {
  devResultError,
  devSessionToken,
  invalidIdempotencyResponse,
  NO_STORE_HEADERS,
  parseIdempotencyKey,
  parseUuid,
} from "@/lib/dev-api-route";
import { updateDevSharing } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ circleId: string }> },
) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const circleId = parseUuid((await context.params).circleId);
  if (!circleId) {
    return NextResponse.json(
      { code: "INVALID_CIRCLE_ID", message: "Некорректная связь" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const body = (await request.json().catch(() => null)) as { sharingMode?: unknown } | null;
  const sharingMode = body?.sharingMode as SharingMode | undefined;
  if (sharingMode !== "OFF" && sharingMode !== "LATEST_ONLY") {
    return NextResponse.json(
      { code: "INVALID_SHARING_MODE", message: "Некорректная настройка показа" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = updateDevSharing(await devSessionToken(), circleId, sharingMode);
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : devResultError(result);
}
