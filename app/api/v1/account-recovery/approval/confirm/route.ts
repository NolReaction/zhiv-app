import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { confirmDevRecoveryApproval } from "@/lib/dev-api-store";
import {
  devSessionToken,
  invalidIdempotencyResponse,
  NO_STORE_HEADERS,
  parseIdempotencyKey,
  parseUuid,
} from "@/lib/dev-api-route";
import { isCapabilityToken } from "@/lib/capability-token";
import {
  invalidRecoveryAttemptResponse,
  invalidRecoveryContactResponse,
  isExactJsonObject,
  recoveryResultError,
} from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;
  const idempotencyKey = parseIdempotencyKey(request);
  if (!idempotencyKey) return invalidIdempotencyResponse();
  const body: unknown = await request.json().catch(() => null);
  if (!isExactJsonObject(body, ["token", "contactId"])) {
    return invalidRecoveryAttemptResponse();
  }
  if (typeof body.token !== "string" || !isCapabilityToken(body.token)) {
    return invalidRecoveryAttemptResponse();
  }
  const contactId = typeof body.contactId === "string" ? parseUuid(body.contactId) : null;
  if (!contactId) return invalidRecoveryContactResponse();

  const result = confirmDevRecoveryApproval(
    await devSessionToken(),
    body.token,
    contactId,
    idempotencyKey,
  );
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : recoveryResultError(result);
}
