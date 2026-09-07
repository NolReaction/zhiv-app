import { getDevGameProgress } from "@/lib/dev-game-store";
import { devGameContext, devGameResponse } from "@/lib/dev-game-route";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const context = await devGameContext(request);
  if (context.response) return context.response;
  return devGameResponse(getDevGameProgress(context.token));
}
