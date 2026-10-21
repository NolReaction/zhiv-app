import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { adminRequest, getAdminEconomyPlayer, verifyAdminActor } from "./admin-api";
import { adminEconomyReceiptSchema } from "./admin-grants-api";
import { playerMessageSchema } from "./admin-delivery-contract";
import { validAdminReason } from "./admin-input";
import { readAdminAttempt, saveAdminAttempt } from "./admin-attempt-journal";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS } from "@/features/economy/domain/money";

const delta = z.number().int().min(-1_000_000_000).max(1_000_000_000);
export const adminAdjustmentSchema = z.object({ requestId: z.string().uuid(), confirmationPublicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/),
  reason: z.string().refine(validAdminReason), expectedRevision: z.number().int().nonnegative().safe(),
  coinsDelta: delta, pearlsDelta: delta, delivery: z.enum(["silent", "notify"]), playerMessage: playerMessageSchema.optional(),
}).strict().refine(value => (value.coinsDelta !== 0 || value.pearlsDelta !== 0)
  && (value.delivery === "notify" || value.playerMessage === undefined));
export type AdminAdjustment = z.infer<typeof adminAdjustmentSchema>;
export const readAdjustmentAttempt = (actor: string, target: string) => {
  const request = readAdminAttempt("adjust", actor, target, adminAdjustmentSchema);
  return request?.confirmationPublicId === target ? request : null;
};
export const saveAdjustmentAttempt = (actor: string, target: string, request: AdminAdjustment | null) => saveAdminAttempt("adjust", actor, target, request);
export function pendingAdjustmentTargets(actor: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const prefix = `zhiv:admin-adjust:${actor}:`;
    return Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.key(index))
      .filter((key): key is string => !!key && key.startsWith(prefix)).map(key => key.slice(prefix.length))
      .filter(target => !!readAdjustmentAttempt(actor, target));
  } catch { return []; }
}

export async function loadAdjustmentPlayer(actor: string, target: string, signal: AbortSignal) {
  await verifyAdminActor(actor, signal);
  const result = await getAdminEconomyPlayer(target, signal);
  await verifyAdminActor(actor, signal);
  return result;
}
export async function adjustAdminEconomy(actor: string, target: string, request: AdminAdjustment, signal: AbortSignal) {
  if (!adminAdjustmentSchema.safeParse(request).success || request.confirmationPublicId !== target) throw new ApiError("Проверьте состав корректировки.", 400);
  await verifyAdminActor(actor, signal);
  const result = await adminRequest(`users/${encodeURIComponent(target)}/adjust-economy`,
    adminEconomyReceiptSchema.refine(value => value.publicId === target && value.requestId === request.requestId), signal, request);
  await verifyAdminActor(actor, signal);
  return result;
}
export function adjustmentPreview(wallet: { coins: number; pearls: number }, coinsText: string, pearlsText: string) {
  const integer = (text: string) => /^[+-]?\d+$/.test(text.trim()) ? Number(text) : NaN;
  const coinsDelta = integer(coinsText), pearlsDelta = integer(pearlsText);
  if (![coinsDelta, pearlsDelta].every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000))
    return { issue: "Введите целые изменения от −1 000 000 000 до +1 000 000 000. Дробные значения недопустимы." };
  const coins = wallet.coins + coinsDelta, pearls = wallet.pearls + pearlsDelta * 2;
  if (coinsDelta === 0 && pearlsDelta === 0) return { issue: "Укажите ненулевое изменение хотя бы одной валюты." };
  if (![coins, pearls].every(value => Number.isSafeInteger(value) && value >= 0)) return { issue: "После корректировки баланс не может стать отрицательным или выйти за пределы допустимого числа." };
  if (coins > ECONOMY_MAX_BALANCE || pearls > ECONOMY_MAX_PEARLS) return { issue: "После корректировки превышен предельный баланс кошелька." };
  return { coinsDelta, pearlsDelta, coins, pearls, issue: null };
}
