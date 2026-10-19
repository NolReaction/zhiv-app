import { marketCommandSchema } from "@/features/economy/domain/model";
import { parseUuid } from "@/lib/dev/api-route";
import { commandDevGuestWorldMarket } from "@/lib/dev/economy-store";
import { devEconomyContext, readDevEconomyBody, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";

export async function POST(request: Request, context: { params: Promise<{ circleId: string }> }) {
  const session = await devEconomyContext(request, true, 2048);
  if (session.response) return session.response;
  const circleId = parseUuid((await context.params).circleId);
  if (!circleId || [...new URL(request.url).searchParams].length)
    return economyErrorResponse(circleId ? "INVALID_GUEST_WORLD_QUERY" : "INVALID_CIRCLE_ID", "Некорректный запрос поляны");
  const body = await readDevEconomyBody(request, 2048);
  if (body.response) return body.response;
  const command = marketCommandSchema.safeParse(body.body);
  if (!command.success || command.data.action !== "buy_listing")
    return economyErrorResponse("INVALID_ECONOMY_COMMAND", "В гостях можно только покупать товары");
  return respondDevEconomy(() => commandDevGuestWorldMarket(session.token, circleId, command.data));
}
