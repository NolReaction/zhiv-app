import { NextResponse } from "next/server";
import { devGameContext } from "@/lib/dev/game-route";
import { NO_STORE_HEADERS } from "@/lib/dev/api-route";
import { getDevWorld } from "@/lib/dev/world-store";
export async function GET(request: Request) {
  const context = await devGameContext(request);
  if (context.response) return context.response;
  return NextResponse.json(getDevWorld(context.token), { headers: NO_STORE_HEADERS });
}
