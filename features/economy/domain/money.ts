import type { EconomyState } from "./model";

/** Stored units relative to the retired unit: coins ×10 and pearls ×50. Display pearls separately. */
export const ECONOMY_CURRENCY_SCALE = 10;
export const ECONOMY_PEARL_SCALE = 50;
export const ECONOMY_MAX_ITEMS = 1_000_000_000;
export const ECONOMY_MAX_BALANCE = ECONOMY_MAX_ITEMS * ECONOMY_CURRENCY_SCALE;
export const ECONOMY_MAX_PEARLS = ECONOMY_MAX_ITEMS * ECONOMY_PEARL_SCALE;
/** Storage and signed receipts stay integral; one visible pearl is two stored units. */
export const PEARL_DISPLAY_DIVISOR = 2;
export function pearlDisplayAmount(storedAmount: number): number {
  return storedAmount / PEARL_DISPLAY_DIVISOR;
}
export function formatPearls(storedAmount: number, options: Intl.NumberFormatOptions = {}): string {
  return pearlDisplayAmount(storedAmount).toLocaleString("ru-RU", { maximumFractionDigits: 1, ...options });
}
export function nominalEconomyMoney(amount: number, storedScale = 1): number {
  return nominal(amount, storedScale, ECONOMY_CURRENCY_SCALE);
}
export function nominalEconomyPearls(amount: number, storedScale = 1): number {
  return nominal(amount, storedScale, ECONOMY_PEARL_SCALE);
}
function nominal(amount: number, storedScale: number, targetScale: number): number {
  if (![1, 10, targetScale].includes(storedScale) || !Number.isSafeInteger(amount)) throw new Error("Invalid stored currency");
  const value = amount * (targetScale / storedScale);
  if (!Number.isSafeInteger(value)) throw new Error("Unsafe currency amount");
  return value;
}
/** Independent markers preserve both earlier denominations; paid receipts stay raw. */
export function redenominateEconomyState(state: EconomyState): EconomyState {
  if (state.currencyScale === ECONOMY_CURRENCY_SCALE && state.pearlScale === ECONOMY_PEARL_SCALE) return state;
  const coinScale = state.currencyScale ?? 1, pearlScale = state.pearlScale ?? coinScale;
  const next = structuredClone(state);
  next.wallet.coins = nominalEconomyMoney(next.wallet.coins, coinScale);
  next.wallet.pearls = nominalEconomyPearls(next.wallet.pearls, pearlScale);
  next.migration.coinsGranted = nominalEconomyMoney(next.migration.coinsGranted, coinScale);
  if (next.residentOrders) next.residentOrders.earnedCoins = nominalEconomyMoney(next.residentOrders.earnedCoins, coinScale);
  for (const job of next.jobs) job.cost.coins = nominalEconomyMoney(job.cost.coins, coinScale);
  next.currencyScale = ECONOMY_CURRENCY_SCALE;
  next.pearlScale = ECONOMY_PEARL_SCALE;
  return next;
}
