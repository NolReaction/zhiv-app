import { updateDevFishingVisibility } from "@/lib/dev/fishing-records-store";
import { devGameContext, devGameResponse, gameRequestError, readDevGameBody } from "@/lib/dev/game-route";
import { parseDevGameVisibility } from "@/lib/dev/game-validation";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const context = await devGameContext(request, true);
  if (context.response) return context.response;
  if (new URL(request.url).search) return gameRequestError("INVALID_GAME_VISIBILITY");
  const parsed = await readDevGameBody(request);
  if (parsed.response) return parsed.response;
  const body = parseDevGameVisibility(parsed.body);
  if (!body) return gameRequestError("INVALID_GAME_VISIBILITY");
  return devGameResponse(updateDevFishingVisibility(context.token, body));
}
