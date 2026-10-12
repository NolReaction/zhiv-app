import { formatPearls } from "@/features/economy/domain/money";

/** Presentation only: targets always come from the confirmed economy snapshot. */
export function walletTween(from: number, to: number, progress: number) {
  const fraction = Math.min(1, Math.max(0, progress));
  return Math.round(from + (to - from) * (1 - (1 - fraction) ** 3));
}

export function walletAmountLabel(amount: number, kind: "coins" | "pearls" = "coins") {
  return kind === "pearls" ? formatPearls(amount) : amount.toLocaleString("ru-RU");
}

export function walletDeltaLabel(delta: number, kind: "coins" | "pearls" = "coins") {
  return `${delta > 0 ? "+" : "−"}${walletAmountLabel(Math.abs(delta), kind)}`;
}
