import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { createDevRecoveryAttempt } from "@/lib/dev-api-store";
import {
  devSessionToken,
  invalidIdempotencyResponse,
  NO_STORE_HEADERS,
  parseIdempotencyKey,
} from "@/lib/dev-api-route";
import { isCapabilityToken } from "@/lib/capability-token";
import {
  invalidRecoveryAttemptResponse,
  isExactJsonObject,
  recoveryResultError,
  setRecoveryClaimCookie,
} from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  const idempotencyKey = parseIdempotencyKey(request);
  if (!idempotencyKey) return invalidIdempotencyResponse();
  const body: unknown = await request.json().catch(() => null);
  if (
    !isExactJsonObject(body, ["token"]) ||
    typeof body.token !== "string" ||
    !isCapabilityToken(body.token)
  ) return invalidRecoveryAttemptResponse();

  const result = createDevRecoveryAttempt(
    body.token,
    idempotencyKey,
    await devSessionToken(),
  );
  if (result.kind !== "ok") return recoveryResultError(result);
  const response = NextResponse.json(result.value.attempt, {
    status: result.value.attempt.replayed ? 200 : 201,
    headers: NO_STORE_HEADERS,
  });
  const remainingSeconds = Math.max(
    1,
    Math.min(
      10 * 60,
      Math.floor(
        (Date.parse(result.value.attempt.expiresAt) - Date.parse(result.value.attempt.serverTime)) / 1_000,
      ),
    ),
  );
  setRecoveryClaimCookie(response, result.value.claimToken, remainingSeconds);
  return response;
}
