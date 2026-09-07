import { submitDevGameBatch } from "@/lib/dev-game-store";
import { parseDevGameBatch } from "@/lib/dev-game-validation";
import { devGameContext, devGameResponse, gameRequestError, readDevGameBody } from "@/lib/dev-game-route";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const context = await devGameContext(request, true);
  if (context.response) return context.response;
  const parsed = await readDevGameBody(request);
  if (parsed.response) return parsed.response;
  const body = parseDevGameBatch(parsed.body);
  if (!body) return gameRequestError("INVALID_GAME_BATCH");
  return devGameResponse(submitDevGameBatch(context.token, body));
}
