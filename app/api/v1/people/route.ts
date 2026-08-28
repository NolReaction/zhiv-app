import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { devResultError, devSessionToken, NO_STORE_HEADERS } from "@/lib/dev-api-route";
import { listDevPeople } from "@/lib/dev-api-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const result = listDevPeople(await devSessionToken());
  return result.kind === "ok"
    ? NextResponse.json(result.value, { headers: NO_STORE_HEADERS })
    : devResultError(result);
}
