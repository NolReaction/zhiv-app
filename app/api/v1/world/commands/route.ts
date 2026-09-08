import { NextResponse } from "next/server";
import { devGameContext, readDevGameBody, gameRequestError } from "@/lib/dev-game-route";
import { NO_STORE_HEADERS } from "@/lib/dev-api-route";
import { commandDevWorld, DevWorldError } from "@/lib/dev-world-store";
import { worldCommandSchema } from "@/features/world/model";
export async function POST(request: Request) {
  const context = await devGameContext(request, true);
  if (context.response) return context.response;
  const body = await readDevGameBody(request);
  if (body.response) return body.response;
  const parsed = worldCommandSchema.safeParse(body.body);
  if (!parsed.success) return gameRequestError("INVALID_WORLD_COMMAND");
  if (parsed.data.action === "dev_grant_resources" && process.env.NODE_ENV !== "development") return gameRequestError("DEV_TOOLS_DISABLED", 404);
  try { return NextResponse.json(commandDevWorld(context.token, parsed.data), { headers: NO_STORE_HEADERS }); }
  catch (error) {
    if (error instanceof DevWorldError) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE_HEADERS });
    throw error;
  }
}
