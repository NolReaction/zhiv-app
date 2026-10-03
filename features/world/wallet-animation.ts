/** Presentation only: targets always come from the confirmed economy snapshot. */
export function walletTween(from: number, to: number, progress: number) {
  const fraction = Math.min(1, Math.max(0, progress));
  return Math.round(from + (to - from) * (1 - (1 - fraction) ** 3));
}

export function walletDeltaLabel(delta: number) {
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString("ru-RU")}`;
}
