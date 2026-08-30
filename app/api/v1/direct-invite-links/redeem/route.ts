import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { redeemDevDirectInvite } from "@/lib/dev-api-store";
import { devSessionToken, invalidIdempotencyResponse, isExactJsonObject, NO_STORE_HEADERS, parseIdempotencyKey } from "@/lib/dev-api-route";
import { isCapabilityToken } from "@/lib/capability-token";
import { directInviteResultError } from "../_shared";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const rejected = guardDevApi(request, true); if (rejected) return rejected;
  const key = parseIdempotencyKey(request); if (!key) return invalidIdempotencyResponse();
  const body: unknown = await request.json().catch(() => null);
  if (!isExactJsonObject(body, ["token"]) || typeof body.token !== "string" || !isCapabilityToken(body.token)) {
    return NextResponse.json({ code: "INVALID_INVITE", message: "Некорректная ссылка" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const result = redeemDevDirectInvite(await devSessionToken(), body.token, key);
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : directInviteResultError(result);
}
