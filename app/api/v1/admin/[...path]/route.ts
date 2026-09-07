import { NextResponse } from "next/server";

// The production reverse proxy sends this namespace to the authenticated Ktor
// API. A standalone web/dev/Sites runtime must never simulate administrator data.
function unavailable() {
  return NextResponse.json({ code: "ADMIN_UNAVAILABLE", message: "Панель не подключена к серверу приложения" },
    { status: 503, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
export const GET = unavailable;
export const POST = unavailable;
