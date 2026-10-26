/** Stable server reward IDs; ownership never changes competitive counters. */
export const GAME_ITEMS = [
  { id: "flower", title: "Цветы в глиняном горшке", days: 3 },
  { id: "leaf_bed", title: "Плетёный коврик", days: 7 },
  { id: "keepsakes", title: "Ящик лесных находок", days: 14 },
  { id: "leaf_garland", title: "Гирлянда из листьев", days: 30 },
] as const;
export type GameItemId = (typeof GAME_ITEMS)[number]["id"];
export const GAME_ACHIEVEMENTS = [
  {
    id: "seven_day_streak",
    title: "В ритме",
    target: 7,
    tiers: [7], category: "personal",
    description: "Достигните серии из 7 дней с отметками.",
    hint: "Учитывается лучшая серия, как в календаре: между отметками проходит не больше 24 часов.",
  },
  {
    id: "thousand_taps",
    title: "Тысяча искр",
    target: 1_000,
    tiers: [1_000], category: "personal",
    description: "Наберите 1 000 игровых тапов.",
    hint: "Можно за несколько серий. Учитываются тапы, подтверждённые сервером.",
  },
  {
    id: "five_friends",
    title: "Свой круг",
    target: 5,
    tiers: [5], category: "personal",
    description: "Соберите круг из 5 друзей.",
    hint: "Нужны 5 принятых связей одновременно. Заявки и общие группы не считаются.",
  },
  {
    id: "ten_thousand_series",
    title: "На одном дыхании",
    target: 10_000,
    tiers: [10_000], category: "personal",
    description: "Наберите 10 000 тапов за одну игру.",
    hint: "Пауза в 10 секунд завершает игру. Учитывается лучший результат, подтверждённый сервером.",
  },
  {
    id: "linked_email",
    title: "На связи",
    target: 1,
    tiers: [1], category: "personal",
    description: "Привяжите и подтвердите почту.",
    hint: "Если вы зарегистрировались по почте, достижение уже ваше. Привязать почту можно в разделе «Вход и безопасность».",
  },
  {
    id: "saved_recovery_code",
    title: "Запасной ключ",
    target: 1,
    tiers: [1], category: "personal",
    description: "Сохраните резервный код восстановления.",
    hint: "В разделе «Вход и безопасность» сохраните код, подтвердите это и активируйте его.",
  },
  {
    id: "full_collection", title: "Хранитель находок", target: 12,
    tiers: [12], category: "world",
    description: "Соберите все 12 находок леса и рыбалки.",
    hint: "Завершайте прогулки и рыбалку. Каждый выход сначала приносит одну недостающую находку своего маршрута.",
  },
  {
    id: "first_path", title: "Первый след", target: 1, tiers: [1], category: "world",
    description: "Вернитесь с первой вылазки.",
    hint: "Завершите исследование и заберите его награду. Отменённые задания не считаются.",
  },
  {
    id: "familiar_trails", title: "Знакомые тропы", target: 3, tiers: [3], category: "world",
    description: "Завершите вылазки по трём разным маршрутам.",
    hint: "Заберите награды на трёх разных маршрутах из «В путь» или каменоломни. Повторы одного маршрута не добавляют новый. Прежняя полученная медаль сохраняется.",
  },
  {
    id: "explorer", title: "Следопыт", target: 1000, tiers: [10, 50, 200, 1000], category: "world",
    description: "Завершайте исследования мира.",
    hint: "Ступени: 10, 50, 200 и 1000 исследований с полученной наградой. Запуск и отмена задания не увеличивают прогресс.",
  },
  {
    id: "master_recipes", title: "Руки мастера", target: 61, tiers: [5, 10, 35, 61], category: "world",
    description: "Осваивайте разные рецепты производства.",
    hint: "Получите результат 5, 10, 35 и 61 разных рецептов. Считается сохранённая история производства, включая сад и костёр. Повтор одного рецепта не увеличивает число освоенных.",
  },
  {
    id: "home_builder", title: "Дом становится домом", target: 5, tiers: [2, 3, 4, 5], category: "world",
    description: "Развивайте дом от второго до пятого уровня.",
    hint: "Каждое завершённое улучшение дома открывает ступень. Стройка в процессе ещё не считается.",
  },
  {
    id: "river_atlas", title: "Речной атлас", target: 12, tiers: [12], category: "world",
    description: "Поймайте двенадцать разных видов рыбы, включая легендарную акулу.",
    hint: "Считаются виды из полученного улова. Покупка рыбы и повторные уловы уже знакомого вида не добавляют новый вид.",
  },
  {
    id: "first_sale", title: "Свой прилавок", target: 1, tiers: [1], category: "world",
    description: "Продайте свой первый товар на рынке.",
    hint: "Дождитесь, когда другой игрок купит ваш лот. Публикация и отмена лота не считаются продажей.",
  },
  {
    id: "lucky_find", title: "Счастливая находка", target: 1, tiers: [1], category: "world",
    description: "Найдите первый личный коллекционный предмет.",
    hint: "Получите личную коллекционную находку из завершённого задания. Обычные ресурсы, унаследованный архив и покупка товара не считаются находкой.",
  },
  {
    id: "patient_angler", title: "Терпеливый рыболов", target: 1000, tiers: [10, 50, 200, 1000], category: "world",
    description: "Поймайте 10, 50, 200 и 1000 рыб.",
    hint: "Забирайте собственный улов. Любой вид подходит; покупка, подарок и рыба из запасов не добавляют прогресс.",
  },
  {
    id: "campfire_cook", title: "Умелый повар", target: 500, tiers: [5, 25, 100, 500], category: "world",
    description: "Завершите 5, 25, 100 и 500 приготовлений у костра.",
    hint: "Забирайте готовую еду, компоты и другие результаты костра. Считаются завершённые заказы, а не число порций; один рецепт можно повторять.",
  },
  {
    id: "helpful_neighbor", title: "Надёжный сосед", target: 500, tiers: [5, 25, 100, 500], category: "world",
    description: "Выполните 5, 25, 100 и 500 просьб жителей.",
    hint: "Сдавайте просьбы в журнале заказов. Засчитываются также учебные поручения и задания «Пути хозяйства»; замена и просмотр карточки не считаются.",
  },
  {
    id: "generous_garden", title: "Щедрый сад", target: 1000, tiers: [10, 50, 200, 1000], category: "world",
    description: "Заберите 10, 50, 200 и 1000 урожаев в саду.",
    hint: "Считаются полученные результаты садовых заказов, включая ягоды и волокно. Размер партии не умножает прогресс; покупка готовых товаров не считается урожаем.",
  },
] as const;
export type GameAchievementDefinition = (typeof GAME_ACHIEVEMENTS)[number];
/** Retired collection ownership remains valid for the API and moderation. */
export const VISIBLE_GAME_ACHIEVEMENTS = GAME_ACHIEVEMENTS.filter(item => item.id !== "full_collection");
export function naturalItems(bestStreakDays: number): GameItemId[] {
  return GAME_ITEMS.filter(item => bestStreakDays >= item.days).map(item => item.id);
}
