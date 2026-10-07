import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken, NO_STORE_HEADERS } from "@/lib/dev/api-route";
import { getDevIdentity } from "@/lib/dev/api-store";
import { readDevEconomyBody, economyErrorResponse } from "@/lib/dev/economy-route";
import { commandDevPresence, DevPresenceError } from "@/lib/dev/activity-store";
import { presenceCommandSchema } from "@/features/activity/model";
export async function POST(request: Request) {
  const rejected = guardDevApi(request, true, 1024); if (rejected) return rejected;
  if (new URL(request.url).search) return economyErrorResponse("INVALID_PRESENCE_COMMAND", "Некорректный запрос подключения");
  const token = await devSessionToken(), identity = getDevIdentity(token);
  if (!identity) return economyErrorResponse("UNAUTHORIZED", "Войдите в профиль", 401);
  const body = await readDevEconomyBody(request, 1024); if (body.response) return body.response;
  const parsed = presenceCommandSchema.safeParse(body.body);
  if (!parsed.success) return economyErrorResponse("INVALID_PRESENCE_COMMAND", "Некорректный запрос подключения");
  try { return NextResponse.json(commandDevPresence(identity.user.publicId, parsed.data, Date.now(), token), { headers: NO_STORE_HEADERS }); }
  catch (error) { if (error instanceof DevPresenceError) return economyErrorResponse(error.code, error.message, error.status); throw error; }
}
