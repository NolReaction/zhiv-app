import { commandDevBots, getDevBots } from "@/lib/dev/bot-store";
import { devBotCommandSchema } from "@/features/world/dev/dev-bot-model";
import { devEconomyContext, economyErrorResponse, readDevEconomyBody, respondDevEconomy } from "@/lib/dev/economy-route";

export const dynamic = "force-dynamic";
const disabled = () => economyErrorResponse("DEV_API_DISABLED", "Тестовые друзья доступны только в локальной разработке", 503);
export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") return disabled();
  const context = await devEconomyContext(request);
  if (context.response) return context.response;
  if ([...new URL(request.url).searchParams].length) return economyErrorResponse("INVALID_DEV_BOT_QUERY", "Некорректный запрос тестовых друзей");
  return respondDevEconomy(() => getDevBots(context.token));
}
export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return disabled();
  const context = await devEconomyContext(request, true);
  if (context.response) return context.response;
  const body = await readDevEconomyBody(request);
  if (body.response) return body.response;
  const parsed = devBotCommandSchema.safeParse(body.body);
  if (!parsed.success) return economyErrorResponse("INVALID_DEV_BOT_COMMAND", "Некорректная команда тестового друга");
  return respondDevEconomy(() => commandDevBots(context.token, parsed.data));
}
