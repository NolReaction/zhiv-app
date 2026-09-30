import { devEconomyContext, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";
import { getDevEconomy } from "@/lib/dev/economy-store";

export async function GET(request: Request) {
  const context = await devEconomyContext(request);
  if (context.response) return context.response;
  if (new URL(request.url).search) return economyErrorResponse("INVALID_ECONOMY_COMMAND", "Некорректный запрос хозяйства");
  return respondDevEconomy(() => getDevEconomy(context.token));
}
