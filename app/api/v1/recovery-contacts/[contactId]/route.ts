import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { removeDevRecoveryContact } from "@/lib/dev-api-store";
import { devSessionToken, invalidIdempotencyResponse, NO_STORE_HEADERS, parseIdempotencyKey, parseUuid } from "@/lib/dev-api-route";
import { recoveryContactResultError } from "../_shared";

export const dynamic = "force-dynamic";
export async function DELETE(request: Request, context: { params: Promise<{ contactId: string }> }) {
  const rejected = guardDevApi(request); if (rejected) return rejected;
  const key = parseIdempotencyKey(request); if (!key) return invalidIdempotencyResponse();
  const contactId = parseUuid((await context.params).contactId);
  if (!contactId) return NextResponse.json({ code: "INVALID_RECOVERY_CONTACT", message: "Некорректный доверенный контакт" }, { status: 400, headers: NO_STORE_HEADERS });
  const result = removeDevRecoveryContact(await devSessionToken(), contactId, key);
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : recoveryContactResultError(result);
}
