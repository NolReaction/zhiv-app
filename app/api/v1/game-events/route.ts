import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { logDevClickerSeries } from "@/lib/dev-api-events";
import { getDevIdentity, SESSION_COOKIE } from "@/lib/dev-api-store";
import { parseClickerSeriesEvent } from "@/lib/game-events";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!getDevIdentity(token)) {
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Сессия не найдена" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const event = parseClickerSeriesEvent(await request.json().catch(() => null));
  if (!event) {
    return NextResponse.json(
      { code: "INVALID_GAME_EVENT", message: "Некорректное игровое событие" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  logDevClickerSeries(event);
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
