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
import { updateDevGroupSharing } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const groupId = parseUuid((await context.params).groupId);
  if (!groupId) {
    return NextResponse.json(
      { code: "INVALID_GROUP_ID", message: "Некорректная группа" },
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
  const result = updateDevGroupSharing(await devSessionToken(), groupId, sharingMode);
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : devResultError(result);
}
