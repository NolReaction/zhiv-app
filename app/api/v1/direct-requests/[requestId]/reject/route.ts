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
import { actOnDevDirectRequest } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  if (!parseIdempotencyKey(request)) return invalidIdempotencyResponse();
  const requestId = parseUuid((await context.params).requestId);
  if (!requestId) {
    return NextResponse.json(
      { code: "INVALID_REQUEST_ID", message: "Некорректная заявка" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = actOnDevDirectRequest(await devSessionToken(), requestId, "REJECTED");
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : devResultError(result);
}
