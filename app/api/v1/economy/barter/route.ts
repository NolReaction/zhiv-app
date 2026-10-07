import { getDevEconomyBarter } from "@/lib/dev/economy-store";
import { devEconomyContext, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";

export async function GET(request: Request) {
  const context = await devEconomyContext(request);
  if (context.response) return context.response;
  if ([...new URL(request.url).searchParams].length)
    return economyErrorResponse("INVALID_ECONOMY_QUERY", "Обмен содержит одну ограниченную витрину");
  return respondDevEconomy(() => getDevEconomyBarter(context.token));
}
