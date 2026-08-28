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
import { removeDevGroupMember } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ groupId: string; membershipId: string }> },
) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const params = await context.params;
  const groupId = parseUuid(params.groupId);
  const membershipId = parseUuid(params.membershipId);
  if (!groupId || !membershipId) {
    return NextResponse.json(
      { code: "INVALID_GROUP_MEMBER", message: "Некорректный участник" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = removeDevGroupMember(await devSessionToken(), groupId, membershipId);
  return result.kind === "ok"
    ? new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS })
    : devResultError(result);
}
