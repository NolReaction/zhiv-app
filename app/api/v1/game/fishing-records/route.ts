import { getDevFishingRecords } from "@/lib/dev/fishing-records-store";
import { devGameContext, devGameResponse, gameRequestError } from "@/lib/dev/game-route";
import { parseDevGameScope } from "@/lib/dev/game-validation";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const context = await devGameContext(request);
  if (context.response) return context.response;
  const query = new URL(request.url).searchParams;
  const scope = parseDevGameScope(query);
  if (!scope || [...query.keys()].some(key => key !== "scope")) return gameRequestError("INVALID_GAME_SCOPE");
  return devGameResponse(getDevFishingRecords(context.token, scope));
}
