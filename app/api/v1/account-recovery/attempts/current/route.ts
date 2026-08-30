import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { cancelDevRecoveryAttempt, getDevRecoveryAttempt } from "@/lib/dev-api-store";
import { NO_STORE_HEADERS } from "@/lib/dev-api-route";
import { isCapabilityToken } from "@/lib/capability-token";
import {
  clearRecoveryClaimCookie,
  recoveryClaimRequiredResponse,
  recoveryClaimToken,
  recoveryResultError,
} from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const claimToken = await recoveryClaimToken();
  if (!claimToken || !isCapabilityToken(claimToken)) return recoveryClaimRequiredResponse();
  const result = getDevRecoveryAttempt(claimToken);
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : recoveryResultError(result);
}

export async function DELETE(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const claimToken = await recoveryClaimToken();
  if (!claimToken || !isCapabilityToken(claimToken)) {
    const response = new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
    clearRecoveryClaimCookie(response);
    return response;
  }

  const result = cancelDevRecoveryAttempt(claimToken);
  const response = result.kind === "ok" || result.kind === "not-found" || result.kind === "expired"
    ? new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS })
    : recoveryResultError(result);
  clearRecoveryClaimCookie(response);
  return response;
}
