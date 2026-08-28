import { NextResponse } from "next/server";
import { isValidPublicId, normalizePublicId } from "@/lib/check-in-presentation";
import { guardDevApi } from "@/lib/dev-api-guard";
import {
  devResultError,
  devSessionToken,
  invalidIdempotencyResponse,
  NO_STORE_HEADERS,
  parseIdempotencyKey,
} from "@/lib/dev-api-route";
import { listDevPeople, sendDevDirectRequest } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const result = listDevPeople(await devSessionToken());
  if (result.kind !== "ok") return devResultError(result);
  return NextResponse.json(
    {
      incomingRequests: result.value.incomingRequests,
      outgoingRequests: result.value.outgoingRequests,
      serverTime: result.value.serverTime,
    },
    { headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  const idempotencyKey = parseIdempotencyKey(request);
  if (!idempotencyKey) return invalidIdempotencyResponse();
  const body = (await request.json().catch(() => null)) as { publicId?: unknown } | null;
  const publicId = typeof body?.publicId === "string" ? normalizePublicId(body.publicId) : "";
  if (!isValidPublicId(publicId)) {
    return NextResponse.json(
      { code: "INVALID_PUBLIC_ID", message: "Введите ID полностью" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = sendDevDirectRequest(await devSessionToken(), publicId, idempotencyKey);
  return result.kind === "ok"
    ? NextResponse.json(result.value, {
        status: result.value.replayed ? 200 : 201,
        headers: NO_STORE_HEADERS,
      })
    : devResultError(result);
}
