import { devEconomyContext, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";
import { requestedRewardCatalog, rewardCatalogView } from "@/features/game/reward-catalog-compat";
import { getDevProgressionRewards } from "@/lib/dev/progression-rewards-store";
export async function GET(request: Request) {
  const context = await devEconomyContext(request);
  if (context.response) return context.response;
  const catalog = requestedRewardCatalog(new URL(request.url).searchParams);
  if (catalog === null) return economyErrorResponse("INVALID_REWARD_CLAIM", "Некорректный запрос наград");
  return respondDevEconomy(() => rewardCatalogView(getDevProgressionRewards(context.token), catalog));
}
