/** Stable server reward IDs; ownership never changes competitive counters. */
export const GAME_ITEMS = [
  { id: "flower", title: "Цветок у дома", days: 3 },
  { id: "leaf_bed", title: "Подстилка из листьев", days: 7 },
  { id: "keepsakes", title: "Лесные сокровища", days: 14 },
  { id: "leaf_garland", title: "Гирлянда из листьев", days: 30 },
] as const;
export type GameItemId = (typeof GAME_ITEMS)[number]["id"];
export const GAME_ACHIEVEMENTS = [
  { id: "seven_day_streak", title: "В ритме", target: 7 },
  { id: "thousand_taps", title: "Тысяча искр", target: 1_000 },
  { id: "five_friends", title: "Свой круг", target: 5 },
  { id: "ten_thousand_series", title: "На одном дыхании", target: 10_000 },
  { id: "linked_email", title: "На связи", target: 1 },
  { id: "saved_recovery_code", title: "Запасной ключ", target: 1 },
] as const;
export function naturalItems(bestStreakDays: number): GameItemId[] {
  return GAME_ITEMS.filter(item => bestStreakDays >= item.days).map(item => item.id);
}
