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
import { inviteDevGroupMember } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  const idempotencyKey = parseIdempotencyKey(request);
  if (!idempotencyKey) return invalidIdempotencyResponse();
  const groupId = parseUuid((await context.params).groupId);
  const body = (await request.json().catch(() => null)) as { personCircleId?: unknown } | null;
  const personCircleId = typeof body?.personCircleId === "string"
    ? parseUuid(body.personCircleId)
    : null;
  if (!groupId || !personCircleId) {
    return NextResponse.json(
      { code: "INVALID_GROUP_INVITE", message: "Некорректная группа или человек" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = inviteDevGroupMember(
    await devSessionToken(),
    groupId,
    personCircleId,
    idempotencyKey,
  );
  return result.kind === "ok"
    ? NextResponse.json(result.value, {
        status: result.value.replayed ? 200 : 201,
        headers: NO_STORE_HEADERS,
      })
    : devResultError(result);
}
