import { economyCommandSchema } from "@/features/economy/domain/model";
import { commandDevEconomy } from "@/lib/dev/economy-store";
import { devEconomyContext, readDevEconomyBody, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";

export async function POST(request: Request) {
  const context = await devEconomyContext(request, true);
  if (context.response) return context.response;
  const body = await readDevEconomyBody(request);
  if (body.response) return body.response;
  const command = economyCommandSchema.safeParse(body.body);
  if (!command.success) return economyErrorResponse("INVALID_ECONOMY_COMMAND", "Некорректный запрос хозяйства");
  return respondDevEconomy(() => commandDevEconomy(context.token, command.data));
}
