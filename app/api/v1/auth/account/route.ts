import { cookies } from "next/headers";
import { guardDevApi } from "@/lib/dev/api-guard";
import { getDevIdentity, SESSION_COOKIE } from "@/lib/dev/api-store";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  if (!getDevIdentity((await cookies()).get(SESSION_COOKIE)?.value)) {
    return Response.json({ code: "UNAUTHORIZED", message: "Сессия не найдена" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  // The isolated dev store has no external providers or durable device registry.
  return Response.json({ methods: [], sessions: [] }, { headers: { "Cache-Control": "no-store" } });
}
