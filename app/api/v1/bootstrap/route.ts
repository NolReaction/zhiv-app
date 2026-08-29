import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createDevIdentity, getDevIdentity, SESSION_COOKIE } from "@/lib/dev-api-store";
import { guardDevApi } from "@/lib/dev-api-guard";
import { isValidDisplayName, normalizeDisplayName } from "@/lib/check-in-presentation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = guardDevApi(request, true);
  if (rejected) return rejected;

  const cookieStore = await cookies();
  const existing = getDevIdentity(cookieStore.get(SESSION_COOKIE)?.value);
  if (existing) {
    return NextResponse.json(existing, { headers: { "Cache-Control": "no-store" } });
  }

  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (
    !idempotencyKey ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idempotencyKey,
    )
  ) {
    return NextResponse.json(
      { code: "INVALID_IDEMPOTENCY_KEY", message: "Некорректный ключ запроса" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const body = (await request.json().catch(() => null)) as { displayName?: unknown } | null;
  const rawDisplayName = typeof body?.displayName === "string" ? body.displayName : "";
  const displayName = normalizeDisplayName(rawDisplayName);

  if (!isValidDisplayName(rawDisplayName)) {
    return NextResponse.json(
      { code: "INVALID_DISPLAY_NAME", message: "Введите имя длиной до 50 символов" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { token, me } = createDevIdentity(displayName, idempotencyKey);
  const response = NextResponse.json(me, {
    status: 201,
    headers: { "Cache-Control": "no-store" },
  });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  });
  return response;
}
