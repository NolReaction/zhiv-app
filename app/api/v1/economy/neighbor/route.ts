import { getDevEconomyNeighbor } from "@/lib/dev/economy-store";
import { devEconomyContext, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";

export async function GET(request: Request) {
  const context = await devEconomyContext(request);
  if (context.response) return context.response;
  if (new URL(request.url).search) return economyErrorResponse("INVALID_ECONOMY_QUERY", "Некорректный запрос лавки соседа");
  return respondDevEconomy(() => getDevEconomyNeighbor(context.token));
}
