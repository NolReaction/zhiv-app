import releaseFeatures from "@/apps/api/src/main/resources/world/release-features.json";
import { CLICKER_IDLE_RESET_MS } from "@/features/game/clicker-story";
import { PLAYER_LEVELS, playerProgressionCatalog } from "@/features/economy/domain/player-levels";
import { miningBatchCatalog } from "@/features/economy/domain/mining-batch";
import { economyCatalog, economyProgressionSchema, recipeBuildingLevel } from "@/features/economy/domain/model";
import { mealTimeExample } from "@/features/economy/ui/food/meal-speed-description";
import { experimentSuccessBps } from "@/features/economy/domain/craft-skill";
import { fishingClassOdds } from "@/features/economy/domain/fishing";
import { formatPearls } from "@/features/economy/domain/money";
import { constructionTimePearlPrice } from "@/features/economy/domain/rules";
import { shipOrdersConfig } from "@/features/economy/domain/ship-orders";
import { progressionRewardsCatalog } from "@/features/game/progression-rewards";
import { BARTER_HOME_LEVEL } from "@/features/economy/domain/barter-model";
import { GOLD_SHOP_PACKAGES } from "@/features/economy/domain/currency-shop";
import { storefrontCatalog } from "@/features/economy/domain/storefront";
import { TRAVEL_COLLECTION_SECONDS, QUARRY_COLLECTION_SECONDS } from "@/features/world/domain/collection-book";
import type { WorldHelpTarget } from "./world-help-types";
export { searchWorldHelp, searchWorldHelpWithStatus } from "./world-help-search";

export const worldHelpGroups = [
  { id: "start", title: "Первые шаги", description: "Начало игры и управление" },
  { id: "economy", title: "Запасы и стройка", description: "Материалы, рецепты и монеты" },
  { id: "travel", title: "Вылазки и рыбалка", description: "Маршруты, снасти и находки" },
  { id: "food", title: "Готовка и заказы", description: "Готовка, сытость и заработок" },
  { id: "mochlik", title: "Мохлик", description: "Настроение, сон и внешность" },
  { id: "account", title: "Аккаунт и друзья", description: "Сохранение, связь и помощь" },
] as const;

export type WorldHelpGroup = typeof worldHelpGroups[number]["id"];
export type WorldHelpTopic = {
  id: string;
  group: WorldHelpGroup;
  title: string;
  summary: string;
  keywords: string;
  paragraphs?: readonly string[];
  steps?: readonly string[];
  note?: string;
  action?: { label: string; target: WorldHelpTarget };
  relatedIds?: readonly string[];
};

const itemName = (id: string) => economyCatalog.items.find(item => item.id === id)?.name ?? id;
const findChance = (routeId: string, itemId: string) => {
  const finds = economyCatalog.explorations.find(route => route.id === routeId)?.finds;
  const total = (finds?.emptyWeight ?? 0) + (finds?.entries.reduce((sum, entry) => sum + entry.weight, 0) ?? 0);
  return total ? Math.round((finds?.entries.find(entry => entry.itemId === itemId)?.weight ?? 0) * 100 / total) : 0;
};

/** Short answers for players. Rule values come from the same catalog as gameplay. */
export function worldHelpTopics(_legacyRebuilding?: boolean): readonly WorldHelpTopic[] {
  void _legacyRebuilding;
  const food = economyCatalog.food;
  const boat = economyCatalog.boat!;
  const fishingTarget: WorldHelpTarget = releaseFeatures.boatFishingEnabled ? { kind: "boat" } : { kind: "expeditions", sector: "coast" };
  const boatRepair = boat.upgrades.find(upgrade => upgrade.id === "repair")!;
  const hiddenDishes = new Set(economyCatalog.recipes.filter(recipe => recipe.experiment).flatMap(recipe => Object.keys(recipe.rewards)));
  const knownMeals = food?.meals.filter(meal => !hiddenDishes.has(meal.itemId) && ["grilled_fish", "fish_soup", "hearty_fish"].includes(meal.itemId)) ?? [];
  const skillLevels = economyCatalog.skills?.levels ?? [];
  const maxSkill = skillLevels.at(-1);
  const mastery = economyProgressionSchema.parse({ skills: { cookingSeconds: maxSkill?.requiredSeconds ?? 0 } });
  const experiments = economyCatalog.recipes.filter(recipe => recipe.experiment);
  const baseCookingChance = Math.min(100, ...experiments.map(recipe => recipe.experiment!.successBps / 100));
  const maxCookingChance = Math.max(baseCookingChance, ...experiments.map(recipe => experimentSuccessBps({ progression: mastery }, recipe) / 100));
  const onboarding = economyCatalog.onboarding;
  const firstWorkshop = economyCatalog.buildings.find(building => building.id === "workshop")?.levels.find(level => level.level === 1);
  const tutorialOrders = onboarding?.residentOrders ?? (onboarding ? [onboarding.residentOrder] : []);
  const firstStageOrders = economyCatalog.stageOrders?.find(stage => stage.homeLevel === 1)?.orders ?? [];
  const secondStageOrders = economyCatalog.stageOrders?.find(stage => stage.homeLevel === 2)?.orders ?? [];
  const thirdStage = economyCatalog.stageOrders?.find(stage => stage.homeLevel === 3);
  const fourthStage = economyCatalog.stageOrders?.find(stage => stage.homeLevel === 4);
  const fourthHome = economyCatalog.buildings.find(building => building.id === "home")?.levels.find(level => level.level === 4);
  const fifthHome = economyCatalog.buildings.find(building => building.id === "home")?.levels.find(level => level.level === 5);
  const soupRecipe = economyCatalog.recipes.find(recipe => recipe.id === "cook_fish_soup");
  const soupMeal = food?.meals.find(meal => meal.itemId === "fish_soup");
  const storageLevels = economyCatalog.buildings.find(building => building.id === "warehouse")?.levels ?? [];
  const firstRelicStorageLevel = storageLevels.find(level => Object.keys(level.cost.items).some(id => economyCatalog.items.some(item => item.id === id && item.category === "special")))?.level;
  const dailyPearls = progressionRewardsCatalog.daily.reduce((sum, reward) => sum + reward.pearls, 0);
  const berryTiers = [
    [2, "grow_blueberries", "cook_blueberry_compote"], [3, "grow_currants", "cook_currant_jelly"],
    [4, "grow_blackberries", "cook_blackberry_preserve"], [5, "grow_cranberries", "cook_cranberry_glaze"],
  ] as const;
  const berryTierStep = ([home, cropId, dishId]: typeof berryTiers[number]) => {
    const crop = economyCatalog.recipes.find(recipe => recipe.id === cropId)!;
    const dish = economyCatalog.recipes.find(recipe => recipe.id === dishId)!;
    const meal = food!.meals.find(meal => (dish.rewards[meal.itemId] ?? 0) > 0)!;
    return `Дом ${home}, куст ${recipeBuildingLevel(crop)}: ${itemName(Object.keys(crop.rewards)[0])}, ${crop.seconds / 60} мин. ${itemName(meal.itemId)}: костёр ${recipeBuildingLevel(dish)}, ${dish.seconds / 60} мин; вылазка ${mealTimeExample(meal.heroSpeedBps, meal.heroWorkSeconds)}.`;
  };
  const legendaryChance = economyCatalog.fishing ? fishingClassOdds({}, economyCatalog.fishing,
    { rodId: "starfall_rod", hookId: "leviathan_hook", baitId: "star_bait" })
    .filter(odds => odds.rarity === "legendary")
    .reduce((sum, odds) => sum + odds.probability, 0) : 0;
  return [
    {
      id: "start", group: "start", title: "С чего начать играть?", summary: "Ягоды, соседи и первая мастерская",
      keywords: "новичок начало впервые ничего не понимаю непонятно что делать дальше обучение",
      steps: [
        "Уровень Мохлика → «?»: продолжить или повторить курс. Скрытие сохраняет шаг, завершение и пропуск - на аккаунте. «Что здесь делать?» запускает подсказки вручную. Кнопку можно скрыть в настройках вида.",
        "Нажмите куст и карточку малины: урожай бесплатный. Только в открытом уроке первый учебный урожай помечен «Сразу» и доступен один раз. После сворачивания или завершения урока действуют обычные сроки. Повтор обучения помощь не возвращает.",
        "Нажмите «Собрать» у спелых ягод и дождитесь доставки в кладовую. «Собрать всё» заберёт готовые места одним походом. Затем отдайте одну малину в учебный заказ.",
        "Познакомьтесь с соседями, откройте лесной участок и улучшите уже горящий костёр. Шаг «Мастерская» даёт одноразовую стройку без расхода запасов. Просьбы к дому 2 потребуют брёвна, компоты и доски.",
      ],
      note: "Шаги можно отложить. Работы идут и в закрытой игре; готовые запасы ждут вас и не портятся.",
      action: { label: "К ягодному кусту", target: { kind: "station", stationId: "garden" } },
      relatedIds: ["controls", "production", "construction", ...(firstWorkshop ? ["workshop-starter"] : [])],
    },
    ...(onboarding ? [{
      id: "starting-pack", group: "start", title: "Что есть в начале игры?", summary: "Первые припасы и деньги уже на полянке",
      keywords: "начало старт новичок подарок набор рыба камень дерево древесина монеты жемчуг",
      paragraphs: [`Новое хозяйство получает ${onboarding.startingWallet.coins} монет, ${formatPearls(onboarding.startingWallet.pearls)} жемчужин и припасы: ${Object.entries(onboarding.startingItems).map(([id, count]) => `${itemName(id)} × ${count}`).join(", ")}. Откройте кладовую, чтобы их посмотреть.`],
      note: "Дом, куст и кладовая уже первого уровня. Повтор обучения не пополняет запасы. Для заказов нужны свои припасы; первую мастерскую можно построить с одноразовой учебной помощью.",
      action: { label: "Открыть кладовую", target: { kind: "pantry" } },
      relatedIds: ["start", "tutorial-order", "workshop-starter"],
    }, {
      id: "tutorial-order", group: "start", title: "Как выполнить учебную просьбу?", summary: "Одна малина, затем просьбы к дому 2",
      keywords: "учебный обучение практика ингредиенты бесплатно шишколап получить ягоды древесина",
      steps: [
        "Вырастите малину у куста, нажмите «Собрать» и дождитесь её доставки в кладовую. Созревшая ягода ещё не в запасах; обучение покажет сбор до первой сдачи.",
        "Нажмите доску на карте или «Заказы» внизу. В «Пути хозяйства» найдите учебную просьбу и сравните «есть / нужно».",
        `Учебный заказ: ${tutorialOrders.map(order => `${Object.entries(order.items).map(([id, count]) => `${itemName(id)} × ${count}`).join(" + ")} за ${order.coins} монет`).join("; ")}.`,
        "Сами нажмите «Отдать заказ»: малина спишется, монеты поступят в кошелёк. Открытие карточки ничего не отдаёт. Затем откроются просьбы к дому 2.",
      ],
      note: `Учебный заказ один. Затем появятся ${firstStageOrders.length} небольшие просьбы для дома 2. Срока нет; шаг можно отложить. Прежние принятые условия сохранены, повтор обучения не выдаёт награды заново.`,
      action: { label: "Посмотреть заказы", target: { kind: "orders" } },
      relatedIds: ["resident-orders", "resources", "workshop-starter"],
    }] satisfies WorldHelpTopic[] : []),
    ...(fourthStage && fifthHome ? [{
      id: "fourth-house-stage", group: "economy", title: "Как перейти от дома 4 к дому 5?", summary: "Мост, маяк и исследование руин",
      keywords: "четвертый четвёртый этап дом 4 дом 5 мост маяк руины экспедиция паек паёк снаряжение ядро кристалл проект",
      steps: [
        `Откройте журнал «Заказы» внизу карты. Жители помогают оплатить стройки: ${fourthStage.orders.length} поставок дают ${fourthStage.orders.reduce((sum, order) => sum + order.coins, 0)} монет однократного финансирования проекта. Обычные заказы и продажа товаров приносят остальные монеты.`,
        "Подготовьте полевой комплект в мастерской и паёк у костра. Восстановите мост и маяк, заберите готовые стройки.",
        "Выберите «Древние руины» в меню вылазок. После похода заберите добычу. Запуск или отмена не заменяют получение результата.",
        `Завершите проект: получите ${Object.entries(fourthStage.completionRewards).map(([id, count]) => `${itemName(id)} × ${count}`).join(", ")}. Соберите остальные материалы дома 5 и запустите стройку на ${fifthHome.seconds / 3600} ч.`,
      ],
      note: fourthStage.intervalSeconds > 0 ? `Между поставками ${fourthStage.intervalSeconds / 3600} ч. Сохранённые сроки видны в проекте; пропуски сохраняют прогресс.` : "Следующая поставка открывается сразу после сдачи предыдущей. Подготовьте товары и освойте нужные производства. Уже принятые условия остаются прежними; бесплатных мест достаточно, дополнительные места позволяют готовить параллельно.",
      action: { label: "Посмотреть проект", target: { kind: "orders" } },
      relatedIds: ["future-world", "construction", "journeys", "relics", "resident-orders"],
    }] satisfies WorldHelpTopic[] : []),
    ...(thirdStage ? [{
      id: "third-house-stage", group: "economy", title: "Как перейти от дома 3 к дому 4?", summary: "Проект полянки и новые производства",
      keywords: "третий этап дом 3 дом 4 проект полянка поставка поставки неделя живая смола ожидание сутки",
      steps: [
        `Откройте журнал «Заказы» внизу карты. Первая из ${thirdStage.orders.length} проектных поставок доступна сразу.`,
        thirdStage.intervalSeconds > 0 ? `После сдачи каждой поставки следующая появится через ${thirdStage.intervalSeconds / 3600} ч.` : "Сдайте товары: следующая поставка станет доступна сразу. Готовьте несколько цепочек параллельно и следите за местом в кладовой.",
        `Завершите цепочку: последняя поставка гарантированно выдаёт ${Object.entries(thirdStage.completionRewards).map(([id, count]) => `${itemName(id)} × ${count}`).join(", ")}. Остальные требования видны в улучшении дома 4.`,
      ],
      note: `Поставки не истекают и не заменяются. Начатые проекты сохраняют обещанные условия. После подготовки дом 4 строится ${(fourthHome?.seconds ?? 0) / 3600} ч без ускорений; это не срок прохождения всего этапа.`,
      action: { label: "Посмотреть проект", target: { kind: "orders" } },
      relatedIds: ["resident-orders", "construction", "relics", "fish-soup"],
    }] satisfies WorldHelpTopic[] : []),
    ...(secondStageOrders.length ? [{
      id: "second-house-stage", group: "economy", title: "Что делать после дома 2?", summary: "Верёвка, шахта, печь и дом 3",
      keywords: "второй этап дом 2 дом 3 второй уровень третий веревка верёвка волокно глина уголь кирпич печь",
      steps: [
        "Собирайте волокно на лесном участке. В мастерской две единицы волокна дают одну верёвку за три минуты.",
        "Постройте шахту, добудьте камень и улучшите её до уровня 2 для глины. Добыча работает независимо от Мохлика.",
        "Откройте вкладку «Печь» в мастерской. Из бревна уголь получается за две минуты; из глины и угля кирпич - за три.",
        `Выполните ${secondStageOrders.length} постоянных просьб, включая улов и жареную рыбу. Соберите материалы и монеты для дома 3 и начните улучшение.`,
      ],
      note: "Кладовая на 50 мест и бесплатные места производства подходят для всего этапа. Каждый запуск выпускает один предмет; очередь занята до получения.",
      action: { label: "Открыть заказы", target: { kind: "orders" } },
      relatedIds: ["mining", "production", "second-stage-orders", "construction", "future-world", "berry-tiers"],
    }, {
      id: "second-stage-orders", group: "economy", title: "Какие просьбы ведут к дому 3?", summary: `${secondStageOrders.length} постоянных просьб второго этапа`,
      keywords: "второй этап постоянные просьбы дом 3 верёвки камень глина древесный уголь кирпичи улов жареная рыба",
      paragraphs: [secondStageOrders.map(order => `${Object.entries(order.items).map(([id, count]) => `${itemName(id)} × ${count}`).join(" + ")} за ${order.coins} монет`).join("; ") + "."],
      steps: [
        "Откройте журнал «Заказы» внизу карты. Постоянная просьба стоит над обычными заказами; недостающий товар открывает его источник.",
        `Передайте собранные товары. Следующая просьба появится сразу. Все ${secondStageOrders.length} нужны для нового дома 3; они не исчезают и не заменяются.`,
      ],
      action: { label: "Посмотреть заказы", target: { kind: "orders" } },
      relatedIds: ["second-house-stage", "resident-orders", "mining"],
    }] satisfies WorldHelpTopic[] : []),
    {
      id: "controls", group: "start", title: "Как управлять картой?", summary: "Передвинуть, приблизить и найти Мохлика",
      keywords: "карта телефон мышь клавиатура масштаб зум увеличить уменьшить потерялся найти мохлика выйти назад вода река волны рябь",
      steps: [
        "Перетаскивайте карту пальцем или мышью. Приближайте двумя пальцами или колёсиком.",
        "Коснитесь воды: появятся всплеск и волны. Нажатие рядом с листиком оттолкнёт его, по листику - ненадолго притопит. Звук - в «Постройки и действия». В режиме «Меньше движения» эффект отключён.",
        "Нажмите здание, чтобы открыть действия. Кладовая, вылазки, заказы и объявления - внизу; почта, гардероб и коллекции - в «Ещё». Ромбики отключаются в профиле → шестерёнка → «Подсказки нажатия»; сами здания останутся доступны.",
        "С клавиатуры: Tab выбирает карту, стрелки двигают её, «+» и «−» меняют масштаб, Home находит Мохлика.",
      ],
      note: "Стрелка слева сверху возвращает на главный экран. Уровень открывает профиль. Значок у «Ещё» сообщает о непрочитанной почте.",
      relatedIds: ["start", "mochlik-life", "sound", "tree-taps"],
    },
    {
      id: "tree-taps", group: "start", title: "Что происходит при нажатии на крону?", summary: "Покачивание, листья и тихий шелест",
      keywords: "дерево деревья крона листва листья падают шелест шорох нажать коснуться",
      steps: [
        "Нажмите на крону дерева на большой карте: она слегка покачнётся и посыплются листья. Перетаскивание и удержание экрана эффекта не вызывают.",
        "Громкость шелеста регулируется в «Постройки и действия». Приближение камеры не делает его громче.",
        "В режиме «Меньше движения» остаётся только тихий звук.",
      ],
      note: "Это маленький отклик леса: ресурсы за нажатие не выдаются. У части деревьев вдали ещё нет такого отклика.",
      relatedIds: ["controls", "sound"],
    },
    {
      id: "sound", group: "start", title: "Где настроить звук?", summary: "Музыка, окружение, шаги, голоса и кнопки",
      keywords: "звук музыка громкость динамик тишина выключить включить шаги животные голоса окружение кнопки настройки",
      steps: [
        "Откройте «Профиль» → шестерёнку настроек. На карте профиль открывается кнопкой уровня слева сверху.",
        "На новом устройстве звук включён: музыка 10%, шаги животных 25%, интерфейс 100%. Меняйте общую громкость и группы отдельно. Обновления сохраняют ваш выбор.",
        "«Шаги животных» на 0% убирают только шаги трёх героев. «Музыка» на 0% позволяет слушать свою музыку. Голоса и постройки сохраняют громкость.",
        "«Сбросить громкость» возвращает рекомендуемый баланс, сохраняя выбор включения звука. В фоне игра молчит; если звук не вернулся, нажмите «Продолжить воспроизведение».",
      ],
      note: "В меню звучат музыка и кнопки, на карте добавляются окружение, постройки и герои. «Лес и вода» управляет птицами, насекомыми, рекой и каплями; «Погода» - ветром и дождём. Котелок слышен, пока готовится еда, даже под дождём.",
      action: { label: "Открыть настройки", target: { kind: "profile", tab: "settings" } },
      relatedIds: ["controls", "sound-startup"],
    },
    {
      id: "sound-startup", group: "start", title: "Почему заставка иногда без звука?", summary: "Короткий сигнал при входе",
      keywords: "заставка логотип запуск звук тишина интерфейс браузер",
      paragraphs: ["Короткий звук логотипа играет автоматически, если включены звуки игры и браузер разрешает автовоспроизведение. Если браузер блокирует звук или запись ещё не готова, заставка пройдёт тихо - её сигнал не прозвучит позже в меню."],
      note: "Громкость заставки и ежедневного подарка регулируется группой «Интерфейс». Звук получения подарка появляется после подтверждения награды.",
      action: { label: "Открыть настройки", target: { kind: "profile", tab: "settings" } },
      relatedIds: ["sound", "rewards"],
    },
    {
      id: "check-in", group: "start", title: "Чем отметка отличается от тапов?", summary: "Серия дней и серия нажатий",
      keywords: "я живой клик кнопка календарь огонь стрик отметки нажатия рекорд 24 часа ускорение тапы кольцо мощность заряд",
      paragraphs: ["«Я живой» отправляет отметку о том, что вы на связи. Быстрые повторные нажатия - игровые тапы: они поддерживают ускорение одного производства и учитываются в рейтинге. Дополнительные дни серии и монеты за нажатия не начисляются."],
      steps: [
        "Время подтверждённой отметки смотрите рядом с кнопкой. Между отметками должно пройти не больше 24 часов, чтобы сохранить серию дней.",
        `Пауза в ${CLICKER_IDLE_RESET_MS / 1000} секунд завершает серию тапов. Общий счёт и лучший результат сохраняются. Уровень растёт отдельно за опыт развития.`,
        "Каждый тап добавляет секунду помощи, запас до 60 секунд, скорость до +20%. Ускоряется одна работа. Значок с процентом рядом с календарём раскрывает правила. Внутри круга видны отдельные таймеры Мохлика и шахты.",
      ],
      relatedIds: ["level", "saving"],
    },
    {
      id: "level", group: "start", title: "Где уровень и мой прогресс?", summary: "Профиль Мохлика и достижения",
      keywords: "опыт xp рейтинг рекорд статистика уровни подтвержденные тапы",
      steps: [
        "Нажмите уровень слева сверху. «Профиль» показывает XP, дом, вылазки, находки и подарки; рядом «Друзья» и шестерёнка настроек. Состояние открывается по «Как Мохлик?».",
        `Уровень растёт за общий XP: полученные постройки, изготовление и освоение рецептов, добычу, вылазки и выполненные заказы. Всего уровней ${PLAYER_LEVELS.length}. Уровень дома улучшается отдельно за материалы.`,
        `Производство, добыча и вылазки дают 1 XP за ${playerProgressionCatalog.workSecondsPerXp} секунд базовой работы после сбора. Первые рецепты и маршруты дают дополнительный опыт. Тапы ускоряют работу; покупки и отмены XP не дают.`,
        "Игровые достижения за улов, готовку, вылазки и помощь жителям находятся в профиле аккаунта на главном экране. Жемчуг за их ступени нужно забрать кнопкой.",
      ],
      action: { label: "Открыть профиль", target: { kind: "profile", tab: "profile" } },
      relatedIds: ["check-in", "rewards", "construction"],
    },
    {
      id: "resources", group: "economy", title: "Где запасы и как получить монеты?", summary: "Кладовая, продажа и заказы",
      keywords: "ресурсы где взять найти добыть деньги валюта заработать фарм нет монет не хватает закончилось древесина дерево камень продать",
      steps: [
        "Откройте «Кладовая» внизу карты. «Запасы» разделены на материалы, изделия, ягоды и наживку. В «Холодильнике» рыба, блюда, напитки, десерты и припасы для вылазок; «Реликвии» - особые материалы.",
        `Продайте ненужное: товары первых двух этапов имеют фиксированную цену торговца, остальные продаются за ${(economyCatalog.localBuyer?.payoutBps ?? 10_000) / 100}% базовой цены. Плёска платит полную цену класса рыбы. Сумма видна до продажи.`,
        "В «Холодильнике» нажмите класс рыбы, чтобы раскрыть виды. Тап по виду открывает его продажу, повторный добавляет 1. Другой вид меняется в том же окне. Еда стоит отдельно; только кнопка продажи тратит запас.",
        "Выполняйте заказы жителей за монеты. Если запасы пусты, начните бесплатный урожай ягод или лесную разведку.",
      ],
      note: "Перед продажей проверьте нужное для улучшения. «Только излишек» сохраняет материалы закреплённой цели. Крестик, Escape или нажатие вне окна закроют его без продажи и вернут к карточке.",
      action: { label: "Открыть кладовую", target: { kind: "pantry" } },
      relatedIds: ["item-rarity", "fish-selection", "resident-orders", "construction-goal", "market", "legacy-resources"],
    },
    {
      id: "item-rarity", group: "economy", title: "Что означают цвета предметов?", summary: "Пять цветов редкости",
      keywords: "цвет карточка редкость обычная необычная редкая эпическая легендарная бежевый зеленый голубой фиолетовый золотой",
      paragraphs: ["Обычная редкость - бежевая карточка, необычная - зелёная, редкая - голубая, эпическая - фиолетовая, легендарная - золотая. У рыб и рыбных блюд цвет соответствует классу рыбы. Название редкости есть в подсказке предмета и доступно экранному диктору; выбранную карточку выделяет обводка. Цену продажи смотрите после нажатия на предмет."],
      action: { label: "Открыть кладовую", target: { kind: "pantry" } },
      relatedIds: ["resources", "fish-selection", "relics"],
    },
    {
      id: "storage", group: "economy", title: "Не хватает места - что делать?", summary: "Освободить кладовую и забрать готовое",
      keywords: "полная переполнена мало склад вместимость лимит не помещается нельзя забрать награду урожай добычу места",
      steps: [
        "Откройте кладовую: счётчик учитывает все запасы и товары, выставленные на рынок. Отмена лота не освобождает место.",
        "Продайте излишки, приготовьте блюдо или выполните заказ жителей, затем снова заберите готовый результат.",
        "Для расширения нажмите улучшение в шапке кладовой. Стоимость и новая вместимость видны заранее; понадобится свободный строитель.",
      ],
      note: `Первый уровень кладовой - ${storageLevels[0]?.warehouseCapacity ?? 50} мест; каждый следующий добавляет 50, уровень ${storageLevels.at(-1)?.level ?? 15} - ${storageLevels.at(-1)?.warehouseCapacity ?? 750}. До уровня ${(firstRelicStorageLevel ?? 11) - 1} нужны материалы и монеты, дальше - только реликвии. Одна вещь занимает одно место. Готовые работы не пропадут; сохранённый излишек не удаляется. Расширение удобно для запасов, но улучшение дома не требует уровня кладовой.`,
      action: { label: "Освободить место", target: { kind: "pantry" } },
      relatedIds: ["storage-upgrades", "resources", "construction", "relics"],
    },
    {
      id: "storage-upgrades", group: "economy", title: "Как расширяется кладовая?", summary: "15 уровней, материалы и равные наборы реликвий",
      keywords: "кладовая склад расширение улучшить дом уровень реликвии вместимость ядро кристалл смола",
      steps: [
        "У кладовой своя шкала уровней. Каждое улучшение добавляет 50 мест; улучшать дом после каждого расширения не нужно.",
        `Доступная вместимость по уровню дома: ${[1, 2, 3, 4, 5].map(home => `дом ${home} до ${Math.max(...storageLevels.filter(level => level.requiredHomeLevel <= home).map(level => level.warehouseCapacity ?? 0))} мест`).join("; ")}. Это предел доступа, сами улучшения оплачиваются отдельно.`,
        "До уровня 10 нужны монеты и обычные материалы. Каждый из уровней 11-15 стоит одно древнее ядро, один лунный кристалл и одну живую смолу. Дополнительные монеты не нужны.",
        "Нажмите улучшение в шапке кладовой, подготовьте стоимость и освободите строителя. После таймера получите расширение. Уровень кладовой не является условием улучшения дома.",
      ],
      action: { label: "Расширить кладовую", target: { kind: "upgrade", stationId: "warehouse" } },
      relatedIds: ["storage", "relics", "construction"],
    },
    {
      id: "production", group: "economy", title: "Как сделать предмет?", summary: "Предмет, состав и получение результата",
      keywords: "крафт изготовить где взять найти не хватает доски веревка верёвка мастерская верстак печь лесной участок производство рецепты партии очередь закрыто недоступно",
      steps: [
        "Откройте здание: видны время и материалы, нехватка выделена рядом с количеством. У закрытого продукта указан нужный уровень постройки.",
        "При запуске монеты и материалы зарезервируются. В книге костра сначала откроется рецепт: нажмите «Приготовить», для рыбного блюда проверьте виды и подтвердите «Готовить». Работа начинается после подтверждения сервера.",
        "Нажмите занятую ячейку: появятся «Удалить?» и таймер 5 секунд. Второе нажатие за это время отменит работу и вернёт монеты и материалы, если есть место. Без второго нажатия работа продолжится.",
        "После таймера нажмите «Забрать» или «Собрать всё» для нескольких готовых мест. Одно место даёт один предмет и занято до получения.",
      ],
      note: "Для двух предметов нужны два запуска. Отмена рыбной готовки возвращает выбранные виды. Таймер меняется по секундам: 4:30 или 1:02:03. При улучшении производство недоступно.",
      action: { label: "В мастерскую", target: { kind: "station", stationId: "workshop" } },
      relatedIds: ["production-slots", "storage", "recipe-unlocks", "campfire", "fish-selection"],
    },
    {
      id: "production-slots", group: "economy", title: "Почему нельзя начать ещё одну работу?", summary: "Свободные места производства",
      keywords: "слоты очередь место занято параллельно несколько заказов производство жемчуг",
      steps: [
        "Сначала видны два места; третье появляется с завершённым домом 3. Ранее купленное третье место сохраняется. В занятом месте показаны предмет и время; готовая работа занимает его до получения. У следующего закрытого места видна цена. Третье до покупки второго показывает только замок.",
        "Сначала заберите готовую работу: до получения она занимает место. Если работа ещё идёт, дождитесь её или выберите другое производство.",
        `Дополнительные места покупаются отдельно для каждого производства: ${economyCatalog.productionSlots.upgrades.map(upgrade => `${upgrade.slots}-е - за ${formatPearls(upgrade.pricePearls)} жемчужин с дома ${upgrade.requiredHomeLevel}`).join("; ")}.`,
      ],
      note: "Закрытое место открывается после подтверждения покупки: второе, затем третье. Первое бесплатно; автозапуска нет. Если у мастерской заняты обе очереди, на карте в общей плашке видны «Верстак» и «Печь»; нажатие строки откроет нужное производство. В шахте всегда одно место, без платных мест; Мохлик остаётся свободен.",
      relatedIds: ["production", "mining", "journeys", "rewards"],
    },
    {
      id: "construction", group: "economy", title: "Как построить или улучшить здание?", summary: "Материалы, строитель и завершение",
      keywords: "стройка строительство дом строитель шишколап ёжик занят улучшить уровень таймер закончить готово",
      steps: [
        "Нажмите здание → «Улучшить». Дом сразу открывает улучшение. В блоке «После улучшения» раскройте интересующий раздел. Число у замка показывает, сколько рецептов ещё предстоит узнать. Кладовая расширяется из меню запасов.",
        "Проверьте стоимость и требования. Нужен свободный Шишколап: одновременно строится одно здание.",
        "После таймера подтвердите завершение. Только тогда применится новый уровень и строитель освободится.",
        "На максимальном уровне дома можно посмотреть шуточные титры. Лесная жизнь после них продолжается.",
      ],
      note: `Новый дом 2 требует лесной участок, костёр, мастерскую, один учебный заказ и ${firstStageOrders.length} просьбы этапа. Дом 3 требует шахту уровня 2, печь и ${secondStageOrders.length} постоянных просьб. Дом 4 требует завершить проект полянки. Расширять кладовую необязательно. Таймер кладовой - над домом, печи - над мастерской, заготовок - над костром. При открытом меню он скрывается.`,
      action: { label: "К улучшению дома", target: { kind: "upgrade", stationId: "home" } },
      relatedIds: ["construction-goal", "builder-food", "pearls", "second-house-stage"],
    },
    ...(firstWorkshop ? [{
      id: "workshop-starter", group: "start", title: "Есть ли отдельный стартовый набор?", summary: "Одноразовая помощь для первой мастерской",
      keywords: "обучение новичок стартовый набор первая мастерская подарок бонус дерево древесина камень монеты построить шишколап",
      paragraphs: [`Учебная помощь покрывает первую мастерскую: ${firstWorkshop.cost.coins.toLocaleString("ru-RU")} монет; ${Object.entries(firstWorkshop.cost.items).map(([id, amount]) => `${itemName(id)} × ${amount}`).join(", ")}. Собственные монеты и материалы не расходуются.`],
      steps: [
        "Откройте обучение через «?» рядом с шестерёнкой профиля Мохлика. На шаге «Мастерская» проверьте условия и сами запустите учебную стройку. Шишколап должен быть свободен.",
        "Помощь сразу оплачивает стройку: деньги и материалы не попадают в кладовую, потратить их на другой дом нельзя.",
        `Обычный срок по каталогу - ${firstWorkshop.seconds / 60} мин; итоговое время с бонусами показано перед запуском. После завершения получите мастерскую и изготавливайте доски.`,
      ],
      note: "Помощь даётся один раз. Прежний набор, готовая или строящаяся мастерская исключают повтор. Отмена учебной стройки не возвращает помощь в запасы. Обычная стройка оплачивается отдельно.",
      action: { label: "К плану мастерской", target: { kind: "upgrade", stationId: "workshop" } },
      relatedIds: ["construction", "storage", "saving"],
    }] satisfies WorldHelpTopic[] : []),
    {
      id: "construction-goal", group: "economy", title: "Как не продать нужные материалы?", summary: "Закрепить цель улучшения",
      keywords: "закрепить закреп булавка цель не хватает материалов сырье излишек сохранить ресурсы",
      steps: [
        "Откройте нужное улучшение и закрепите его. На карте останется маленький значок закрепа - он возвращает к цели.",
        "Нажимайте недостающие материалы, чтобы перейти к рецептам или вылазкам.",
        "В кладовой выберите «Только излишек». Игра оставит материалы для цели и сырьё для недостающих изделий.",
      ],
      note: "Можно закрепить одну цель. Она хранится в этом браузере и снимается при начале выбранной стройки. Ручная продажа всё ещё может потратить нужное.",
      action: { label: "Выбрать улучшение дома", target: { kind: "upgrade", stationId: "home" } },
      relatedIds: ["production", "resources"],
    },
    {
      id: "pearls", group: "economy", title: "Как ускорить стройку за жемчуг?", summary: "Платное завершение или бесплатное ожидание",
      keywords: "ускорение ускорить жемчужина жемчужины мгновенно цена стоимость завершить сейчас",
      steps: [
        "Нажмите таймер стройки или откройте строящееся здание → «Завершить сейчас».",
        `Одна жемчужина оплачивает до пяти минут оставшейся стройки. Примеры: ${[["5 мин", 300], ["1 ч", 3600], ["24 ч", 86400], ["48 ч", 172800]].map(([label, seconds]) => `${label} - ${formatPearls(constructionTimePearlPrice(Number(seconds)))} жемчужин`).join("; ")}. Общая цена округляется вверх один раз, до целой жемчужины.`,
        "Подтвердите. Если цена успела снизиться, спишется меньшая сумма; готовая стройка завершается бесплатно.",
      ],
      note: "Это ускоряет только стройку. Без жемчуга дождитесь таймера и подтвердите завершение. Еда строителю тоже помогает. Интервал между проектными поставками за жемчуг не сокращается.",
      action: { label: "К строителю", target: { kind: "resident", residentId: "builder" } },
      relatedIds: ["builder-food", "rewards", "currency-shop"],
    },
    {
      id: "market", group: "economy", title: "Как торговать с игроками?", summary: "Покупки, продажа и сбор выручки",
      keywords: "объявления рынок торговля купить продать цена комиссия покупка продажа игрок лот обновить витрина",
      steps: [
        `С дома ${economyCatalog.market.requiredHomeLevel} восстановите мост и получите готовую стройку. Вместе с мостом закрытый рынок откроется. Нажмите его на карте: сразу откроется «Моя лавка». Вылазка для открытия не нужна.`,
        `«Моя лавка» → «Новая партия»: выберите товар, количество и цену всего лота. Для рыбы проверьте виды и нажмите «Выставить лот». Комиссия ${economyCatalog.market.feeBps / 100}% видна заранее. Свой лот купить нельзя.`,
        "Плашка «Продано» над рынком ведёт к покупателю и выручке. Нажмите «Забрать монеты» на карточке: монеты поступят в кошелёк, место прилавка освободится. Непроданный лот можно снять.",
        "Покупки - в «Купить» или в лавке друга через «Друзья» → «В гости». Обмен реликвий вынесен в отдельный раздел «Обмен».",
      ],
      note: `Витрина меняется раз в ${economyCatalog.market.showcaseRefreshSeconds / 60} минут. Рынок общий для домов 2–5. Покупать можно открытые товары: одного уровня дома недостаточно. Право на открытый товар сохраняется. Дневной объём торговли зависит от дома; остаток лимита виден в рынке.`,
      relatedIds: ["friend-profile", "fish-selection", "market-slots", "item-unlocks", "storage", "relics"],
    },
    {
      id: "market-slots", group: "economy", title: "Как выставить больше лотов?", summary: "Постоянные места продавца",
      keywords: "рынок лоты объявления слоты продавец витрина больше расширить места жемчуг",
      steps: [
        `На рынке откройте «Моя лавка» → «Места лавки». Бесплатно доступны ${economyCatalog.market.baseSlots} мест продавца; максимум - ${economyCatalog.market.maxListings}.`,
        `Дополнительные места покупаются по очереди: ${economyCatalog.market.slotPricesPearls.map((price, index) => `${economyCatalog.market.baseSlots + index + 1}-е - ${formatPearls(price)} жемчужин`).join("; ")}. Цена показана перед подтверждением.`,
        "Полученное место остаётся навсегда. Оно освобождается после снятия непроданного лота или сбора монет за проданный.",
      ],
      note: "Места продавца не увеличивают кладовую и не меняют общую витрину покупателей. Товары в активных лотах продолжают занимать место в кладовой.",
      relatedIds: ["market", "storage", "currency-shop"],
    },
    {
      id: "item-unlocks", group: "economy", title: "Что значит открыть товар?", summary: "Доступ сохраняется после открытия",
      keywords: "открытый товар предмет доступ закрыто рецепт купить источник постоянное открытие",
      steps: [
        "Откройте источник товара: нужное оборудование, рецепт или маршрут с его условиями. Один уровень дома не заменяет остальные требования.",
        "Некоторые рецепты открываются за занятия: лесные маршруты, береговые находки и собственный улов. Для торгового ящика завершите две лесные разведки и поход в старый лес. Условия и счётчики видны у рецепта.",
        "Открытый товар остаётся доступным для покупок на рынке и обычных просьб жителей, даже если вы продали весь запас или источник позже недоступен.",
      ],
      note: "Подаренный или купленный продвинутый предмет сам по себе не открывает его источник. Условия нового открытия можно посмотреть у рецепта или недостающего товара.",
      relatedIds: ["production", "market", "resident-orders"],
    },
    {
      id: "relics", group: "economy", title: "Где взять реликвии для улучшений?", summary: "Редкие материалы и обмен",
      keywords: "реликвии древнее ядро лунный кристалл живая смола редкие особые материалы обмен склад расширение",
      steps: [
        `С дома ${economyCatalog.rareDrops!.requiredHomeLevel} получайте результаты вылазок. ${economyCatalog.rareDrops!.itemIds.map(itemName).join(", ")} появляются через ${economyCatalog.rareDrops!.minSeconds / 3600}-${economyCatalog.rareDrops!.maxSeconds / 3600} часов накопленного времени завершённых и полученных вылазок.`,
        "Проект дома 4 гарантирует живую смолу, проект дома 5 даёт древнее ядро и лунный кристалл. Седьмой подарок за вход тоже даёт ядро. Дом можно улучшить без случайной находки.",
        "С полученного дома 4 у Листохвоста в «Реликвиях» обменяйте две одинаковые лишние находки и 20 000 монет на одну выбранную другую. Предметы и цена видны до подтверждения.",
        `С дома ${BARTER_HOME_LEVEL} и после восстановления моста откройте на рынке «Обмен»: реликвия за реликвию. Один успешный обмен за сутки UTC учитывается у обоих игроков.`,
      ],
      note: `Реликвии занимают место. Кладовая до уровня ${(firstRelicStorageLevel ?? 11) - 1} расширяется за материалы и монеты; каждый уровень ${firstRelicStorageLevel ?? 11}-${storageLevels.at(-1)?.level ?? 15} стоит по одной реликвии каждого вида. Отмена и ожидание после таймера не приближают находку.`,
      action: { label: "Посмотреть запасы", target: { kind: "pantry" } },
      relatedIds: ["journeys", "rewards", "storage", ...(economyCatalog.leaftailShop ? ["leaftail-shop"] : [])],
    },
    ...(economyCatalog.leaftailShop ? [{
      id: "leaftail-shop", group: "economy" as const, title: "Что продаёт Листохвост?", summary: "Сменяемая поставка и реликвии за жемчуг",
      keywords: "листохвост лавка торговец одежда шляпа платок мох удочка крючок наживка снасти находки реликвии покупка монеты жемчуг поставка остаток сутки",
      steps: [
        `Откройте домик Листохвоста или «Ещё» → «Персонажи» → «Листохвост». Он возвращается с дома ${economyCatalog.leaftailShop.requiredHomeLevel}; дождитесь знакомства на реке. До его прибытия палатка заброшена, после знакомства открывается лавка.`,
        "В «Одежде» две вещи, в «Снастях» по одной удочке, крючку и наживке. Одежду примерьте; купленное ищите в «Гардеробе» → «Мои вещи».",
        "В «Припасах» три вида товаров: выберите количество поштучно, проверьте полную цену и подтвердите покупку. Одежда, удочки и крючки остаются навсегда без повторной оплаты.",
        `В «Реликвиях» один или два вида по ${formatPearls(economyCatalog.leaftailShop.pearlOffers?.[0]?.pricePearls ?? 300)} жемчужин за штуку. Реликвии, припасы и наживка требуют места в кладовой. Выбор личный, повторное открытие и покупка его не меняют. Полоса показывает срок поставки.`,
      ],
      note: "«Шансы улова» раскрываются нажатием. Сумеречные снасти - с дома 4. Одежда меняет только внешность; мост для лавки не требуется.", relatedIds: ["wardrobe", "fishing", "relics", "storage"],
    }] : []),
    {
      id: "currency-shop", group: "economy", title: "Где получить жемчуг?", summary: "Подарки, достижения и большие поручения",
      keywords: "магазин жемчуг жемчужины золото монеты обмен донат реальные деньги купить витрина промокод код подарок",
      steps: [
        `Подарки в профиле Мохлика: новая цепочка из семи подарков даёт ${formatPearls(dailyPearls)} жемчужин один раз на аккаунт. Ранее начатая сохраняет свои суммы; после седьмого нового круга нет.`,
        `Достижения в профиле дают новому аккаунту ${formatPearls(Object.values(progressionRewardsCatalog.achievementPearls).flat().reduce((sum, amount) => sum + amount, 0))} жемчужин однократно, по мере развития. Старым сохраняются обещанные суммы. Подсветка профиля означает готовую награду.`,
        "Большие поручения повторяются: обычное даёт 20, сложное 40, мастерское 70 жемчужин. Новый выбор доступен через семь суток после принятия предыдущего.",
        "«Ещё» → «Магазин» открывает наборы. «+» рядом с монетами открывает «Золото», рядом с жемчугом - «Жемчуг». Для промокода внизу магазина нажмите «Ввести промокод»; код действует один раз на аккаунт.",
      ],
      note: "Для подарка с предметами понадобится место в кладовой. Во вкладке «Золото» можно обменять накопленный жемчуг на монеты. Покупки за реальные деньги пока недоступны.",
      action: { label: "К профилю и подаркам", target: { kind: "profile", tab: "profile" } },
      relatedIds: ["rewards", "pearls", "currency-shop-starters", "currency-shop-costumes", "currency-shop-exchange"],
    },
    {
      id: "currency-shop-starters", group: "economy", title: "Как меняется стартовый набор?", summary: "Свой набор для каждого уровня дома",
      keywords: "стартер стартовый пакет набор дом уровень блюдо буст припасы донат магазин цена рубли",
      paragraphs: ["Откройте «Ещё» → «Магазин» → «Наборы». Показан один набор для текущего завершённого уровня дома: жемчуг, монеты, материалы и блюда с ускорением."],
      steps: [
        `Дом ${storefrontCatalog.starterPacks.map(pack => pack.homeLevel).join(" / ")}: ${storefrontCatalog.starterPacks.map(pack => `${pack.priceRub} ₽`).join(" / ")}. Состав виден до покупки.`,
        "После получения нового уровня дома появляется другой набор. Прошлый набор не заменяет его, не улучшается бесплатно и больше не предлагается.",
        "Каждый набор рассчитан на одну покупку на аккаунт для своего уровня. Он не открывает рецепты, не завершает постройки и не пропускает проектные поставки.",
      ],
      note: "Пока это предпросмотр: оплатить набор или получить его содержимое нельзя.",
      relatedIds: ["currency-shop", "food", "construction", "currency-shop-costumes"],
    },
    {
      id: "currency-shop-costumes", group: "mochlik", title: "Что дают особые костюмы?", summary: "Новый образ без прибавки к силе",
      keywords: "донат костюм комплект образ одежда эксклюзивный уникальный звездочёт хранитель огня первопроходец магазин рубли",
      paragraphs: ["В «Ещё» → «Магазин» → «Костюмы» можно примерить полный образ на Мохлике. Примерка не меняет сохранённую одежду."],
      steps: [
        storefrontCatalog.costumeOffers.map(offer => `«${offer.name}» - ${offer.priceRub} ₽`).join("; ") + ".",
        "Костюмы меняют только внешность, без бонусов к добыче, скорости или строительству. Это отдельные образы, их нет в обычной поставке Листохвоста.",
      ],
      note: "Платежи ещё не подключены: примерка доступна, покупка и выдача костюма пока недоступны.",
      relatedIds: ["wardrobe", "currency-shop-starters", "currency-shop"],
    },
    {
      id: "currency-shop-exchange", group: "economy", title: "Как обменять жемчуг на золото?", summary: "Пакеты монет с бонусом за объём",
      keywords: "магазин обмен золото монеты курс бонус дом производства постройки жемчуг пакет витрина",
      paragraphs: [`Доступные пакеты: ${GOLD_SHOP_PACKAGES.map(pack => `${formatPearls(pack.pearls)} жемчужин → ${pack.coins.toLocaleString("ru-RU")} монет`).join("; ")}. Бонус большого пакета уже включён в показанную сумму.`],
      steps: [
        "Нажмите «+» рядом с монетами, выберите пакет во вкладке «Золото» и подтвердите обмен.",
        "Жемчуг списывается, монеты приходят сразу после подтверждения сервером. Обратного обмена нет.",
        "Уровень дома и постройки не меняют состав пакетов. При потере связи проверьте результат прежнего обмена, прежде чем начинать новый.",
      ],
      note: "Покупки за реальные деньги не подключены. Монеты также можно заработать продажей товаров и заказами без жемчуга.",
      relatedIds: ["currency-shop", "production-slots", "resident-orders"],
    },
    {
      id: "legacy-resources", group: "economy", title: "Куда пропали прежние искры?", summary: "Перенос старого прогресса",
      keywords: "искры sparks лимит миграция старые запасы прежние пересчет перенос",
      paragraphs: ["Старые искры и материалы один раз перенесены в новую экономику: до 5000 монет, 30 древесины и 30 камня. Полученные здания, одежда и коллекции сохранены. Общий уровень теперь растёт за опыт развития; тапы поддерживают временное ускорение. Монеты приходят от продажи и заказов."],
      relatedIds: ["resources", "check-in"],
    },
    {
      id: "journeys", group: "travel", title: "Как отправиться в вылазку?", summary: "Лесные припасы и рыбалка",
      keywords: "в путь путешествия прогулка исследование поход экспедиция маршрут сектор офлайн припасы отменить отозвать мохлик занят",
      steps: [
        releaseFeatures.boatFishingEnabled ? "В меню «В путь» выберите «За припасами» или «Лодочная рыбалка». Карточка лодки открывает мастерскую или текущий выход." : "В меню «В путь» выберите «За припасами» или «На рыбалку».",
        "Необязательный обед выбирается в блоке «Ускорение едой» под таймером. «Выбрать блюдо» покажет бонус и новое время; открытие ничего не тратит.",
        "Отправьте Мохлика. Он выполняет одну вылазку или собирает ягоды; производства работают независимо.",
        "За припасами: до отправления видны диапазоны добычи и шансы особых находок. У каждого маршрута свой набор; снаряжение открывает более редкие находки. После получения появится отчёт о том, что Мохлик принёс. Таймер идёт и с закрытой игрой.",
      ],
      note: "XP начисляется при получении результата: за базовое время маршрута и первое прохождение. Отзыв не даёт XP и теряет добычу; припасы, наживка и потраченная часть обеда не возвращаются. Старые походы доступны в «Ещё» → «Старые походы».",
      action: { label: "Выбрать вылазку", target: { kind: "expeditions" } },
      relatedIds: ["journey-finds", "journey-actions", "mining", "fishing", "food", "storage"],
    },
    {
      id: "journey-finds", group: "travel", title: "Какие находки бывают в вылазках?", summary: "Все варианты и шансы до отправления",
      keywords: "вылазки находки древние руины линза бутылка кварц наживка желе шанс тайник",
      steps: [
        "В карточке маршрута показаны диапазоны основной добычи. Раскройте находки, чтобы увидеть все варианты и их шансы. За одну вылазку может выпасть одна дополнительная находка или ничего из этого списка.",
        `В Древних руинах возможны стеклянная бутылка (${findChance("ancient_ruins", "glass_bottle")}%), кварц (${findChance("ancient_ruins", "quartz")}%) или линза (${findChance("ancient_ruins", "lens")}%). Они не выпадают все вместе.`,
        `В лесной разведке можно найти ${itemName("worm_bait")} ×3 (${findChance("forest", "worm_bait")}%), а в Роще за рекой ${itemName("currant_jelly")} (${findChance("far_bank_grove", "currant_jelly")}%). Наживку используйте на рыбалке, желе можно съесть или пустить в готовку. Находка еды не считается приготовленным рецептом.`,
      ],
      note: "Реликвии используют отдельный счётчик полученного времени вылазок. У них нет постоянного процента на каждый поход. Фактическая добыча раскрывается после получения результата.",
      action: { label: "Посмотреть маршруты", target: { kind: "expeditions" } },
      relatedIds: ["journeys", "relics", "fishing", "food"],
    },
    {
      id: "journey-actions", group: "travel", title: "Что Мохлик делает в вылазке?", summary: "Корзина, лопата и дальние тропы",
      keywords: "вылазка поход старый лес корзина лопата прибрежные отложения далеко ушёл возвращается рюкзак портфель",
      steps: [
        "В лес и старый лес Мохлик берёт корзину с поляны. Он поднимает её, несёт к месту сбора и после вылазки возвращает обратно.",
        "В «Прибрежных отложениях» он работает у воды: копает лопатой, поднимает грунт и перебирает находки.",
        "В дальнюю вылазку Мохлик надевает рюкзак и уходит за край карты. Он возвращается после завершения или отзыва и снимает рюкзак на поляне. Результат забирайте в «В путь».",
      ],
      note: "Добыча и время зависят от выбранного маршрута. Анимация показывает занятие; таймер продолжает идти с закрытой игрой.",
      relatedIds: ["journeys", "berry-garden", "fishing"],
    },
    {
      id: "forest-villagers", group: "start", title: "Кто живёт в лесу?", summary: "Пять соседей и условия их прихода",
      keywords: "персонажи жители лопоух зайчик заяц древесина лесоруб камнешмыг шахтер шахтёр листохвост торговец знакомство",
      steps: [
        "Шишколап строит здания, Плёска помогает с рыбалкой. После обустройства лесного участка и подтверждения у Шишколапа справа прибежит Лопоух. Поговорить с ним можно через «Ещё» → «Персонажи».",
        "Обустройство начинается на закрытом лесном участке. Затем у домика Лопоуха заказывайте брёвна, волокно и другие открытые материалы. Улучшения сохраняются; с третьего уровня меняется вид дома.",
        "Камнешмыг придёт после подтверждения построенной каменоломни. Во время добычи он работает в пещере, а между сменами гуляет.",
        `Листохвост пока путешествует и возвращается на лодке после получения дома ${economyCatalog.leaftailShop?.requiredHomeLevel ?? 3}. Дождитесь знакомства на реке; затем лавка доступна через домик и «Персонажи», даже когда он внутри.`,
      ],
      note: "В «Персонажах» у знакомых жителей показаны ранг дружбы, шкала до следующего ранга и текущий бонус. Дружба растёт за выполненные просьбы; разговоры и прогулки сами по себе её не увеличивают.",
      relatedIds: ["mining", "construction", ...(economyCatalog.leaftailShop ? ["leaftail-shop"] : [])],
    },
    {
      id: "mining", group: "travel", title: "Как работает добыча в шахте?", summary: "Карточки ресурсов и одно место добычи",
      keywords: "шахта каменоломня руда камень глина песок пещера добыча добыть кирка каска смена вход закрыт шахтёр независимо очередь слот место фильтр время длительность",
      steps: [
        "С дома 2 постройте шахту. Камни для постройки есть в бесплатной лесной вылазке. После подтверждения постройки с северной тропы придёт шахтёр Камнешмыг. Нажмите шахту, чтобы открыть добычу.",
        `Выберите ресурс и количество. Предел по уровням шахты: ${miningBatchCatalog.maxUnitsByQuarryLevel.join(" / ")} единиц, но не больше ${miningBatchCatalog.maxBaseSeconds / 60} минут базовой работы. Для долгих ресурсов партия меньше. Бонусы сокращают время, не увеличивая лимит.`,
        "Во время добычи показана только текущая работа: сколько готово, получено и осталось, время следующей единицы и всей партии. Забирайте доступную часть сразу: остальная продолжает добываться, даже с закрытой игрой. Мохлик свободен.",
      ],
      note: "Камень и глина: одна штука за три минуты до бонусов. Одна бесплатная очередь; после завершения всей партии следующую запускаете сами. Обед Мохлика не действует на шахтёра; помощь тапами может ускорить его работу.",
      action: { label: "Открыть шахту", target: { kind: "station", stationId: "quarry" } },
      relatedIds: ["mining-control", "storage", "construction", "journeys", "second-house-stage"],
    },
    {
      id: "mining-control", group: "travel", title: "Как отменить добычу или забрать результат?", summary: "Подтверждение отмены и полная кладовая",
      keywords: "шахта каменоломня отменить добычу остановить прервать забрать результат находки полная кладовая место 1",
      steps: [
        "Нажмите «Остановить остаток», затем подтвердите «Остановить»: недобытая часть партии отменится, уже готовая останется на месте до получения. Это можно сделать и при полной кладовой.",
        "Чтобы сохранить работу, выберите «Назад». Первое нажатие само по себе ничего не отменяет.",
        "«Забрать 1» переносит одну готовую единицу. «Всё» забирает столько готовой добычи, сколько помещается. Остаток сохранится, а добыча продолжится. Следующую партию можно начать после получения всей предыдущей.",
      ],
      note: "Готовая добыча не пропадает при остановке партии. Старые походы Мохлика показаны отдельно: их отмена не возвращает потраченные припасы.",
      action: { label: "Открыть шахту", target: { kind: "station", stationId: "quarry" } },
      relatedIds: ["mining", "storage", "production-slots"],
    },
    {
      id: "fishing", group: "travel", title: "Как поймать редкую рыбу?", summary: "Пять классов и шансы снастей",
      keywords: "рыбалка поймать улов вероятность шанс шансы редкая эпическая легендарная акула наживка удочка крючок",
      steps: [
        releaseFeatures.boatFishingEnabled ? "Откройте «В путь» → «Лодочная рыбалка». В «Снастях» три ячейки: удочка, крючок, наживка. Тап по снасти выбирает её, без покупки и отправления. Без наживки тоже можно ловить." : "Откройте «В путь» → «На рыбалку» и выберите снасти у маршрута.",
        "В «Шансах улова» проверьте пять классов набора. Каждая рыба получает класс, затем вид по предпочтениям удочки и крючка. «Какая рыба клюнет» покажет рисунки и проценты видов; шанс класса от предпочтений не меняется.",
        `Звёздная удочка + Крючок Левиафана + Звёздная наживка дают ${(legendaryChance * 100).toFixed(2).replace(".", ",")}% на легендарный класс для каждой пойманной рыбы. Его открывает легендарная удочка; крючок и наживка усиливают шанс.`,
      ],
      note: "Класс определяет цену и применение в рецептах и заказах. Вид открывается в коллекции. Если удочка не ловит класс наживки, выбрать её нельзя. При смене удочки неподходящая наживка снимается и остаётся в кладовой. Одна порция выбранной наживки расходуется при отправлении.",
      action: { label: "К рыбалке", target: fishingTarget },
      relatedIds: ["boat-fishing", "plesk", "collection", "campfire"],
    },
    ...(releaseFeatures.boatFishingEnabled ? [
    {
      id: "boat-fishing", group: "travel", title: "Как выйти на рыбалку в лодке?", summary: "Первый выход, топливо и получение улова",
      keywords: "лодка лодочная рыбалка починить ремонт причал плыть река забрать улов мохлик занят вернуться",
      steps: [
        `Откройте «В путь» → «Лодочная рыбалка». С дома ${boatRepair.requiredHomeLevel} можно бесплатно починить корпус. Через ${boatRepair.seconds} с заберите работу в мастерской.`,
        "Выберите снасти у причала. Выход расходует одну ячейку бензина и переносит вас на реку. Одна порция выбранной наживки действует всю поездку.",
        "После рыбалки вернитесь в мастерскую и нажмите «Забрать улов». После разгрузки можно сразу снаряжать лодку. При полной кладовой освободите место, улов останется на борту.",
      ],
      note: "Мохлик занят до получения улова. Бензин нужен только для следующего выхода. Вернуться к начатой поездке можно через ту же карточку.",
      action: { label: "К лодочной рыбалке", target: { kind: "boat" } },
      relatedIds: ["boat-controls", "boat-upgrades", "boat-records", "storage"],
    },
    {
      id: "boat-controls", group: "travel", title: "Как вываживать рыбу и не потерять заброс?", summary: "Удерживание, пауза и число попыток",
      keywords: "лодка мини игра миниигра вываживание заброс рыба сорвалась зажать пробел пауза перезагрузка таймер",
      steps: [
        "Нажмите «Забросить удочку». Через 4–7 секунд начнётся вываживание. Держите метку рыбы в зелёной зоне: зажмите кнопку или пробел, чтобы поднять зону, отпустите, чтобы опустить. Когда шкала заполнится, Мохлик сам вытянет рыбу.",
        `На старте можно привезти до ${boat.moduleEffects.storage[0]} рыб за ${boat.moduleEffects.storage[0] + boat.spareCasts} забросов. Попытка тратится при забросе. Сход оставляет место в хранилище свободным; его улучшение увеличивает оба лимита.`,
        `Пауза останавливает управление. Срок поклёвки составляет ${boat.castExpirySeconds / 60} мин. Нажатия обрабатываются на устройстве. Вид и вес появятся после ответа сервера.`,
      ],
      note: "Вернуться с уловом можно в любой момент. При раннем возвращении текущая поклёвка и оставшиеся попытки заканчиваются.",
      action: { label: "К лодке", target: { kind: "boat" } },
      relatedIds: ["boat-reeling", "boat-fishing", "boat-upgrades"],
    },
    {
      id: "boat-reeling", group: "travel", title: "Как удерживать рыбу в зелёной зоне?", summary: "Инерция, сопротивление и сигналы шкалы",
      keywords: "лодка вываживание зелёная зона инерция рывок сопротивление подсказки удерживать короткие нажатия",
      steps: [
        "Зелёная зона набирает инерцию и слегка отскакивает от дна при быстром падении. Короткие нажатия помогают удерживать высоту. Поплавок остаётся на воде; управляйте зоной вертикальной шкалы.",
        "Плавная, юркая, рывковая и упорная рыба сопротивляются по-разному; редкую сложнее удержать. Перед рывком есть подготовка, после него передышка.",
        "Подсказки описывают настоящий темп движения и показывают, когда поднять или опустить снасть. Янтарный сигнал означает потерю зоны, красный предупреждает о риске срыва.",
        "Первый заброс сопровождается коротким уроком. Кнопка «Подсказки» повторяет его.",
      ],
      action: { label: "К лодке", target: { kind: "boat" } },
      relatedIds: ["boat-controls", "boat-records"],
    },
    {
      id: "boat-upgrades", group: "travel", title: "Как выбрать улучшение и пополнить бак?", summary: "Двигатель, бак, корпус и хранилище",
      keywords: "лодка улучшить хранилище трюм бак бензин топливо двигатель корпус строитель ремонт жемчуг",
      steps: [
        "Двигатель меняет отклик снасти, а корпус смягчает рывки рыбы. Хранилище увеличивает предел улова и число забросов на выход. Бак позволяет накопить больше бензина в перерыве.",
        "Выберите узел у причала. Мастерская покажет установленную деталь, эффект следующего уровня, цену в монетах, материалы и время. По окончании работы заберите улучшение.",
        `В баке на старте ${boat.fuel.baseCapacity} ячейки. Одна восстанавливается за ${boat.fuel.regenSeconds / 60} минут, в том числе при закрытой игре. При пустом баке можно купить одну ячейку у причала за ${formatPearls(boat.fuel.refillPricePearls)} жемчужин.`,
      ],
      action: { label: "К лодке", target: { kind: "boat" } },
      relatedIds: ["boat-fishing", "construction"],
    },
    {
      id: "boat-records", group: "travel", title: "От чего зависит вес рыбы и где мой рекорд?", summary: "Личный трофей каждого вида",
      keywords: "лодка альбом новый вид размер вес масса граммы килограммы трофей рекорд тяжёлая рыба рейтинг соревнование навык рыбалка",
      steps: [
        "У каждого вида свой диапазон веса. Крупные экземпляры встречаются реже. Снасти меняют вероятность вида; управление помогает вытащить рыбу, но не прибавляет ей вес.",
        "По возвращении откроется итог: весь улов, общий вес, самая крупная рыба и достижения. Заберите улов и дождитесь подтверждения разгрузки. Самый тяжёлый экземпляр каждого вида сохранится во вкладке «Рекорды». Рекорд останется, даже если рыбу продать или приготовить.",
        "Откройте «Альбом» на воде или у причала: там видны найденные виды, число поимок и лучший вес. Улов на борту отмечен отдельно до разгрузки; покупка рыбы не открывает страницы.",
        "Вес не меняет цену рыбы и её применение в рецептах. Полученный улов развивает профессиональный навык рыбалки; пустой выход его не развивает.",
      ],
      note: "В рекордах «Друзья» и «Мир» включите «Публиковать мои рекорды» для участия. Кубок отмечает ваше первое место, включая ничью.",
      action: { label: "К лодке", target: { kind: "boat" } },
      relatedIds: ["boat-fishing", "fishing", "collection", "craft-skills"],
    }
    ] satisfies WorldHelpTopic[] : [{
      id: "boat-fishing", group: "travel", title: "Можно ли сейчас рыбачить с лодки?", summary: "Береговая рыбалка и возвращение прежнего улова",
      keywords: "лодка лодочная рыбалка причал забрать улов мохлик занят вернуться работа",
      steps: [
        "Выходы на лодке временно закрыты. Для рыбалки на берегу откройте «В путь» → «На рыбалку» и выберите маршрут.",
        "Если поездка уже была начата, там же откройте «Возвращение к причалу». Дождитесь прибытия и заберите улов. При полной кладовой освободите место и повторите получение.",
        "Оплаченную раньше работу с лодкой можно завершить там же, когда закончится её таймер.",
      ],
      action: { label: "К береговой рыбалке", target: { kind: "expeditions", sector: "coast" } },
      relatedIds: ["fishing", "storage", "construction"],
    }] satisfies WorldHelpTopic[]),
    {
      id: "plesk", group: "travel", title: "Где купить снасти и продать рыбу?", summary: "Плёска, лавка и книга улова",
      keywords: "плеск плёска выдра рыбачка торговка жительница магазин лавка снасти удочка крючки наживка купить продажа рыбы",
      steps: [
        "Нажмите прилавок Плёски или откройте «Ещё» → «Персонажи» → «Плёска». Нажатие на саму рыбачку вызывает реплику и голос.",
        "В «Лавке» купите снасти, наживку или рыбу. Удочки и крючки навсегда остаются вне кладовой; одна наживка расходуется на весь поход.",
        "«Показать шансы» сравнит нынешние проценты с выбранной снастью в пяти строках. Открытие не покупает снасть; в запущенной вами подсказке таблица открывается сама.",
        "В «Улове» классы сначала свёрнуты. Нажмите класс и вид. Повторный тап прибавляет 1 до доступного лимита; другой вид начинает с 1. Поле и «Все» меняют количество. Только «Продать» спишет рыбу. Цена едина внутри класса.",
      ],
      note: `Поставка меняется каждые ${(economyCatalog.fishing?.shop.refreshSeconds ?? 21600) / 3600} часов; досрочное обновление тратит жемчуг. Редкие снасти чаще появляются с ростом дома, легендарные - начиная с дома 4. Рыбалка самой Плёски не приносит вам добычу.`,
      action: { label: "Поговорить с Плёской", target: { kind: "resident", residentId: "plesk" } },
      relatedIds: ["fishing", "fishing-result", "fish-day", "resident-orders", "collection"],
    },
    {
      id: "fishing-result", group: "travel", title: "Где посмотреть готовый улов?", summary: "Виды и редкость готового улова",
      keywords: "улов результат пойманные рыбы вид редкость щука карась рыбалка вернулся рисунок запасы",
      steps: [
        releaseFeatures.boatFishingEnabled ? "Улов на борту показывает уже подтверждённые поимки. Вид и вес следующей рыбы раскроются после вываживания." : "Пока рыбалка идёт, видно только количество рыб. Будущие виды улова скрыты.",
        "Когда игра подтвердит возвращение, список «Пойманные рыбы» покажет виды, редкость и количество. У прежних вылазок могут остаться общие классы рыб.",
        "Нажмите «Забрать»: улов пополнит текущие запасы по видам и классам, а пойманные виды навсегда откроются в вашей книге. Цена и применение рыбы зависят от класса.",
      ],
      note: "Книга помнит прежние поимки, даже если рыба потрачена. В холодильнике, у Плёски и в выборе ингредиентов показана только оставшаяся рыба. Рисунок общего класса не заменяет этот список.",
      action: { label: "К рыбалке", target: fishingTarget },
      relatedIds: ["fishing", "plesk", "collection", "campfire", "fish-selection"],
    },
    {
      id: "fish-selection", group: "food", title: "Как выбрать рыбные ингредиенты?", summary: "Только оставшиеся в запасе виды",
      keywords: "выбор рыбы ингредиент рецепт заказ запас виды сбросить автозаполнение готовить отдать продать лот",
      steps: [
        "Рыбное блюдо, сдача заказа или создание лота откроют выбор видов. Выбор уже заполнен подходящей рыбой из текущих запасов; другой класс не подставляется.",
        "Нажмите нужный вид, чтобы добавить его или заменить одну выбранную рыбу. Кнопка с минусом убирает одну; «Сбросить» очищает выбор, «Автозаполнение» подбирает заново.",
        "Проверьте количество. «Готовить», «Отдать заказ» или «Продать» подтвердит расход выбранных видов; «Выставить лот» поместит их на рынок. Закрытие выбора ничего не расходует.",
      ],
      note: "Для обычных, учебных и этапных заказов действуют одни правила выбора. Старый остаток «Без указания вида» подходит для своего класса. Продажа и выставление не стирают поимки из книги; цены внутри класса общие.",
      action: { label: "Открыть костёр", target: { kind: "station", stationId: "dryer" } },
      relatedIds: ["resources", "market", "campfire", "fishing-result", "resident-orders", "collection"],
    },
    {
      id: "fish-day", group: "travel", title: "Зачем покупать рыбу дня?", summary: "Быстрые ингредиенты для готовки и заказов",
      keywords: "рыба дня скидка купить лавка плёска выгодно прибыль запас холодильник",
      steps: [
        `В лавке Плёски одна поставка содержит ${economyCatalog.fishing?.shop.fishStock ?? 6} рыб обычного класса. Скидка - ${100 - (economyCatalog.fishing?.shop.fishPriceBps ?? 6000) / 100}% от обычной цены покупки; новый прилавок приходит через ${(economyCatalog.fishing?.shop.refreshSeconds ?? 21600) / 3600} ч.`,
        "Купленная рыба подходит для жарки, ухи и копчения. Можно сразу закрыть подходящий заказ: перед покупкой сравните нужное количество и награду.",
      ],
      note: "Запас ограничен. Простая перепродажа Плёске убыточна, а подходящий заказ может принести прибыль. Покупка не открывает вид в книге находок.",
      action: { label: "К лавке Плёски", target: { kind: "resident", residentId: "plesk" } },
      relatedIds: ["campfire", "resident-orders", "collection"],
    },
    {
      id: "collection", group: "travel", title: "Как заполнить книгу находок?", summary: "Вылазки, рыба и минералы",
      keywords: "коллекция книга альбом находки путешествия рыбалка каменоломня минералы поймано неизвестная скрытая рыба",
      steps: [
        "Откройте «Ещё» → «Коллекции». Выберите главу и листайте страницы пальцем или кнопками «Назад / Далее». Фильтр оставит все, открытые или не открытые находки.",
        `Короткие работы копят время: ${TRAVEL_COLLECTION_SECONDS / 3600} часа лесных вылазок дают страницу путешествий, ${QUARRY_COLLECTION_SECONDS / 3600} часа подходящих исследований или добычи - минерал. С одной новой работы максимум одна находка: восемь часов леса не дают четыре страницы.`,
        "Рыбную главу открывает только собственный полученный улов. Покупка рыбы не открывает вид; до поимки его имя и рисунок скрыты в книге.",
      ],
      note: "Продажа, готовка и заказ не стирают находку. Записи книги не занимают кладовую; реликвии - отдельные расходуемые предметы. Отмена и повтор получения не дают находок.",
      action: { label: "Открыть коллекции", target: { kind: "collection" } },
      relatedIds: ["fishing", "fishing-result", "relics"],
    },
    {
      id: "future-world", group: "travel", title: "Как восстановить мост и маяк?", summary: "Мост с дома 2, маяк с дома 3",
      keywords: "мост маяк другой берег свет лучи пароход корабль мостик причал развитие восстановить закрыто",
      steps: [
        "С дома 2 нажмите мост на карте. Нужны шахта 2, печь 1 и мастерская 1. После таймера получите результат: восстановленный мост открывает рынок игроков.",
        "С дома 3 доступен маяк. Нужны восстановленный мост, мастерская 3 и печь 3; для изготовления материалов понадобится и шахта 3. После таймера получите результат стройки: маяк светится ночью, а при открытии своей большой карты к южному берегу впервые подходит корабль с готовыми заказами.",
        "С дома 4 мост открывает тропу и рощу другого берега, а маяк вместе с мастерской 3 даёт доступ к древним руинам. Направления выбираются в меню «В путь».",
      ],
      note: "Личные заказы доступны нажатием на корабль. После выполнения всех грузов он отплывает. Свободная прогулка через реку и морские путешествия ещё готовятся.",
      relatedIds: ["trade-ship", "ship-orders", "market", "fourth-house-stage", "construction", "journeys"],
    },
    {
      id: "trade-ship", group: "travel", title: "Когда приплывает корабль?", summary: "Первое прибытие после полученного маяка",
      keywords: "корабль пароход приплывает прибытие не приплыл не появился маяк причал бухта мостик большая карта",
      steps: [
        "Восстановите маяк и получите готовую стройку. Одного истёкшего таймера недостаточно.",
        "Откройте свою большую карту и закройте окна поверх неё. Первый заход ждёт загрузки рисунка корабля; в гостях он не запускается.",
        "Дождитесь подхода к южному берегу. Меню «Ещё» и другие игровые окна не останавливают начавшееся прибытие. Пауза и скрытая вкладка останавливают показ. С настройкой «Меньше движения» сразу появится стоящий корабль.",
      ],
      note: `Корабль стоит ${shipOrdersConfig.staySeconds / 3600} часа или до заполнения всех грузов. Следующий рейс приходит через ${shipOrdersConfig.intervalSeconds / 3600} часов после отплытия; оставшееся время видно в маяке. Срок идёт и с закрытой игрой.`,
      relatedIds: ["future-world", "ship-orders", "trade-ship-effects", "controls", "construction"],
    },
    {
      id: "ship-orders", group: "food", title: "Как загрузить товары на корабль?", summary: "Три груза разной сложности и 10 жемчужин",
      keywords: "порт портовый заказ корабля груз отгрузка припасы изделия материалы капитан награда жемчуг",
      steps: [
        "После получения восстановленного маяка корабль приходит с готовыми заказами. Нажмите на корабль: вас ждут три личных заказа на доступные вам товары, от простого до сложного.",
        "Загружайте товары по частям: кнопка у предмета переносит имеющиеся запасы, но не больше остатка заказа. Заполнение видно по грузам на палубе; точное количество есть в заказах. Недостающий товар ведёт к его производству.",
        "За каждый полностью заполненный груз монеты поступят автоматически; некоторые грузы дополнительно дают предмет. Награда видна заранее.",
        `После последнего груза автоматически получите ${formatPearls(shipOrdersConfig.rewardPearls)} жемчужин, и корабль отплывёт. Следующий рейс придёт через ${shipOrdersConfig.intervalSeconds / 3600} часов после завершения всей поставки.`,
      ],
      note: `Стоянка ограничена ${shipOrdersConfig.staySeconds / 3600} часами. За рейс можно бесплатно заменить ${shipOrdersConfig.freeReplacements} нетронутых груза. В уже начатый груз можно только добавлять товары.`,
      relatedIds: ["ship-orders-cancel", "trade-ship", "production", "storage"],
    },
    {
      id: "ship-orders-cancel", group: "food", title: "Когда вернётся корабль и можно ли отказаться от поставки?", summary: "Замена грузов и досрочное отплытие",
      keywords: "отказаться от поставки отменить пропустить поставка корабля отгрузка груз сгорает повтор награда ожидание",
      steps: [
        `У нетронутого груза нажмите «Заменить». На весь рейс доступно ${shipOrdersConfig.freeReplacements} бесплатных замены; остальные грузы и их награды сохраняются. Частично загруженный или оплаченный груз заменить нельзя.`,
        `Если рейс не подходит, отправьте корабль досрочно за ${formatPearls(shipOrdersConfig.resetPricePearls)} жемчужин с подтверждением. Новый придёт через ${shipOrdersConfig.intervalSeconds / 3600} часов. Эту паузу нельзя обойти повторным сбросом.`,
        `Через ${shipOrdersConfig.staySeconds / 3600} часа стоянки корабль уйдёт сам. Ранее полученные выплаты сохранятся, незавершённые грузы не оплатятся и внесённые товары не вернутся. Жемчужный бонус полагается только за все три завершённых груза.`,
      ],
      note: "Срок следующего прибытия виден в маяке. Повторное нажатие и восстановление связи не повторяют списание или награду.",
      relatedIds: ["ship-orders", "saving", "production"],
    },
    {
      id: "trade-ship-effects", group: "travel", title: "Почему не слышно гудок парохода?", summary: "Сигналы прибытия и отплытия",
      keywords: "корабль пароход гудок звук тишина сигнал фонари свет окна моргает мигает пульсация",
      steps: [
        "Перед первым прибытием включите звук в профиле → шестерёнке настроек. Проверьте общую громкость и «Постройки и действия»; если браузер приостановил звук, нажмите «Продолжить воспроизведение».",
        "При видимом подходе звучит один гудок, при отплытии короткий прощальный сигнал. Пропущенный звук не повторяется после включения звука, возвращения камеры или перезагрузки.",
        "Ночью окна и фонари стоящего корабля светят ровно. Лёгкая пульсация сопровождает движение; во время стоянки и выдвижения мостика постоянного мигания нет.",
      ],
      note: "Отсутствие гудка не мешает прибытию. Он не служит подтверждением награды или нового заказа.",
      action: { label: "Открыть настройки звука", target: { kind: "profile", tab: "settings" } },
      relatedIds: ["trade-ship", "sound", "night"],
    },
    {
      id: "campfire", group: "food", title: "Как пользоваться книгой рецептов?", summary: "Костёр, категории и приготовление",
      keywords: "костер костёр готовка готовить еда рецепты компот малиновый клубника жареная уха суп соус копченая рыба сушеные ягоды котелок припасы эпическая легендарная акула акулье жаркое праздничная",
      steps: [
        "Нажмите костёр: в книге есть «Рыбные блюда», «Напитки», «Десерты», «Припасы» и «Опыты». На нулевом уровне можно жарить рыбу.",
        "Значок замка в разделе показывает, сколько рецептов этого уровня ещё предстоит открыть. Собирайте, покупайте или получайте продукты в подарок, чтобы узнать новые блюда. Знакомые рецепты остаются в книге, даже когда продукты закончились. Найти их помогут поиск, редкость рыбы и фильтр «Есть ингредиенты».",
        "Нажатие на рецепт открывает состав и эффект без траты запасов. Нажмите «Приготовить». Для рыбного блюда проверьте выбранные виды и подтвердите «Готовить».",
        "В «Готовится» видны работающие места и покупка дополнительных. После таймера заберите результат, чтобы освободить место и засчитать приготовление.",
      ],
      note: "Малиновый компот требует две малины и костёр 1, готовится три минуты. Рыба другого класса автоматически не подставляется. Сытный ужин требует редкую рыбу.",
      action: { label: "Открыть костёр", target: { kind: "station", stationId: "dryer" } },
      relatedIds: ["cooking-experiments", "craft-skills", "recipe-unlocks", "cooking-achievements", "food"],
    },
    {
      id: "recipe-unlocks", group: "economy", title: "Как открыть новый рецепт?", summary: "Походы, собственный улов и ремесленная практика",
      keywords: "открытие рецепт задание квест бутылка банка инструменты ящик полевой комплект условия освоение заблокирован замок",
      steps: [
        "Откройте закрытый рецепт: его задание показывает все шаги и ваш прогресс. Для открытия нужны и уровень построек, и каждый пункт задания.",
        "Бутылке нужны два выхода в «Прибрежные отложения» и восемь пойманных рыб. Торговому ящику нужны два похода в лес и один в Старый лес. Для полевого комплекта исследуйте Тропу дальнего берега дважды и Рощу за рекой один раз.",
        "Походы, добыча, готовка и улов засчитываются после получения результата. Купленные вещи их не заменяют. Случайная редкая находка для задания не требуется.",
        "Выполненные шаги сохраняются после продажи или расхода предметов. Уже выполненные действия засчитываются сразу, начинать задание отдельной кнопкой не нужно.",
      ],
      note: "Клубнике по-прежнему нужен один приготовленный и забранный малиновый компот. Остальные ягоды без таких заданий. Открытие рецепта не выдаёт его продукт бесплатно.",
      relatedIds: ["campfire", "production", "journeys", "fishing", "berry-tiers"],
    },
    {
      id: "cooking-experiments", group: "food", title: "Как открыть скрытые блюда?", summary: "Подсказки, опыт и шанс удачи",
      keywords: "кухня скрытый секрет рецепт опыт эксперимент успех неудача шанс промах открытие",
      steps: [
        "Откройте «Опыты» в книге костра. Рисунок и подсказка намекают на сочетание. Состав, нужный навык и шанс видны до приготовления. Название и польза блюда откроются после первого успешного получения.",
        "Одна попытка занимает место у костра и тратит указанные ингредиенты. При удаче получите новое блюдо. При неудаче ингредиенты сгорают, предметов и возврата нет. Завершите попытку, чтобы освободить место и сохранить практику кулинарии.",
        "Навык постепенно повышает шанс. Он фиксируется при начале работы; перезагрузка и задержка получения его не меняют. Обычные рецепты всегда удаются.",
      ],
      note: "Особые блюда сильнее и дороже с учётом риска. Они не обязательны для построек и заказов. Покупка блюда не открывает рецепт и не считается вашим приготовлением.",
      action: { label: "К книге рецептов", target: { kind: "station", stationId: "dryer" } },
      relatedIds: ["craft-skills", "campfire", "cooking-achievements"],
    },
    {
      id: "craft-skills", group: "mochlik", title: "Как развивать навыки леса?", summary: "Девять направлений, по десять уровней",
      keywords: "навык навыки лес мастерство практика кулинария путешествия рыбалка ремесло печь собирательство лесозаготовка добыча строительство опыт уровень прокачка",
      steps: [
        "Откройте вкладку «Навыки леса» в игровом профиле. Здесь кулинария, путешествия, рыбалка, ремесло, печь, собирательство, лесозаготовка, добыча и строительство. Получайте результат соответствующей работы, чтобы развивать её навык.",
        "Уровни растут постепенно. Прогресс зависит от базовой длительности работы, ускорения его не уменьшают. Покупки, отмена, ожидание готового результата и повторное получение ответа не дают дополнительного прогресса.",
        `Кулинария повышает шанс опытов с ${baseCookingChance}% до ${maxCookingChance}%. Другие навыки понемногу сокращают время своих работ. Они не увеличивают количество предметов и вероятность редкой рыбы или находок. Дружба с жителями развивается отдельно через помощь и заказы.`,
      ],
      note: "Общий уровень и навыки считаются отдельно. Прогресс сохраняется. Старым игрокам строительство зачтётся по готовым постройкам; остальные новые навыки растут с этого обновления.",
      action: { label: "Посмотреть навыки", target: { kind: "profile", tab: "skills" } },
      relatedIds: ["cooking-experiments", "level", "journeys"],
    },
    {
      id: "cooking-achievements", group: "food", title: "Какие награды есть за готовку?", summary: "Количество готовых порций и разные освоенные рецепты",
      keywords: "достижение кухня повар лесная кухня разнообразие освоено рецептов награда жемчуг",
      steps: [
        "В книге костра видны полученные порции и освоенные рецепты. Считаются блюда, напитки и походные заготовки, приготовленные вами и забранные с костра.",
        "«Умелый повар» отмечает общее количество, «Лесная кухня» разнообразие. Один рецепт увеличивает разнообразие только при первом получении, независимо от количества порций.",
        "Откройте достижения из книги или профиля и заберите награду готовой ступени. Покупка готовой еды и повторное получение ответа сервера прогресс не увеличивают.",
      ],
      note: "Неудачный опыт даёт практику навыка, но не продвигает достижения за блюда. Награда каждой ступени выдаётся один раз. Предыдущие приготовления сохраняются, начинать заново не нужно.",
      action: { label: "Открыть книгу рецептов", target: { kind: "station", stationId: "dryer" } },
      relatedIds: ["campfire", "pearls", "profile", "recipe-unlocks"],
    },
    ...(soupRecipe && soupMeal ? [{
      id: "fish-soup", group: "food", title: "Как сварить рыбный суп?", summary: "Обычная рыба, ягоды и уголь",
      keywords: "рыбный суп обед обычная рыба малина уголь жареная порция",
      steps: [
        `Нужны дом ${soupRecipe.requiredHomeLevel} и костёр уровня ${soupRecipe.buildingLevel}. Сначала поймайте и заберите ${soupRecipe.requiredFishCaught ?? 0} любые рыбы, приготовьте и получите ${Object.entries(soupRecipe.requiredRecipes).map(([id, count]) => `${Object.keys(economyCatalog.recipes.find(recipe => recipe.id === id)?.rewards ?? {}).map(itemName).join(", ")} × ${count}`).join("; ")}.`,
        `Нажмите «${itemName("fish_soup")}" у костра, проверьте выбранную рыбу и нажмите «Готовить». Состав: ${Object.entries(soupRecipe.cost.items).map(([id, count]) => `${itemName(id)} × ${count}`).join(" + ")}. Приготовление занимает ${soupRecipe.seconds / 60} минут.`,
        "Заберите готовую порцию. Её можно отдать в просьбу, продать из кладовой или подать как обед.",
      ],
      note: `Пример для супа: вылазка ${mealTimeExample(soupMeal.heroSpeedBps, soupMeal.heroWorkSeconds)}, стройка ${mealTimeExample(soupMeal.builderSpeedBps, soupMeal.builderWorkSeconds)}. Запас на походы ${(soupMeal.heroWorkSeconds ?? 0) / 60} мин, на стройку ${(soupMeal.builderWorkSeconds ?? 0) / 60} мин работы по времени без бонусов. Шахтёра не ускоряет.${economyCatalog.localBuyer?.unitPrices?.fish_soup ? ` NPC покупает порцию за ${economyCatalog.localBuyer.unitPrices.fish_soup} монет.` : ""}`,
      action: { label: "К рыбному супу", target: { kind: "station", stationId: "dryer", recipeId: soupRecipe.id } },
      relatedIds: ["campfire", "food", "builder-food", "third-house-stage"],
    }] satisfies WorldHelpTopic[] : []),
    ...(food ? [
      {
        id: "food", group: "food", title: "Как накормить Мохлика и что это даёт?", summary: "Запас ускорения на несколько походов",
        keywords: "еда сытость сыт голод накормить обед съесть блюдо бафф бонус скорость кормление",
        paragraphs: ["Обед ускоряет работу Мохлика. Добыча и шансы рыбы не меняются."],
        steps: [
          "Откройте «Выбрать блюдо» в блоке «Ускорение едой». Здесь только ваши готовые порции, пустой список ведёт в книгу. Выберите блюдо и сравните бонус с новым временем. Затем подтвердите «Съесть 1 порцию»: только эта кнопка потратит еду.",
          "Блюдо даёт запас базовых минут работы. Вылазка тратит свои минуты, остаток сохранится для следующих отправлений. Если запаса мало, ускоряется лишь часть похода.",
          "Во время похода или сбора ягод поесть нельзя. Обед не запускает следующие работы автоматически и не расходуется в ожидании.",
        ],
        note: "Есть необязательно. Обед ждёт офлайн, пищевые бонусы не складываются. «Забрать блюдо» вернёт неиспользованную порцию. После первого расхода можно убрать остаток, но вернуть порцию уже нельзя. Обед не заменяет припасы, не ускоряет шахту и сбор ягод. Старый обед с прежними условиями действует на одну вылазку.",
        action: { label: "К вылазкам", target: { kind: "expeditions" } },
        relatedIds: ["food-bonuses", "campfire", "builder-food", "resident-orders"],
      },
      {
        id: "food-bonuses", group: "food", title: "Какие блюда сильнее ускоряют Мохлика?", summary: "Сколько времени сбережёт порция",
        keywords: "блюда сравнение процент запас минуты скорость вылазки",
        paragraphs: ["Сравнение на вылазке длительностью один час без еды и навыков. Остальные блюда сравните в книге рецептов."],
        steps: knownMeals.map(meal => `${itemName(meal.itemId)}: ${mealTimeExample(meal.heroSpeedBps, meal.heroWorkSeconds)}. Запас ${(meal.heroWorkSeconds ?? 0) / 60} мин работы.`),
        note: "В выборе блюда показаны запас базовых минут и новое время. Запас тратится только на начатую вылазку или рыбалку; остаток сохраняется. Бонус не меняет добычу и шансы рыбы.",
        action: { label: "К вылазкам", target: { kind: "expeditions" } },
        relatedIds: ["food", "builder-food-bonuses", "campfire"],
      },
      {
        id: "builder-food", group: "food", title: "Как еда ускоряет строителя?", summary: "Запас работы и сокращение таймера",
        keywords: "строитель шишколап ёжик накормить угостить сыт еда обед быстрее строительство скорость бонус",
        paragraphs: ["Бонус выбранного блюда и новое время видны перед подтверждением."],
        steps: [
          "Откройте «Выбрать блюдо» в блоке «Ускорение едой» у таймера стройки или в разговоре с Шишколапом. Выбор блюда покажет бонус и новое время. Подтвердите «Угостить · 1 порция»: только эта кнопка потратит еду.",
          "Подайте готовое блюдо. Свободный строитель сохранит его для следующей стройки; занятый начнёт использовать его сейчас. У порции есть запас ускоряемой работы: после его исчерпания остаток стройки идёт без еды.",
        ],
        note: "Одна порция на стройку, неизрасходованный запас на другую стройку не переносится. Простая еда удобна для коротких работ, сытные блюда помогают дольше. Таймер учитывает еду, навык и дружбу с Шишколапом. Неиспользованную порцию можно забрать, применённую нельзя. Сдача заказа не кормит.",
        action: { label: "К Шишколапу", target: { kind: "resident", residentId: "builder" } },
        relatedIds: ["builder-food-bonuses", "construction", "pearls", "resident-orders"],
      },
      {
        id: "builder-food-bonuses", group: "food", title: "Какие блюда сильнее ускоряют стройку?", summary: "Бонусы еды для одной стройки",
        keywords: "блюда сравнение процент скорость стройка строитель",
        paragraphs: ["Сравнение на стройке длительностью один час без навыка и дружбы. Для долгой работы выбирайте порцию с большим запасом."],
        steps: knownMeals.map(meal => `${itemName(meal.itemId)}: ${mealTimeExample(meal.builderSpeedBps, meal.builderWorkSeconds)}. Запас ${(meal.builderWorkSeconds ?? 0) / 60} мин работы.`),
        note: "Одна порция ускоряет работу в пределах своего запаса. На долгой стройке дешёвое блюдо закончится раньше сытного. Точная экономия с учётом оставшегося времени, навыка и дружбы показана перед подтверждением.",
        action: { label: "К Шишколапу", target: { kind: "resident", residentId: "builder" } },
        relatedIds: ["builder-food", "food-bonuses", "construction"],
      },
      {
        id: "resident-orders", group: "food", title: "Как заработать на заказах жителей?", summary: "Пять жителей, монеты и репутация",
        keywords: "заказ заказы доска заказчик плёска шишколап лопоух камнешмыг листохвост монеты награда сменить заменить обновить повторы жемчуг",
        steps: [
          "Откройте «Заказы» внизу карты или доску. Вкладка «К дому» показывает этап хозяйства, «Просьбы» обычные заказы, «Поручения» задания на неделю. Портрет выбирает жителя, «Все» снимает фильтр.",
          "«Отдать заказ» спишет товары и выдаст монеты. Для рыбного заказа сначала выберите виды, затем подтвердите сдачу. Новая просьба появится без ожидания; товары не резервируются.",
          "Награда нового заказа равна стоимости товаров с надбавкой 25%. Цена товара учитывает ингредиенты и время производства. Прежние обещанные выплаты сохраняются; более трудоёмкие просьбы дают больше репутации.",
          `Нужна доступная цепочка товаров. Просьба с закрытым товаром меняется бесплатно. Первые ${food.orders.freeReplacements} замены за ${food.orders.replacementWindowSeconds / 3600} ч бесплатны, затем ${formatPearls(food.orders.replacementPricePearls)} жемчужин с подтверждением.`,
        ],
        note: `На доске до ${food.orders.slots} ${food.orders.slots === 5 ? "заказов" : "заказа"}, обновление каждые ${food.orders.refreshSeconds / 3600} ч. Одновременных повторов нет. Этапные просьбы идут отдельно. Обычные заказы дают монеты, не сытость; пропуск без штрафов.`,
        action: { label: "Посмотреть заказы", target: { kind: "orders" } },
        relatedIds: ["trade-relations", "weekly-orders", "order-preparation", "fish-selection", "tutorial-order", "item-unlocks"],
      },
      {
        id: "trade-relations", group: "food", title: "Как повысить репутацию у жителей?", summary: "Дружба открывает преимущества до 10%",
        keywords: "репутация рейтинг отношения дружба житель шишколап лопоух камнешмыг плёска листохвост опыт бонус скидка",
        steps: [
          "У каждого жителя свой опыт и пять ступеней. Ранг сохраняется; сила бонуса зависит от недавней помощи этому жителю.",
          `Обычные просьбы дают опыт, до ${economyCatalog.tradeRelations?.dailyOrderXpCap ?? 180} в сутки у каждого жителя. После предела монеты остаются. Большое поручение даёт опыт отдельно. Максимальный ранг: ${economyCatalog.tradeRelations?.ranks.at(-1)?.requiredXp ?? 1600} опыта.`,
          `Покупки у Плёски и Листохвоста дают по ${economyCatalog.tradeRelations?.purchaseXp ?? 1} опыту, до ${economyCatalog.tradeRelations?.dailyPurchaseXpCap ?? 2} в сутки у торговца. Наживка и перепродажа без потерь опыта не дают. Учебные и этапные просьбы репутацию не дают.`,
          "Шишколап ускоряет стройку, Лопоух лесной участок, Камнешмыг добычу. У Плёски скидка на снасти и наживку, у Листохвоста ещё и на одежду за монеты. Припасы, рыба и жемчуг без этой скидки.",
        ],
        note: "Преимущество до 10%. Уже начатые работы сохраняют полученный бонус. Подробнее об активности в связанном ответе.",
        action: { label: "К отношениям с жителями", target: { kind: "orders" } },
        relatedIds: ["resident-support", "resident-orders", "weekly-orders", "builder-food"],
      },
      {
        id: "resident-support", group: "food", title: "Сохраняется ли помощь жителей?", summary: "Постоянная дружба и сезон сотрудничества",
        keywords: "активность поддержка репутация бонус перерыв отсутствие сезон дружба",
        steps: [
          "Опыт, ранг и заработанный бонус жителя сохраняются после перерыва. Поддержку больше не нужно восстанавливать по таймеру.",
          "Просьбы жителей, большие поручения и грузы корабля продвигают месячный сезон. В профиле видны тема месяца и действия с дополнительными очками.",
          `Рубежи ${playerProgressionCatalog.season.milestones.map(item => item.points).join(" / ")} очков дают по ${playerProgressionCatalog.season.milestones.map(item => item.rewardPearls).join(" / ")} жемчужин. Награды начисляются автоматически, каждый рубеж один раз за месяц.`,
          "Новый месяц начинает новую шкалу сезона. Общий уровень, отношения и уже полученные награды остаются.",
        ],
        note: "Все 12 месяцев имеют свою тему. Смена в первый день в 00:00 UTC (03:00 по Москве). Обязательной серии ежедневных входов нет.",
        action: { label: "Помочь жителям", target: { kind: "orders" } },
        relatedIds: ["trade-relations", "resident-orders", "weekly-orders", "level"],
      },
      {
        id: "weekly-orders", group: "food", title: "Как выбрать большое поручение на неделю?", summary: "Один житель, три оплачиваемых этапа",
        keywords: "недельный недельные неделя поручение большое заказ этап семь дней выбор срок репутация",
        steps: [
          "Откройте «Поручения», выберите жителя и сложность: обычное, сложное или мастерское. До принятия видны все три этапа и награды. При коротких визитах заранее подготовьте часть товаров.",
          "«Взять поручение на 7 дней» начинает срок. Одновременно можно взять только одно на аккаунт. Простой просмотр ничего не принимает и не списывает.",
          "Поручение объединяет подготовку припасов, изготовление и финальную поставку. Сдавайте этапы по порядку: каждый оплачивается монетами и репутацией, последний даёт 20, 40 или 70 жемчужин по сложности. Все запасы сразу в кладовой не нужны.",
          "Следующий выбор откроется через семь суток после принятия, даже если закончить раньше. По истечении срока уже полученные награды сохранятся; незавершённый этап не оплатится.",
        ],
        note: "Условия всех этапов сохраняются при принятии. Улучшение дома и обновление каталога не меняют обещанные товары и награды.",
        action: { label: "Выбрать поручение", target: { kind: "orders" } },
        relatedIds: ["trade-relations", "resident-orders", "order-preparation"],
      },
      {
        id: "order-preparation", group: "food", title: "Как определяется сложность просьбы?", summary: "Цепочки изготовления, запасы и награда",
        keywords: "подготовка время трудоемкость трудоёмкость изготовление ингредиенты цепочка очередь параллельно улов",
        steps: [
          "Сложность учитывает получение сырья и всю цепочку изготовления нужного количества товаров без запасов и ускорений. В карточке виден класс сложности; расчётное время не является таймером готовности.",
          "Время разных производств складывается как работа. Купленные дополнительные места позволяют готовить параллельно, а очередь или нехватка ресурсов увеличит ожидание. Пороги сложности обычной просьбы: 30 мин и 2 ч подготовки. Для большого поручения: 6 и 24 ч.",
          "Улов случаен: нужный класс рыбы может не попасться за одну вылазку. Проверяйте шансы текущих снастей перед отправлением.",
          "Свои запасы, еда и более быстрые технологии сокращают подготовку. Уже обещанные монеты и репутация от этого не уменьшаются.",
        ],
      note: "Нажмите недостающий товар, чтобы открыть его источник. Товары не резервируются просмотром заказа; реальный срок показан только там, где он действует.",
        action: { label: "Посмотреть просьбы", target: { kind: "orders" } },
        relatedIds: ["resident-orders", "weekly-orders", "production", "fishing"],
      },
    ] satisfies WorldHelpTopic[] : []),
    {
      id: "berry-garden", group: "food", title: "Как вырастить и собрать ягоды?", summary: "Урожай готов, но ещё не в кладовой",
      keywords: "ягоды куст полив лейка корзина урожай растут влажность дождь сбор собрать бесплатно",
      steps: [
        "Откройте куст и нажмите на нужную ягоду: выращивание начнётся сразу. У каждой ягоды свой рисунок, спелый цвет и таймер в карточке. Ягоды созревают даже с закрытой игрой; в разных местах куста могут расти разные культуры.",
        "Когда готовы несколько мест, нажмите «Собрать всё»: свободный Мохлик принесёт весь созревший урожай за один поход с корзинкой. Позднее созревшие ягоды подождут следующего сбора. Вне основной поляны сбор пройдёт по таймеру без анимации.",
        "Начатый сбор сохраняется после обновления страницы. Если Мохлик в походе, дождитесь возвращения. Для получения нужно место в кладовой на весь урожай; при нехватке освободите место и получите его позже.",
        "Если включены уведомления о ресурсах, напоминание о созревании подождёт, пока Мохлик сможет начать сбор.",
      ],
      note: "Полив и дождь не сокращают таймер. Ягоды не портятся и ежедневного ухода не требуют.",
      action: { label: "К ягодному кусту", target: { kind: "station", stationId: "garden" } },
      relatedIds: ["storage", "journeys", "campfire", "berry-tiers"],
    },
    {
      id: "berry-tiers", group: "food", title: "Какие ягоды и блюда открывает каждый дом?", summary: "Новый урожай и разные бонусы еды",
      keywords: "ягоды новые дом уровень малина клубника черника смородина ежевика клюква компот желе варенье десерт рецепты развитие",
      steps: [
        "Дом 1, куст 1: малина за 1 мин. Для клубники приготовьте и заберите один малиновый компот на костре 1; после открытия она растёт 5 мин. Покупка компота не засчитывается.",
        berryTierStep(berryTiers[0]),
        berryTierStep(berryTiers[1]),
        `${berryTierStep(berryTiers[2])} ${berryTierStep(berryTiers[3])}`,
      ],
      note: "У остальных ягод нет задания на готовку. Один слот даёт один предмет, сбор занимает 8 секунд. Пользу блюд для походов и стройки сравните в книге рецептов.",
      action: { label: "К ягодному кусту", target: { kind: "station", stationId: "garden" } },
      relatedIds: ["berry-garden", "campfire", "food", "builder-food", "item-unlocks"],
    },
    {
      id: "mochlik-life", group: "mochlik", title: "Мохлик спит или грустит - как помочь?", summary: "Окно самочувствия и пробуждение",
      keywords: "сон спит проснуться разбудить позвать дом настроение самочувствие силы устал грустит уют любопытство общение память",
      steps: [
        "Нажмите уровень слева сверху → «Как Мохлик?». Откроется отдельное окно: здесь видно, чем он занят и как себя чувствует.",
        "Чтобы разбудить или позвать, нажмите «Позвать Мохлика». Если спит дома, можно нажать дом или его значок.",
        "Дайте ему гулять и отдыхать: он сам выбирает занятия. Нажатие на идущего или занятого Мохлика не отменяет его маршрут и дело.",
      ],
      paragraphs: ["Свободные жители иногда встречаются на тропе или заходят друг к другу поболтать. Они обсуждают свои дела и отвечают друг другу по очереди. Встреча не мешает поручениям, торговле и работе."],
      note: "Это не обязательный уход: офлайн силы не расходуются. Настроение не заменяет сытость; обед для ускорения вылазки выбирается отдельно.",
      action: { label: "Посмотреть настроение", target: { kind: "profile", tab: "mood" } },
      relatedIds: ["food", "saving", "night"],
    },
    {
      id: "wardrobe", group: "mochlik", title: "Как переодеть Мохлика?", summary: "Примерка, покупка и свой образ",
      keywords: "гардероб внешность одежда шарф шапка шляпа цвет мха палитра снять надеть магазин",
      steps: [
        "Откройте «Ещё» → «Гардероб». Выберите категорию или найдите вещь по названию.",
        "В «Моих вещах» выберите «Надеть» или «Выбрать оттенок». В «Магазине» сначала примерьте, затем подтвердите покупку за указанную валюту.",
        "Аксессуар можно снять. Купленная вещь остаётся навсегда и не занимает кладовую.",
        "Дорожную коллекцию привозит Листохвост после возвращения с дома 3. Купленные у него вещи тоже находятся в «Моих вещах».",
      ],
      note: "Одежда меняет только внешность. Рыболовные снасти выбираются перед вылазкой.",
      action: { label: "Открыть гардероб", target: { kind: "wardrobe" } },
      relatedIds: ["fishing", "resources"],
    },
    {
      id: "night", group: "mochlik", title: "Влияют ли ночь и дождь на игру?", summary: "Погода меняет вид леса и прогулки",
      keywords: "освещение свет факел фонарь темно ночь день дождь погода птицы бабочки светлячки анимация",
      paragraphs: ["День и ночь следуют часовому поясу профиля. Дождь приходит сам. Мохлик может пойти отдыхать, а фонари, птицы и костёр меняют поведение."],
      note: "Свет и погода не тратят ресурсы и не меняют таймеры работ. Рыба в воде - украшение: настоящий улов приходит из вылазок. Настройка уменьшения движения делает анимации спокойнее.",
      relatedIds: ["mochlik-life", "fishing", "campfire"],
    },
    {
      id: "rewards", group: "account", title: "Как забрать подарок или награду?", summary: "Получение нужно подтвердить кнопкой",
      keywords: "подарки подарок вход ежедневно день награда жемчуг достижения ступени повтор связь",
      steps: [
        "Нажмите уровень → «Профиль» → «Подарки» → «Забрать подарок». Открытие окна ничего не начисляет.",
        `Следующий подарок доступен в новые сутки UTC и не раньше ${progressionRewardsCatalog.dailyMinimumHours} часов после прошлого. Шагов семь; пропуск не сбрасывает шаг. Новая цепочка из семи подарков даёт ${formatPearls(dailyPearls)} жемчужин один раз на аккаунт; ранее начатая сохраняет свои суммы; в седьмом подарке есть древнее ядро. После него цепочка завершена и через неделю не повторяется.`,
        "Жемчуг за достижения забирайте в профиле аккаунта на главном экране. Каждая выполненная ступень оплачивается один раз.",
      ],
      paragraphs: [`За полное обучение выдаётся ${formatPearls(progressionRewardsCatalog.onboarding.pearls)} жемчуга и ${progressionRewardsCatalog.onboarding.coins.toLocaleString("ru-RU")} монет один раз. Продолжить обучение можно через профиль → «?». Подарок за вход предлагается через минуту после курса или пропуска до завершения цепочки.`],
      note: "Если ответ потерялся, нажмите «Проверить получение». При нехватке места освободите кладовую и вернитесь к подарку - повторно награда не начислится.",
      action: { label: "К профилю и подаркам", target: { kind: "profile", tab: "profile" } },
      relatedIds: ["storage", "saving", "relics"],
    },
    {
      id: "profile", group: "account", title: "Что находится в профиле?", summary: "Общий прогресс, навыки леса, друзья и настройки",
      keywords: "профиль статистика достижения друзья настройки шестеренка вопрос обучение повтор продолжить",
      steps: [
        "Нажмите уровень слева сверху. В профиле находятся общая статистика, отдельная вкладка «Навыки леса», друзья и настройки.",
        "«Как Мохлик?» открывает отдельное окно самочувствия. Шестерёнка открывает настройки звука и вида.",
        "Знак «?» показывает краткое пояснение профиля. Для продолжения или повтора обучения нажмите отдельную кнопку внутри пояснения.",
      ],
      note: "Сам знак «?» не начинает курс заново и не сбрасывает пройденные шаги. В профиле приложения опыт и сезон находятся внутри «Игровой прогресс».",
      action: { label: "Открыть профиль", target: { kind: "profile", tab: "profile" } },
      relatedIds: ["friend-profile", "sound", "mochlik-life", "start"],
    },
    {
      id: "friend-profile", group: "account", title: "Как прийти в гости к другу?", summary: "Полянка и лавка друга из профиля Мохлика",
      keywords: "друг друзья профиль человек люди найти добавить заявка приглашение гости избранное поиск обновить мир полянка лавка купить",
      steps: [
        "В профиле откройте «Друзья». Карточка показывает игровой уровень и до трёх доступных товаров: количество и цену за лот.",
        "Нажмите карточку друга с надписью «В гости». На полянке видны его одежда, уровни построек и текущие работы. Стрелка слева сверху возвращает в ваш лес.",
        "«Лавка игрока» открывает рынок друга. Для покупки нужны открытые рынки, знакомый товар, монеты и место в кладовой.",
        "В «Людях» нажмите имя или аватар друга, чтобы открыть профиль. Находки листаются влево и вправо; общий уровень виден друзьям, а рекорды по тапам - если игрок участвует в рейтинге. Кнопка «Статус» отдельно управляет обновлениями отметок.",
      ],
      note: "В гости можно прийти с интернетом и разрешённой видимостью друга. Улучшать его постройки и собирать его урожай нельзя. Кошелёк, кладовая и будущие награды друга остаются личными.",
      action: { label: "Посмотреть друзей", target: { kind: "profile", tab: "friends" } },
      relatedIds: ["market", "level", "saving"],
    },
    {
      id: "forest-neighbor", group: "account", title: "Кто такой Берест и как зайти к нему?", summary: "Постоянный лесной сосед в друзьях Мохлика",
      keywords: "берест брест сосед бот npc друзья профиль гости полянка лавка товары поставка",
      steps: [
        "Нажмите уровень слева сверху → «Друзья». Лесной сосед уже здесь, даже если вы ещё не добавили друзей-игроков. Его карточка помечена «Персонаж мира».",
        "Нажмите «В гости»: откроется его лес во весь экран. Можно осмотреть постройки и производство; стрелка назад возвращает домой.",
        "Откройте лавку на его полянке: Берест предлагает недорогие партии открытых вам товаров. Цена видна перед покупкой, запас ограничен до следующей поставки. Новые открытия учтутся в следующей поставке. Для торговли откройте свой рынок.",
        "Перед продажей смотрите подсказку Береста: количество, цену и бюджет. Первый подходящий лот может выкупить через три минуты, залежавшиеся от шести часов. Стандартно до двух покупок в сутки с комиссией; текущие условия указаны в подсказке.",
      ],
      note: "Сосед относится к игровому миру и отсутствует в главном разделе «Люди». У него нет отметок, геопозиции и сетевого статуса.",
      action: { label: "К друзьям Мохлика", target: { kind: "profile", tab: "friends" } },
      relatedIds: ["friend-profile", "market"],
    },
    {
      id: "saving", group: "account", title: "Действие зависло или пропала связь", summary: "Как проверить результат и сохранить прогресс",
      keywords: "сохранение сеть интернет офлайн афк afk бездействие отошли пауза отключение ошибка синхронизация аккаунт вход восстановление телефон устройство зависло не работает пропали не пришли монеты награда лимит 429 слишком частые запросы сервер подождать",
      steps: [
        "Значок сети показывает очередь; повтор не создаст вторую покупку или награду. Значок часов означает паузу сервера: после таймера ожидающее действие продолжится в активной игре с сетью.",
        "Посадка и обычное производство сохраняются в очередь, до 12 действий. Таймер начнётся после принятия сервером. Выбор рыбы, покупки, продажи и получение наград требуют подтверждённой связи.",
        "Через 5 минут бездействия нажмите «Продолжить» поверх карты. Для другой вкладки есть «Продолжить здесь».",
        "На другом телефоне войдите в тот же аккаунт. Заранее сохраните резервный код в «Вход и безопасность».",
      ],
      note: "До подтверждения не очищайте данные браузера и не выходите из аккаунта. Уже начатые работы продолжаются по серверным таймерам; очередь восстанавливается после перезагрузки. О запрете сохранения браузером игра сообщит.",
      action: { label: "Проверить профиль", target: { kind: "profile", tab: "profile" } },
      relatedIds: ["feedback", "rewards"],
    },
    {
      id: "feedback", group: "account", title: "Как сообщить об ошибке?", summary: "Что написать разработчику",
      keywords: "баг ошибка идея предложение жалоба помощь поддержка разработчик сообщение обратная связь проблема",
      steps: [
        "На главном экране откройте beta-test → «Написать разработчику».",
        "Опишите, что нажали, что ожидали и что произошло. Укажите устройство и браузер; пароли и коды входа не отправляйте.",
        "Нажмите «Отправить» и дождитесь подтверждения. При сбое используйте «Повторить отправку» - дубликат не появится.",
      ],
      note: "Доступно одно обращение за 24 часа на аккаунт, от 10 до 3000 символов. Изменения версий находятся в том же разделе beta-test.",
      relatedIds: ["saving"],
    },
  ];
}
