import { devEconomyContext, readDevEconomyBody, respondDevEconomy, economyErrorResponse } from "@/lib/dev/economy-route";
import { requestedRewardCatalog, rewardCatalogView, rewardClaimRequiresAppUpdate, REWARD_APP_UPDATE_MESSAGE } from "@/features/game/reward-catalog-compat";
import { economyCatalog } from "@/features/economy/domain/model";
import { claimDevProgressionReward } from "@/lib/dev/progression-rewards-store";
import { gameRewardClaimSchema } from "@/features/game/game-rewards-api";
export async function POST(request: Request) {
  const context = await devEconomyContext(request, true, 2048);
  if (context.response) return context.response;
  const catalog = requestedRewardCatalog(new URL(request.url).searchParams);
  if (catalog === null) return economyErrorResponse("INVALID_REWARD_CLAIM", "Некорректный запрос наград");
  if (rewardClaimRequiresAppUpdate(catalog, economyCatalog.version)) return economyErrorResponse("APP_UPDATE_REQUIRED", REWARD_APP_UPDATE_MESSAGE, 409);
  const input = await readDevEconomyBody(request, 2048);
  if (input.response) return input.response;
  const parsed = gameRewardClaimSchema.safeParse(input.body);
  if (parsed.success && parsed.data.kind === "achievement" && rewardClaimRequiresAppUpdate(catalog, economyCatalog.version, parsed.data.achievementId))
    return economyErrorResponse("APP_UPDATE_REQUIRED", REWARD_APP_UPDATE_MESSAGE, 409);
  return respondDevEconomy(() => {
    const result = claimDevProgressionReward(context.token, input.body);
    return { ...result, rewards: rewardCatalogView(result.rewards, catalog) };
  });
}
