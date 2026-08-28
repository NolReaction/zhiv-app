import { NextResponse } from "next/server";
import { isValidPublicId, normalizePublicId } from "@/lib/check-in-presentation";
import { guardDevApi } from "@/lib/dev-api-guard";
import { devResultError, devSessionToken, NO_STORE_HEADERS } from "@/lib/dev-api-route";
import { lookupDevUser } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const publicId = normalizePublicId(decodeURIComponent((await context.params).publicId));
  if (!isValidPublicId(publicId)) {
    return NextResponse.json(
      { code: "INVALID_PUBLIC_ID", message: "Введите ID полностью" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = lookupDevUser(await devSessionToken(), publicId);
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : devResultError(result);
}
