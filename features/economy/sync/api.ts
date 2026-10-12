import { gamePresenceHeaders, reportInactivePresence } from "@/features/activity/transport-state";
import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { economyResultSchema, economyViewSchema, marketViewSchema, type EconomyCommand, type MarketCommand } from "@/features/economy/domain/model";
import type { EconomyDevCommand } from "@/features/economy/dev/dev-model";

async function request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, command?: EconomyCommand | MarketCommand | EconomyDevCommand, signal?: AbortSignal): Promise<T> {
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
      const retry = response.headers.get("Retry-After");
      const retryMs = retry == null ? undefined : /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      reportInactivePresence(error.success ? error.data.code : undefined, presence);
      throw new ApiError(error.success ? error.data.message : "Не удалось связаться с хозяйством", response.status,
        error.success ? error.data : undefined, response.headers.get("X-Request-ID"),
        retryMs != null && Number.isFinite(retryMs) ? Math.max(0, retryMs) : undefined);
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
export const sendEconomyDevCommand = (command: EconomyDevCommand, signal?: AbortSignal) => request(
  "/api/v1/economy/dev", economyResultSchema, command, signal);
