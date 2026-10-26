import { gamePresenceHeaders, reportInactivePresence } from "@/features/activity/transport-state";
import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { retryAfterMs } from "@/lib/request-deadline";
import { economyResultSchema, economyViewSchema, marketCommandSchema, marketViewSchema, type EconomyCommand, type MarketCommand } from "@/features/economy/domain/model";
import type { EconomyDevCommand } from "@/features/economy/dev/dev-model";
import { neighborCommandSchema, neighborResultSchema, neighborViewSchema, type NeighborCommand } from "@/features/economy/domain/neighbor-model";

async function request<T>(path: string, schema: z.ZodType<T, unknown>, command?: EconomyCommand | MarketCommand | EconomyDevCommand | NeighborCommand, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  try {
    const presence = gamePresenceHeaders();
    const response = await fetch(path, {
      method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { ...presence, Accept: "application/json", ...(command ? { "Content-Type": "application/json" } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(body);
      // Framework/edge throttles can have an empty or plain-text body. The
      // status still proves a server-requested wait, not a lost connection.
      const failure = error.success ? error.data : response.status === 429
        ? { code: "RATE_LIMITED", message: "Сервер попросил сделать паузу перед следующей попыткой." } : undefined;
      reportInactivePresence(failure?.code, presence);
      throw new ApiError(failure?.message ?? "Не удалось связаться с хозяйством", response.status,
        failure, response.headers.get("X-Request-ID"), retryAfterMs(response.headers.get("Retry-After")));
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError("Обновите приложение: хозяйство получило новую версию", 502);
    return parsed.data;
  } finally {
    clearTimeout(timeout); signal?.removeEventListener("abort", abort);
  }
}

export const getEconomy = (signal?: AbortSignal) => request(
  "/api/v1/economy", economyViewSchema, undefined, signal);
export const sendEconomyCommand = (command: EconomyCommand, signal?: AbortSignal) => request(
  "/api/v1/economy/commands", economyResultSchema, command, signal);
export const getEconomyMarket = (signal?: AbortSignal) => request(
  "/api/v1/economy/market",
  marketViewSchema, undefined, signal);
export const sendMarketCommand = (command: MarketCommand, signal?: AbortSignal) => request(
  "/api/v1/economy/market/commands", economyResultSchema, command, signal);
export async function sendFriendMarketCommand(circleId: string, command: MarketCommand, signal?: AbortSignal) {
  const circle = z.guid().safeParse(circleId);
  const purchase = marketCommandSchema.extend({
    action: z.literal("buy_listing"), targetId: z.guid(), fishSelection: z.undefined().optional(),
  }).safeParse(command);
  if (!circle.success || !purchase.success) throw new ApiError("Не удалось определить покупку у друга", 400);
  const result = await request(`/api/v1/people/${encodeURIComponent(circle.data)}/world/market/commands`, economyResultSchema, purchase.data, signal);
  if (result.state.ownerPublicId !== command.ownerPublicId) throw new ApiError("Аккаунт изменился. Войдите в свой профиль заново.", 401);
  return result;
}
export const sendEconomyDevCommand = (command: EconomyDevCommand, signal?: AbortSignal) => request(
  "/api/v1/economy/dev", economyResultSchema, command, signal);
export async function getEconomyNeighbor(ownerPublicId: string, signal?: AbortSignal) {
  const result = await request("/api/v1/economy/neighbor", neighborViewSchema, undefined, signal);
  if (result.ownerPublicId !== ownerPublicId) throw new ApiError("Аккаунт изменился. Откройте полянку заново.", 401);
  return result;
}
export async function sendNeighborCommand(command: NeighborCommand, signal?: AbortSignal) {
  const parsed = neighborCommandSchema.safeParse(command);
  if (!parsed.success) throw new ApiError("Не удалось определить покупку у лесного соседа", 400);
  const result = await request("/api/v1/economy/neighbor/commands", neighborResultSchema, parsed.data, signal);
  if (result.state.ownerPublicId !== command.ownerPublicId) throw new ApiError("Аккаунт изменился. Откройте полянку заново.", 401);
  return result;
}
