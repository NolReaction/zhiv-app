import { marketCommandSchema } from "@/features/economy/domain/model";
import { commandDevEconomyMarket } from "@/lib/dev/economy-store";
import { devEconomyContext, readDevEconomyBody, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";

export async function POST(request: Request) {
  const context = await devEconomyContext(request, true, 2048);
  if (context.response) return context.response;
  const body = await readDevEconomyBody(request, 2048);
  if (body.response) return body.response;
  const command = marketCommandSchema.safeParse(body.body);
  if (!command.success) return economyErrorResponse("INVALID_ECONOMY_COMMAND", "Некорректный запрос рынка");
  return respondDevEconomy(() => commandDevEconomyMarket(context.token, command.data));
}
