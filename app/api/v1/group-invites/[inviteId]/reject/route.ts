import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import {
  devResultError,
  devSessionToken,
  invalidIdempotencyResponse,
  NO_STORE_HEADERS,
  parseIdempotencyKey,
  parseUuid,
} from "@/lib/dev-api-route";
import { actOnDevGroupInvite } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ inviteId: string }> },
) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const inviteId = parseUuid((await context.params).inviteId);
  if (!inviteId) {
    return NextResponse.json(
      { code: "INVALID_GROUP_INVITE", message: "Некорректное приглашение" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = actOnDevGroupInvite(await devSessionToken(), inviteId, "REVOKED");
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : devResultError(result);
}
