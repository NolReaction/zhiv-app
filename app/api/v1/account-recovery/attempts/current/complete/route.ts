import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { completeDevRecoveryAttempt, SESSION_COOKIE } from "@/lib/dev-api-store";
import {
  invalidIdempotencyResponse,
  NO_STORE_HEADERS,
  parseIdempotencyKey,
} from "@/lib/dev-api-route";
import { isCapabilityToken } from "@/lib/capability-token";
import {
  clearRecoveryClaimCookie,
  recoveryClaimRequiredResponse,
  recoveryClaimToken,
  recoveryResultError,
} from "../../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  const idempotencyKey = parseIdempotencyKey(request);
  if (!idempotencyKey) return invalidIdempotencyResponse();
  const claimToken = await recoveryClaimToken();
  if (!claimToken || !isCapabilityToken(claimToken)) return recoveryClaimRequiredResponse();

  const result = completeDevRecoveryAttempt(claimToken, idempotencyKey);
  if (result.kind !== "ok") return recoveryResultError(result);
  const response = NextResponse.json(result.value.me, { headers: NO_STORE_HEADERS });
  response.cookies.set(SESSION_COOKIE, result.value.sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  });
  clearRecoveryClaimCookie(response);
  return response;
}
