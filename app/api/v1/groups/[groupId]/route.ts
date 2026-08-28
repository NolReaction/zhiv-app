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
import { deleteDevGroup, updateDevGroup } from "@/lib/dev-api-store";
import {
  isValidGroupEmoji,
  isValidGroupTitle,
  normalizeGroupEmoji,
  normalizeGroupTitle,
} from "@/lib/group-input";

export const dynamic = "force-dynamic";

function invalidGroupId() {
  return NextResponse.json(
    { code: "INVALID_GROUP_ID", message: "Некорректная группа" },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const groupId = parseUuid((await context.params).groupId);
  if (!groupId) return invalidGroupId();
  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    emoji?: unknown;
  } | null;
  const title = typeof body?.title === "string" ? normalizeGroupTitle(body.title) : "";
  const emoji = typeof body?.emoji === "string" || body?.emoji === null
    ? normalizeGroupEmoji(body.emoji)
    : null;
  if (!isValidGroupTitle(title) || !isValidGroupEmoji(emoji)) {
    return NextResponse.json(
      { code: "INVALID_GROUP", message: "Проверьте название группы" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = updateDevGroup(await devSessionToken(), groupId, title, emoji);
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : devResultError(result);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const groupId = parseUuid((await context.params).groupId);
  if (!groupId) return invalidGroupId();
  const result = deleteDevGroup(await devSessionToken(), groupId);
  return result.kind === "ok"
    ? new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS })
    : devResultError(result);
}
