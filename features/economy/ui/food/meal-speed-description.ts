/** The reduction compares the current timer with the extra speed from this meal. */
export function mealSpeedDescription(speedBps: number, existingSpeedBps = 0) {
  const speed = (speedBps / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  const reduction = 100 * speedBps / (10_000 + existingSpeedBps + speedBps);
  const time = reduction.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return `+${speed}% скорости · время ${Number.isInteger(reduction) ? "" : "≈ "}−${time}%`;
}
