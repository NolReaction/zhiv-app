import { formatPearls, PEARL_DISPLAY_DIVISOR } from "@/features/economy/domain/money";

/** Presentation only: targets always come from the confirmed economy snapshot. */
export function walletTween(from: number, to: number, progress: number, kind: "coins" | "pearls" = "coins") {
  const fraction = Math.min(1, Math.max(0, progress));
  if (fraction === 0) return from;
  if (fraction === 1) return to;
  // Animate visible units, rather than creating half-pearls between two whole
  // confirmed balances. A real odd stored balance keeps its exact endpoint.
  const unit = kind === "pearls" ? PEARL_DISPLAY_DIVISOR : 1;
  const rounded = Math.round((from + (to - from) * (1 - (1 - fraction) ** 3)) / unit) * unit;
  return Math.max(Math.min(from, to), Math.min(Math.max(from, to), rounded));
}

export function walletAmountLabel(amount: number, kind: "coins" | "pearls" = "coins") {
  const stored = Math.round(amount);
  return kind === "pearls" ? formatPearls(stored) : stored.toLocaleString("ru-RU", { maximumFractionDigits: 0 });
}

export function walletDeltaLabel(delta: number, kind: "coins" | "pearls" = "coins") {
  return `${delta > 0 ? "+" : "−"}${walletAmountLabel(Math.abs(delta), kind)}`;
}
