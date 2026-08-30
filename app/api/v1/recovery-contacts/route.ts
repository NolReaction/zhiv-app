import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { addDevRecoveryContact, listDevRecoveryContacts } from "@/lib/dev-api-store";
import { devSessionToken, invalidIdempotencyResponse, isExactJsonObject, NO_STORE_HEADERS, parseIdempotencyKey, parseUuid } from "@/lib/dev-api-route";
import { recoveryContactResultError } from "./_shared";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const rejected = guardDevApi(request); if (rejected) return rejected;
  const result = listDevRecoveryContacts(await devSessionToken());
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : recoveryContactResultError(result);
}
export async function POST(request: Request) {
  const rejected = guardDevApi(request, true); if (rejected) return rejected;
  const key = parseIdempotencyKey(request); if (!key) return invalidIdempotencyResponse();
  const body: unknown = await request.json().catch(() => null);
  const circleId = isExactJsonObject(body, ["circleId"]) && typeof body.circleId === "string"
    ? parseUuid(body.circleId)
    : null;
  if (!circleId) return NextResponse.json({ code: "INVALID_RECOVERY_CONTACT", message: "Некорректный доверенный контакт" }, { status: 400, headers: NO_STORE_HEADERS });
  const result = addDevRecoveryContact(await devSessionToken(), circleId, key);
  return result.kind === "ok"
    ? NextResponse.json(result.value, { status: 201, headers: NO_STORE_HEADERS })
    : recoveryContactResultError(result);
}
