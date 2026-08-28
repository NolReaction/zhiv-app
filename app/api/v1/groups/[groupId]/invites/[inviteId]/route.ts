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
import { revokeDevGroupInvite } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ groupId: string; inviteId: string }> },
) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const params = await context.params;
  const groupId = parseUuid(params.groupId);
  const inviteId = parseUuid(params.inviteId);
  if (!groupId || !inviteId) {
    return NextResponse.json(
      { code: "INVALID_GROUP_INVITE", message: "Некорректное приглашение" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = revokeDevGroupInvite(await devSessionToken(), groupId, inviteId);
  return result.kind === "ok"
    ? new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS })
    : devResultError(result);
}
