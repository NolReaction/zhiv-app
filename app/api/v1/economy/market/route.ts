import { getDevEconomyMarket } from "@/lib/dev/economy-store";
import { devEconomyContext, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";

export async function GET(request: Request) {
  const context = await devEconomyContext(request);
  if (context.response) return context.response;
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => !["cursor", "limit"].includes(key)) || query.getAll("cursor").length > 1 || query.getAll("limit").length > 1)
    return economyErrorResponse("INVALID_ECONOMY_QUERY", "Некорректная страница рынка");
  const rawLimit = query.get("limit");
  if (rawLimit != null && !/^\d+$/.test(rawLimit)) return economyErrorResponse("INVALID_ECONOMY_QUERY", "Некорректный размер страницы");
  return respondDevEconomy(() => getDevEconomyMarket(context.token, {
    ...(query.has("cursor") ? { cursor: query.get("cursor")! } : {}), ...(rawLimit != null ? { limit: Number(rawLimit) } : {}),
  }));
}
