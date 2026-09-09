import { getDevGameAchievements } from "@/lib/dev/game-store";
import { devGameContext, devGameResponse, gameRequestError } from "@/lib/dev/game-route";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const context = await devGameContext(request);
  if (context.response) return context.response;
  const versions = new URL(request.url).searchParams.getAll("catalog");
  const version = !versions.length ? "1" : versions.length === 1 ? versions[0] : null;
  if (version !== "1" && version !== "2" && version !== "3") return gameRequestError("INVALID_GAME_CATALOG");
  const result = getDevGameAchievements(context.token);
  if (result.kind === "ok" && version !== "3") result.value.achievements = result.value.achievements.slice(0, 3);
  return devGameResponse(result);
}
