import { updateDevGameVisibility } from "@/lib/dev-game-store";
import { parseDevGameVisibility } from "@/lib/dev-game-validation";
import { devGameContext, devGameResponse, gameRequestError, readDevGameBody } from "@/lib/dev-game-route";

export const dynamic = "force-dynamic";
export async function PATCH(request: Request) {
  const context = await devGameContext(request, true);
  if (context.response) return context.response;
  const parsed = await readDevGameBody(request);
  if (parsed.response) return parsed.response;
  const body = parseDevGameVisibility(parsed.body);
  if (!body) return gameRequestError("INVALID_GAME_VISIBILITY");
  return devGameResponse(updateDevGameVisibility(context.token, body.ownerPublicId, body.leaderboardOptIn, body.expectedVersion));
}
