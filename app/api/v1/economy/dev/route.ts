import { economyDevCommandSchema } from "@/features/economy/dev-model";
import { commandDevEconomyCheat } from "@/lib/dev/economy-store";
import { devEconomyContext, readDevEconomyBody, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return economyErrorResponse("DEV_API_DISABLED", "Читы доступны только в локальной разработке", 503);
  const context = await devEconomyContext(request, true);
  if (context.response) return context.response;
  const body = await readDevEconomyBody(request);
  if (body.response) return body.response;
  const command = economyDevCommandSchema.safeParse(body.body);
  if (!command.success) return economyErrorResponse("INVALID_ECONOMY_COMMAND", "Некорректная DEV-команда");
  return respondDevEconomy(() => commandDevEconomyCheat(context.token, command.data));
}
