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
import { createDevGroup, listDevGroups } from "@/lib/dev-api-store";
import {
  isValidGroupEmoji,
  isValidGroupTitle,
  normalizeGroupEmoji,
  normalizeGroupTitle,
} from "@/lib/group-input";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const result = listDevGroups(await devSessionToken());
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : devResultError(result);
}

export async function POST(request: Request) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  const idempotencyKey = parseIdempotencyKey(request);
  if (!idempotencyKey) return invalidIdempotencyResponse();
  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    emoji?: unknown;
    inviteeCircleIds?: unknown;
  } | null;
  const title = typeof body?.title === "string" ? normalizeGroupTitle(body.title) : "";
  const emoji = typeof body?.emoji === "string" || body?.emoji === null
    ? normalizeGroupEmoji(body.emoji)
    : null;
  const rawInviteeCircleIds = body?.inviteeCircleIds ?? [];
  const inviteeCircleIds = Array.isArray(rawInviteeCircleIds)
    ? rawInviteeCircleIds.filter((value): value is string => typeof value === "string")
    : [];
  if (
    !isValidGroupTitle(title) ||
    !isValidGroupEmoji(emoji) ||
    inviteeCircleIds.length > 20 ||
    !Array.isArray(rawInviteeCircleIds) ||
    inviteeCircleIds.length !== rawInviteeCircleIds.length ||
    inviteeCircleIds.some((value) => !parseUuid(value))
  ) {
    return NextResponse.json(
      { code: "INVALID_GROUP", message: "Проверьте название и выбранных людей" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = createDevGroup(
    await devSessionToken(),
    title,
    emoji,
    [...new Set(inviteeCircleIds.map((value) => parseUuid(value)!))],
    idempotencyKey,
  );
  return result.kind === "ok"
    ? NextResponse.json(result.value, {
        status: result.value.replayed ? 200 : 201,
        headers: NO_STORE_HEADERS,
      })
    : devResultError(result);
}
