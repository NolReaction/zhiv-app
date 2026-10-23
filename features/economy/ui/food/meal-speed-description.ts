/** Speed and elapsed time are different percentages: +25% speed saves 20% time. */
export function mealSpeedDescription(speedBps: number) {
  const speed = (speedBps / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  const reduction = 100 * speedBps / (10_000 + speedBps);
  const time = reduction.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return `+${speed}% скорости · время ${Number.isInteger(reduction) ? "" : "≈ "}−${time}%`;
}
