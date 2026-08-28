import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDevIdentity, SESSION_COOKIE } from "@/lib/dev-api-store";
import { guardDevApi } from "@/lib/dev-api-guard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const me = getDevIdentity(token);

  if (!me) {
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Сессия не найдена" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(me, { headers: { "Cache-Control": "no-store" } });
}
