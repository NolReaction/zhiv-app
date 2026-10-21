import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken, NO_STORE_HEADERS, parseUuid } from "@/lib/dev/api-route";
import { getDevGuestWorld } from "@/lib/dev/api-store";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ circleId: string }> }) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const circleId = parseUuid((await context.params).circleId);
  if (!circleId || [...new URL(request.url).searchParams].length)
    return NextResponse.json({ code: circleId ? "INVALID_GUEST_WORLD_QUERY" : "INVALID_CIRCLE_ID", message: "Некорректный запрос поляны" }, { status: 400, headers: NO_STORE_HEADERS });
  const result = getDevGuestWorld(await devSessionToken(), circleId);
  if (result.kind === "ok") return NextResponse.json(result.value, { headers: NO_STORE_HEADERS });
  return NextResponse.json({ code: result.kind === "unauthorized" ? "UNAUTHORIZED" : "GUEST_WORLD_UNAVAILABLE", message: "Поляна недоступна" },
    { status: result.kind === "unauthorized" ? 401 : 404, headers: NO_STORE_HEADERS });
}
