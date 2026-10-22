import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken } from "@/lib/dev/api-route";
import { economyErrorResponse, readDevEconomyBody, respondDevEconomy } from "@/lib/dev/economy-route";
import { getDevOnboarding, saveDevOnboarding } from "@/lib/dev/onboarding-store";
import { onboardingAccountSchema } from "@/lib/onboarding-contract";

export const dynamic = "force-dynamic";
function context(request: Request, write = false) {
  const rejected = guardDevApi(request, write, 1_024);
  if (rejected) return rejected;
  const generation = request.headers.get("X-Game-Generation");
  if (generation !== null && generation !== "0") return economyErrorResponse("GAME_PROGRESS_RESET", "Игра началась заново", 409);
}
export async function GET(request: Request) {
  const rejected = context(request); if (rejected) return rejected;
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].length !== 1 || params.getAll("ownerPublicId").length !== 1
    || !onboardingAccountSchema.shape.ownerPublicId.safeParse(params.get("ownerPublicId")).success)
    return economyErrorResponse("INVALID_ONBOARDING", "Некорректный запрос обучения");
  const token = await devSessionToken();
  return respondDevEconomy(() => getDevOnboarding(token, params.get("ownerPublicId")!));
}
export async function POST(request: Request) {
  const rejected = context(request, true); if (rejected) return rejected;
  if (new URL(request.url).search) return economyErrorResponse("INVALID_ONBOARDING", "Некорректный запрос обучения");
  const input = await readDevEconomyBody(request, 1_024); if (input.response) return input.response;
  const token = await devSessionToken();
  return respondDevEconomy(() => saveDevOnboarding(token, input.body));
}
