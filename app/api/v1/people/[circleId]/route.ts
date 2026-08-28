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
import { removeDevPerson } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ circleId: string }> },
) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const circleId = parseUuid((await context.params).circleId);
  if (!circleId) {
    return NextResponse.json(
      { code: "INVALID_CIRCLE_ID", message: "Некорректная связь" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = removeDevPerson(await devSessionToken(), circleId);
  return result.kind === "ok"
    ? new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS })
    : devResultError(result);
}
