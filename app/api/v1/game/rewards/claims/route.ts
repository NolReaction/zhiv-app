import { devEconomyContext, readDevEconomyBody, respondDevEconomy } from "@/lib/dev/economy-route";
import { claimDevProgressionReward } from "@/lib/dev/progression-rewards-store";
export async function POST(request: Request) {
  const context = await devEconomyContext(request, true, 2048);
  if (context.response) return context.response;
  const input = await readDevEconomyBody(request, 2048);
  if (input.response) return input.response;
  return respondDevEconomy(() => claimDevProgressionReward(context.token, input.body));
}
