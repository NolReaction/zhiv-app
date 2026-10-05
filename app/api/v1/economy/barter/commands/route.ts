import { barterCommandSchema } from "@/features/economy/barter-model";
import { commandDevEconomyBarter } from "@/lib/dev/economy-store";
import { devEconomyContext, readDevEconomyBody, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";

export async function POST(request: Request) {
  const context = await devEconomyContext(request, true, 2048);
  if (context.response) return context.response;
  const body = await readDevEconomyBody(request, 2048);
  if (body.response) return body.response;
  const command = barterCommandSchema.safeParse(body.body);
  if (!command.success) return economyErrorResponse("INVALID_ECONOMY_COMMAND", "Некорректный запрос обмена");
  return respondDevEconomy(() => commandDevEconomyBarter(context.token, command.data));
}
