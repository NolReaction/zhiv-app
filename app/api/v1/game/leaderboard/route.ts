import { getDevGameLeaderboard } from "@/lib/dev-game-store";
import { devGameContext, devGameResponse, gameRequestError } from "@/lib/dev-game-route";
import { parseDevGameMetric, parseDevGameScope } from "@/lib/dev-game-validation";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const context = await devGameContext(request);
  if (context.response) return context.response;
  const scope = parseDevGameScope(new URL(request.url).searchParams);
  if (scope === null) return gameRequestError("INVALID_GAME_SCOPE");
  const metric = parseDevGameMetric(new URL(request.url).searchParams);
  if (metric === null) return gameRequestError("INVALID_GAME_METRIC");
  return devGameResponse(getDevGameLeaderboard(context.token, scope, Date.now(), metric));
}
