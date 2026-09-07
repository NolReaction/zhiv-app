import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { NO_STORE_HEADERS } from "@/lib/dev-api-route";
import { getDevCheckInCalendar, SESSION_COOKIE } from "@/lib/dev-api-store";
import { isCalendarMonth } from "@/lib/check-in-calendar";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const values = new URL(request.url).searchParams.getAll("month");
  if (values.length > 1 || (values.length === 1 && !isCalendarMonth(values[0]))) {
    return NextResponse.json({ code: "INVALID_MONTH", message: "Укажите месяц в формате ГГГГ-ММ" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const calendar = getDevCheckInCalendar(token, values[0] ?? null);
  if (!calendar) return NextResponse.json({ code: "UNAUTHORIZED", message: "Сессия не найдена" }, { status: 401, headers: NO_STORE_HEADERS });
  return NextResponse.json(calendar, { headers: NO_STORE_HEADERS });
}
