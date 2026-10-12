import { NextResponse } from "next/server";
import { promoRequestSchema } from "@/features/promo/model";
import { promoCatalog } from "@/lib/server/promo-catalog";
import { redeemDevPromo } from "@/lib/dev/economy-store";
import { getDevIdentity } from "@/lib/dev/api-store";
import { NO_STORE_HEADERS } from "@/lib/dev/api-route";
import { devEconomyContext, readDevEconomyBody, economyErrorResponse, respondDevEconomy } from "@/lib/dev/economy-route";
const local = globalThis as typeof globalThis & { __zhivPromoAttempts?: Map<string, { start: number; count: number }> };

export async function POST(request: Request) {
  const context = await devEconomyContext(request, true, 1024);
  if (context.response) return context.response;
  const owner = getDevIdentity(context.token)!.user.publicId, now = Date.now();
  const attempts = local.__zhivPromoAttempts ??= new Map();
  for (const [key, value] of attempts) if (now - value.start >= 60_000) attempts.delete(key);
  const used = attempts.get(owner) ?? { start: now, count: 0 };
  attempts.set(owner, used); used.count++;
  if (used.count > 6) return NextResponse.json({ code: "RATE_LIMITED", message: "Слишком много попыток. Подождите минуту." },
    { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(Math.ceil((60_000 - (now - used.start)) / 1000)) } });
  const body = await readDevEconomyBody(request, 1024);
  if (body.response) return body.response;
  const command = promoRequestSchema.safeParse(body.body);
  if (!command.success) return economyErrorResponse("INVALID_PROMO_CODE", "Проверьте промокод: от 3 до 40 латинских букв, цифр, - или _.");
  return respondDevEconomy(() => redeemDevPromo(context.token, command.data, promoCatalog, now));
}
