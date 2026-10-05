import type { EconomyState } from "./model";

/** Nominal denomination only: ten current coins/pearls equal one retired unit. */
export const ECONOMY_CURRENCY_SCALE = 10;
export const ECONOMY_MAX_ITEMS = 1_000_000_000;
export const ECONOMY_MAX_BALANCE = ECONOMY_MAX_ITEMS * ECONOMY_CURRENCY_SCALE;
export function nominalEconomyMoney(amount: number, storedScale = 1): number {
  if (![1, ECONOMY_CURRENCY_SCALE].includes(storedScale) || !Number.isSafeInteger(amount)) throw new Error("Invalid stored currency");
  const nominal = amount * (ECONOMY_CURRENCY_SCALE / storedScale);
  if (!Number.isSafeInteger(nominal)) throw new Error("Unsafe currency amount");
  return nominal;
}
/** Old snapshots are converted once; inventory, time, probabilities and receipts are untouched. */
export function redenominateEconomyState(state: EconomyState): EconomyState {
  if (state.currencyScale === ECONOMY_CURRENCY_SCALE) return state;
  if (state.currencyScale != null && state.currencyScale !== 1) throw new Error("Unknown currency scale");
  const next = structuredClone(state);
  next.wallet.coins = nominalEconomyMoney(next.wallet.coins);
  next.wallet.pearls = nominalEconomyMoney(next.wallet.pearls);
  next.migration.coinsGranted = nominalEconomyMoney(next.migration.coinsGranted);
  for (const job of next.jobs) job.cost.coins = nominalEconomyMoney(job.cost.coins);
  next.currencyScale = ECONOMY_CURRENCY_SCALE;
  return next;
}
