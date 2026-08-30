import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { previewDevDirectInvite } from "@/lib/dev-api-store";
import { isExactJsonObject, NO_STORE_HEADERS } from "@/lib/dev-api-route";
import { isCapabilityToken } from "@/lib/capability-token";
import { directInviteResultError } from "../_shared";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const rejected = guardDevApi(request, true); if (rejected) return rejected;
  const body: unknown = await request.json().catch(() => null);
  if (!isExactJsonObject(body, ["token"]) || typeof body.token !== "string" || !isCapabilityToken(body.token)) {
    return NextResponse.json({ code: "INVALID_INVITE", message: "Некорректная ссылка" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const result = previewDevDirectInvite(body.token);
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : directInviteResultError(result);
}
