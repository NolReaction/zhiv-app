/** Frozen baseline work, not the player's current stock or a promised deadline. */
export type OrderDifficulty = "ordinary" | "challenging" | "masterful";
export function orderDifficulty(effortSeconds: number, weekly = false): OrderDifficulty {
  const threshold = weekly ? [6 * 3600, 24 * 3600] : [30 * 60, 2 * 3600];
  return effortSeconds < threshold[0] ? "ordinary" : effortSeconds < threshold[1] ? "challenging" : "masterful";
}
export const orderDifficultyNames: Record<OrderDifficulty, string> = {
  ordinary: "Обычное", challenging: "Сложное", masterful: "Мастерское",
};
