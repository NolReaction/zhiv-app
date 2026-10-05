import { devEconomyContext, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";
import { getDevProgressionRewards } from "@/lib/dev/progression-rewards-store";
export async function GET(request: Request) {
  const context = await devEconomyContext(request);
  if (context.response) return context.response;
  if (new URL(request.url).search) return economyErrorResponse("INVALID_REWARD_CLAIM", "Некорректный запрос наград");
  return respondDevEconomy(() => getDevProgressionRewards(context.token));
}
