/** Stable server reward IDs; ownership never changes competitive counters. */
export const GAME_ITEMS = [
  { id: "flower", title: "Цветок у дома", days: 3 },
  { id: "leaf_bed", title: "Подстилка из листьев", days: 7 },
  { id: "keepsakes", title: "Лесные сокровища", days: 14 },
  { id: "leaf_garland", title: "Гирлянда из листьев", days: 30 },
] as const;
export type GameItemId = (typeof GAME_ITEMS)[number]["id"];
export const GAME_ACHIEVEMENTS = [
  {
    id: "seven_day_streak",
    title: "В ритме",
    target: 7,
    description: "Достигните серии из 7 дней с отметками.",
    hint: "Учитывается лучшая серия, как в календаре: между отметками — не больше 24 часов.",
  },
  {
    id: "thousand_taps",
    title: "Тысяча искр",
    target: 1_000,
    description: "Наберите 1 000 игровых тапов.",
    hint: "Можно за несколько серий. Учитываются тапы, подтверждённые сервером.",
  },
  {
    id: "five_friends",
    title: "Свой круг",
    target: 5,
    description: "Соберите круг из 5 друзей.",
    hint: "Нужны 5 принятых связей одновременно. Заявки и общие группы не считаются.",
  },
  {
    id: "ten_thousand_series",
    title: "На одном дыхании",
    target: 10_000,
    description: "Наберите 10 000 тапов за одну игру.",
    hint: "Пауза в 10 секунд завершает игру. Учитывается лучший результат, подтверждённый сервером.",
  },
  {
    id: "linked_email",
    title: "На связи",
    target: 1,
    description: "Привяжите и подтвердите почту.",
    hint: "Если вы зарегистрировались по почте, достижение уже ваше. Привязать почту можно в разделе «Вход и безопасность».",
  },
  {
    id: "saved_recovery_code",
    title: "Запасной ключ",
    target: 1,
    description: "Сохраните резервный код восстановления.",
    hint: "В разделе «Вход и безопасность» сохраните код, подтвердите это и активируйте его.",
  },
] as const;
export function naturalItems(bestStreakDays: number): GameItemId[] {
  return GAME_ITEMS.filter(item => bestStreakDays >= item.days).map(item => item.id);
}
