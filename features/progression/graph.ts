import { economyCatalog, type EconomyCatalog, type EconomyCost } from "@/features/economy/domain/model";
import { formatPearls } from "@/features/economy/domain/money";
import { recipeResultName } from "@/features/economy/domain/recipe-prerequisites";
import { constructionTimePearlPrice } from "@/features/economy/domain/rules";
import progressionRewards from "@/apps/api/src/main/resources/world/progression-rewards-catalog.json";

export type ProgressionNodeKind = "location" | "building" | "recipe" | "exploration" | "acquisition" | "world" | "collection" | "equipment" | "milestone" | "market" | "project";

export type ProgressionNode = {
  id: string;
  title: string;
  label: string;
  icon: string;
  kind: ProgressionNodeKind;
  status: "active" | "plan";
  phase: number;
  buildingId?: string;
  /** The existing map object that hosts this economic improvement or recipe. */
  locationId?: string;
  level?: number;
  cost?: EconomyCost;
  seconds?: number;
  rewards?: Record<string, number>;
  /** Possible items share their actor’s clock; these are not guaranteed per-trip rewards. */
  rareDrops?: NonNullable<EconomyCatalog["rareDrops"]>;
  /** Possible inventory classes from fishing, never a guaranteed class reward list. */
  fishingSource?: { itemIds: string[]; routeIds: string[] };
  /** Building ids map to minimum levels; completedExplorations is a cumulative counter. */
  requirements: Record<string, number>;
  children: string[];
  description?: string;
  warehouseCapacity?: number;
};

export type ProgressionEdge = {
  id: string;
  source: string;
  target: string;
  kind: "requirement" | "unlock" | "cost" | "available" | "flow" | "any" | "plan" | "contains";
};

export type ProgressionGraph = { nodes: ProgressionNode[]; edges: ProgressionEdge[] };

export const buildingLabels: Record<string, string> = {
  home: "Дом", garden: "Ягодный куст", woodlot: "Лесозаготовки", quarry: "Шахта", kiln: "Печь", workshop: "Верстак", dryer: "Костёр", warehouse: "Кладовая", bridge: "Мост", lighthouse: "Маяк",
};
export const progressionLocations = [
  { id: "place:home", title: "Дом", icon: "🏠", buildingIds: ["home", "warehouse"], description: "Дом на полянке. Уровень дома открывает новые возможности хозяйства; кладовая расширяется отдельно внутри дома." },
  { id: "bush", title: "Ягодный куст", icon: "🫐", buildingIds: ["garden"], description: "Нажмите карточку ягоды: выращивание начнётся сразу, состав и нехватка видны на ней. Ягоды на кусте созревают по таймеру. По нажатию «Собрать всё» Мохлик за один подход принесёт все уже созревшие ягоды. Общая серверная фаза длится не менее 8 секунд; перезагрузка сохраняет сбор. Затем урожай поступит в кладовую. Полив сохраняет влажность, но не сокращает срок заказа." },
  { id: "place:woodlot", title: "Лесной участок", icon: "🌲", buildingIds: ["woodlot"], description: "Лес и существующий навес. Здесь обустраиваются лесозаготовки: сначала бревно, с дома 2 — волокно, затем твёрдая древесина и смола." },
  { id: "place:workshop", title: "Мастерская", icon: "🛠️", buildingIds: ["workshop", "kiln"], description: "Одно здание мастерской: внутри отдельно развиваются верстак и печь. У каждого оборудования свои условия обустройства и рецепты. Если работают оба, одна общая рамка на карте содержит две строки с разделителем, своими рисунками, секундными таймерами и независимыми переходами. Полное название оборудования доступно в подписи." },
  { id: "campfire", title: "Костёр", icon: "🏕️", buildingIds: ["dryer"], description: "Существующий костёр служит местом отдыха и приготовления запасов. Рецепты разделены на рыбные блюда, напитки, ягодные десерты и походные припасы. Фильтр времени: все, до 15 минут, более 15 минут до часа, дольше часа; текущая готовка всегда видна. Рыбный рецепт открывает быстрый выбор собственных видов с автозаполнением и подтверждением «Готовить»." },
  { id: "place:quarry", title: "Шахта", icon: "⛏️", buildingIds: ["quarry"], description: "Заброшенная шахта уже есть на карте. Материалы добывает шахтёр в собственной очереди. Задания разделены по ресурсам и фильтруются по времени. Компактная строка показывает рисунок, название и количество слева, время справа; смешанная добыча сохраняет все количества. Текущая работа всегда видна без повторения условий запуска. Мохлик может гулять, рыбачить и собирать ягоды одновременно с добычей. Улучшения открывают новые материалы и длительные смены. Интерьер и его мини-карта относятся к будущему этапу." },
  { id: "bridge", title: "Мост", icon: "🌉", buildingIds: ["bridge"], description: "Восстановленный мост открывает рынок игроков. Вылазки другого берега имеют дополнительные требования. После получения стройки используется существующий рисунок уровня 1. Свободный проход через реку ещё требует разметки путей карты." },
  { id: "lighthouse", title: "Маяк", icon: "🔦", buildingIds: ["lighthouse"], description: "Восстановление маяка включает ночной свет. По лору свет приглашает пароход с большими заказами; сам пароход ещё предстоит реализовать. Исследование древних руин открывается отдельно по условиям маршрута." },
] as const;
const locationByBuilding = new Map<string, typeof progressionLocations[number]>(progressionLocations.flatMap(location => location.buildingIds.map(id => [id, location] as const)));
const buildingIcons: Record<string, string> = { home: "🏠", garden: "🌱", woodlot: "🌲", quarry: "⛏️", kiln: "🔥", workshop: "🛠️", dryer: "♨️", warehouse: "📦", bridge: "🌉", lighthouse: "🔦" };
const itemIcons: Record<string, string> = {
  berries: "🫐", wood: "🪵", stone: "🪨", ore: "⛏️", fiber: "🌾", fish: "🐟", planks: "🪵", rope: "🪢", metal_parts: "⚙️", dried_berries: "🫐", smoked_fish: "🐟", clay: "🏺", sand: "⌛", charcoal: "🔥", iron_ingot: "🔩", bricks: "🧱", glass: "💎", hardwood: "🌳", resin: "🍯", cloth: "🧵", beams: "🏗️", tools: "🛠️", reinforced_parts: "⚙️", cut_stone: "🪨",
};
export const itemLabels: Record<string, string> = {
  berries: "Малина", wood: "Бревно", stone: "Камень", ore: "Руда", fiber: "Волокно", fish: "Рыба", planks: "Доска", rope: "Верёвка", metal_parts: "Метал. деталь", dried_berries: "Сушёные ягоды", smoked_fish: "Копчёная рыба", clay: "Глина", sand: "Песок", charcoal: "Уголь", iron_ingot: "Железный слиток", bricks: "Кирпич", glass: "Стекло", hardwood: "Крепкое бревно", resin: "Смола", cloth: "Полотно", beams: "Балка", tools: "Инструменты", reinforced_parts: "Усиленные узлы", cut_stone: "Тёсаный камень",
};
export const progressionItemNames: Record<string, string> = Object.fromEntries(economyCatalog.items.map(item => [item.id, item.name]));

const routeLabels: Record<string, string> = { quarry_stone: "Камень", quarry_stone_overnight: "Камень к утру", quarry_ore: "Руда", quarry_clay: "Глина", quarry_sand: "Песок", quarry_shift: "Шахта", quarry_deep_face: "Глубокий забой", quarry_supply: "Большая смена", forest: "Лесная разведка", shore: "Берег", forest_camp: "Лесной обход", shore_camp: "Стоянка на берегу", cave: "Пещера", deep_cave: "Глубокий проход", old_woodland: "Старый лес", coastal_deposits: "Отложения", uplands: "Нагорье", abandoned_quarry: "Заброш. карьер" };
const productionOrder = ["garden", "woodlot", "quarry", "kiln", "workshop", "dryer", "bridge", "lighthouse", "warehouse"];
const initialBuildings = new Set(["home", "garden", "warehouse"]);
const buildingNodeId = (id: string, level: number) => `b:${id}:${level}`;
const cloneCost = (cost: EconomyCost): EconomyCost => ({ coins: cost.coins, items: { ...cost.items } });
const shortTime = (seconds: number) => seconds < 60 ? `${seconds} с`
  : seconds % 3600 === 0 ? `${seconds / 3600} ч`
    : seconds % 60 === 0 ? `${seconds / 60} мин` : `${Math.floor(seconds / 60)} мин ${seconds % 60} с`;

type WorldDefinition = [id: string, label: string, icon: string, description: string, kind?: ProgressionNodeKind];
const worldDefinitions: WorldDefinition[] = [
  ["living", "Живая поляна", "🌿", "Мохлик выбирает занятия, отдыхает, спит, встречает живность и запоминает состояние полянки. Эта жизнь развивается отдельно от серверного хозяйства."],
  ["wildlife", "Птицы и живность", "🦋", "Птицы, бабочки и светлячки взаимодействуют с полянкой. Они не являются производством ресурсов."],
  ["bridge_ruin", "Мост · уровень 0", "🌉", "Разрушенный мост на карте. Для восстановления нужны открытые условия стройки, материалы и монеты; готовую работу нужно получить. После этого становится доступен рынок игроков."],
  ["lighthouse_ruin", "Маяк · уровень 0", "🔦", "Разрушенный маяк на карте. После восстановления и получения стройки включается ночной свет. Пароход с большими заказами относится к будущему продолжению этой ветки."],
  ["album", "Книга находок", "📖", "Три главы: путешествия, рыбалка и каменоломня. Находки отмечаются после получения результата занятия и остаются навсегда; продажа материалов не стирает страницы.", "collection"],
  ["travel_book", "Путешествия", "🍃", "Лесные вылазки пополняют книгу. Прежние лесные находки сохранены; зачтённое время открывает недостающие страницы без повторов.", "collection"],
  ["quarry_book", "Каменоломня", "💎", "Добыча шахтёра и исследования пещер открывают страницы с минералами. Это памятные находки, они не расходуются при строительстве и не занимают кладовую.", "collection"],
  ["explorer_cap", "Шляпа следопыта", "👒", "Сохранённая награда прежних путешествий. Уже полученную вещь можно надеть.", "equipment"],
  ["willow_rod", "Ивовая удочка · прежняя награда", "🎣", "Сохранённая награда за полную прежнюю речную коллекцию. Это отдельная вещь от рыбацкой удочки, которую продаёт Плёска: награда альбома не открывает купленную снасть.", "equipment"],
  ["wardrobe", "Гардероб", "🧣", "Свои вещи, примерочная и магазин одежды за монеты или жемчуг. Шапки, шарфы и оттенки мха не занимают кладовую.", "equipment"],
  ["life_marks", "Отметки жизни", "💚", "Подтверждённые отметки жизни поддерживают дневную серию. Это отдельная ветка от строительства и производства."],
  ["day_streak", "Серия дней", "📅", "Следующая отметка продлевает серию, если между отметками прошло не больше 24 часов. Серия связана с календарными наградами и достижением за 7 дней."],
  ["calendar_gifts", "Подарки 3/7/14/30", "🎁", "Подарки за серию дней сохраняются: цветы, коврик, ящик находок и гирлянда. Их размещение и показ на текущей карте пока скрыты."],
  ["taps", "Игровые тапы", "👆", "Тапы увеличивают игровой счёт и участвуют в рейтингах. Они не начисляют монеты или ресурсы текущей экономики."],
  ["player_level", "Уровень игрока", "⭐", "Суммарный счёт тапов определяет игровой уровень 1–100 и значок. Этот уровень отличается от уровня дома и не открывает хозяйственные постройки."],
  ["tap_streak", "Серия тапов", "⚡", "Непрерывная серия тапов заканчивается после паузы 10 секунд. Она даёт лучший рекорд серии."],
  ["leaderboard", "Рейтинг и рекорды", "🏆", "В рейтинге две метрики: месячные тапы и лучшая непрерывная серия. Уровень по общему счёту не входит в эти рейтинги."],
  ["achievements", "Достижения со ступенями", "🏅", "Вылазки, освоенные рецепты, дом, собственный улов, находки и продажи дополняют прежние цели аккаунта. Все ступени одной цели находятся в одной карточке. Полученные награды сохраняются и не служат воротами хозяйственного развития."],
  ["pleska", "Плёска · лавка и рыбалка", "🎣", `Открывается через «Ещё → Персонажи» или нажатием на жительницу берега. Плёска предлагает ограниченный набор удочек, крючков и наживок на шесть часов. Досрочное обновление стоит до ${formatPearls(economyCatalog.fishing?.shop.refreshPricePearls ?? 0)} жемчужин: цена уменьшается вместе с оставшимся временем. Оно заменяет все товары на другие. Если доступного ассортимента мало, остаётся бесплатная поставка по таймеру. Стартовая удочка бесплатна. Перед вылазкой три ячейки показывают удочку, крючок и наживку с рисунком и направлением. Выбор открывает собственные варианты и изменение шанса нужного класса; нажатие только экипирует предмет. Пять строк шансов показывают прежний и новый проценты для изменённых классов. В собственном улове все классы сначала свёрнуты. Нажатие класса раскрывает реальные оставшиеся виды. Можно выбрать вид и количество для продажи; Плёска платит прежнюю полную цену класса. Её декоративная рыбалка не выдаёт игроку товары.`],
  ["public_profiles", "Профили друзей", "👥", "Нажмите имя друга в списке людей: видны уровень дома, завершённые вылазки, игровые достижения и найденные страницы книги. Нужны действующая связь и разрешённая видимость. Кошелёк, запасы, личные отметки и задания закрыты."],
  ["fishing_catches", "Коллекция пойманной рыбы", "🐟", `В книге ${economyCatalog.fishing?.fish.length ?? 0} видов пяти разрядов, включая легендарную акулу. Запись появляется после получения собственного улова. Купленная рыба не открывает коллекцию. Каждая рыба сначала получает класс с учётом снастей, затем равновероятный вид внутри класса. После завершения таймера в карточке показаны реальные виды с рисунками, количеством и редкостью. Получение пополняет пять классов и отдельно сохраняет известные оставшиеся виды. Нажатие класса в холодильнике открывает компактную панель текущих видов поверх сетки, сохраняя размер карточек. Их можно выбрать для готовки, заказов, продажи или лота с автозаполнением. Израсходованные виды остаются в коллекции; купленная у игрока рыба сохраняет известный вид, но не открывает личную поимку. Старый запас без состава показан как «Без указания вида». Стоянка даёт больше улова за один выход; редкий класс не гарантирован.`, "collection"],
];

const projectDefinitions: WorldDefinition[] = [
  ["mine_interior", "Шахта: интерьер", "⛏️", "Будущий внутренний экран шахты с собственной мини-картой. Он не требуется для действующих шахтных смен: шахтёр добывает материалы независимо от Мохлика, результат определяется серверным таймером."],
  ["far_bank", "Прогулка на другом берегу", "🗺️", "Вылазки другого берега открываются после моста. Свободная прогулка по новой территории требует отдельной разметки путей и перехода через реку."],
  ["regional_trips", "Новые территории", "🧭", "Предлагаемые региональные исследования за пределами нынешних маршрутов."],
  ["new_finds", "Новые находки", "🔍", "Будущее пополнение альбомов за новые исследования."],
  ["shore_site", "Личный берег", "🏖️", "Развитие собственного берега запланировано на будущее."],
  ["boat", "Лодка", "🛶", "Предлагаемое продолжение ветки берега."],
  ["port", "Порт", "⚓", "Предлагаемый следующий этап лодки и берегового хозяйства."],
  ["ships", "Пароход с большими заказами", "⛵", "Будущее продолжение маяка: его свет приглашает пароход с крупными поставками разных товаров. Прибытие, сроки, награды и сами заказы ещё не реализованы; восстановление маяка пока включает свет и выполняет условия поздних исследований."],
  ["sea_trips", "Морские экспедиции", "🌊", "Будущее направление экспедиций и маяка. Конкретные маршруты и награды ещё не утверждены."],
  ["new_fruits", "Новые плоды", "🍎", "Будущее расширение сада новыми плодами. Уровень сада для открытия ещё не выбран."],
  ["tackle", "Изготовление снастей", "🪝", "Будущее изготовление снастей в мастерской. Уровень верстака ещё не выбран; сейчас новые удочки, крючки и наживки появляются в лавке Плёски."],
  ["friend_glade", "Полянки друзей", "🌿", "Будущий просмотр обустройства полянки друга. Сейчас можно смотреть разрешённые игровые сведения профиля; его мир ещё не открывается."],
  ["pleska_home", "Домик Плёски", "🏠", "Будущий домик жительницы. Место, внешний вид, уровни и игровые правила ещё не утверждены. Действующие лавка и рыбалка не требуют этой постройки."],
  ["pearl_trader", "Ограниченный торговец", "", "Будущий торговец реликвиями за жемчуг: ограничение запасов, цены и расписание ещё не утверждены. Сейчас такого магазина нет; реликвии получают в исследованиях и подарках или меняют между игроками."],
];

/** A read-only map of current game rules and explicitly separate world proposals. */
export function buildProgressionGraph(catalog: EconomyCatalog = economyCatalog): ProgressionGraph {
  const nodes: ProgressionNode[] = [];
  const edges: ProgressionEdge[] = [];
  const byId = new Map<string, ProgressionNode>();
  const edgeIds = new Set<string>();
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const dailyPearls = progressionRewards.daily.reduce((sum, reward) => sum + reward.pearls, 0);
  const achievementPearls = Object.values(progressionRewards.achievementPearls).flat().reduce((sum, count) => sum + count, 0);
  const secondStageCount = catalog.stageOrders?.find(stage => stage.homeLevel === 2)?.orders.length ?? 0;
  const thirdStage = catalog.stageOrders?.find(stage => stage.homeLevel === 3);
  const fourthStage = catalog.stageOrders?.find(stage => stage.homeLevel === 4);
  const fullPriceBuyer = catalog.items.filter(item => item.tradable).every(item => catalog.localBuyer?.unitPrices?.[item.id] === item.baseSellPrice);
  const constructionExamples = [60, 3600, 86400, 2 * 86400, 7 * 86400].map(seconds =>
    `${shortTime(seconds)} — ${formatPearls(constructionTimePearlPrice(seconds, catalog.constructionSpeedup))} жемчужин`).join("; ");

  function add(node: ProgressionNode) {
    if (byId.has(node.id)) throw new Error(`Duplicate progression node: ${node.id}`);
    nodes.push(node);
    byId.set(node.id, node);
    return node;
  }
  function edge(source: string, target: string, kind: ProgressionEdge["kind"] = "requirement") {
    if (source === target) return;
    const id = `${kind}:${source}->${target}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, source, target, kind });
  }
  function fixed(id: string, title: string, icon: string, phase: number, description: string, kind: ProgressionNodeKind = "world", status: ProgressionNode["status"] = "active") {
    return add({ id, title, label: title, icon, phase, description, kind, status, requirements: {}, children: [] });
  }

  fixed("start", "Начало", "🌱", 0, `Есть дом 1, ягодный куст 1 и кладовая 1. Старт: ${catalog.onboarding?.startingWallet.coins ?? 0} монет; ${Object.entries(catalog.onboarding?.startingItems ?? {}).map(([id, amount]) => `${items.get(id)?.name ?? id} × ${amount}`).join(", ")}. Выращивайте малину и выполняйте четыре учебных заказа, чтобы построить лесной участок, костёр, мастерскую и улучшить дом. Бесплатная лесная вылазка восстанавливает проданные материалы. Тапы не дают хозяйственную валюту.`);
  fixed("trader", "Быстрая продажа", "🧑‍🌾", 0, `Продажа из кладовой с начала игры: ${fullPriceBuyer ? "все продаваемые товары NPC выкупает по полной базовой цене за каждую единицу. Сырую рыбу Плёска покупает по той же полной цене её класса" : `для части товаров каталог задаёт фиксированные цены NPC. Остальные продаются с уценкой ${100 - (catalog.localBuyer?.payoutBps ?? 10000) / 100}% от базовой цены, итог стопки округляется вниз до кратного ${catalog.currencyScale} монетам. Плёска покупает сырую рыбу по полной базовой цене её класса`}. В холодильнике нажмите рыбный класс: панель поверх сетки предлагает вид и количество, не раздвигая карточки. «Продать» расходует выбранных рыб по прежней цене класса. Общая панель экономики также предлагает выбор перед рыбной продажей NPC. Рынок игроков открывается позднее; покупатель там не гарантирован.`);
  fixed("coins", "Монеты", "🪙", 0, "Выручка за товары идёт на строительство и улучшения. Монеты не занимают место на складе.");
  fixed("pearls", "Жемчуг · ускорение", "◉", 0, `Можно сразу завершить текущую стройку. Примеры цены по оставшемуся времени: ${constructionExamples}. Промежуточная цена рассчитывается по действующей кривой каталога. Цена округляется вверх с шагом ${formatPearls(catalog.constructionSpeedup.priceStepPearls)}, убывает со временем и подтверждается перед списанием. Можно бесплатно дождаться таймера. Производство, вылазки и интервалы проектных поставок не ускоряются. Жемчуг также обновляет предложения Плёски и открывает места отдельно для каждого производства: ${catalog.productionSlots.upgrades.map(upgrade => `${upgrade.slots}-е — ${formatPearls(upgrade.pricePearls)} жемчужин с дома ${upgrade.requiredHomeLevel}`).join("; ")}. У шахтёра своя очередь без платных слотов. Дополнительные места продавца на рынке покупаются по очереди: ${catalog.market.slotPricesPearls.map((price, index) => `${catalog.market.baseSlots + index + 1}-е — ${formatPearls(price)} жемчужин`).join("; ")}. Источники: ${formatPearls(dailyPearls)} жемчужин за полный цикл ежедневных наград и до ${formatPearls(achievementPearls)} за самостоятельно полученные ступени достижений, однократно. В «Ещё» доступна витрина магазина жемчуга и золота без покупок. Торговец реликвиями ещё не реализован.`);
  fixed("daily_rewards", "Ежедневные награды", "", 0, `Подарки в профиле «Мой Мохлик». Цикл из ${progressionRewards.daily.length} получений: монеты и материалы по завершённому уровню дома, древнее ядро в седьмом подарке и суммарно ${formatPearls(dailyPearls)} жемчужин. Следующая награда доступна в следующие сутки UTC и не ранее чем через ${progressionRewards.dailyMinimumHours} часов после предыдущей. Пропуск не сбрасывает шаг. Забрать нужно вручную; переполненная кладовая не расходует награду. Подарок можно открыть в профиле и получить вручную.`, "milestone");
  edge("start", "trader", "available");
  edge("start", "pearls", "available");
  edge("start", "daily_rewards", "available");
  edge("daily_rewards", "pearls", "flow"); edge("daily_rewards", "coins", "flow");
  edge("trader", "coins", "flow");
  for (const location of progressionLocations) {
    const home = catalog.buildings.find(building => building.id === location.id)?.levels[0]?.requiredHomeLevel;
    fixed(location.id, location.title, location.icon, 0,
      home && (location.id === "bridge" || location.id === "lighthouse") ? `Восстановление доступно с дома ${home}. ${location.description}` : location.description, "location");
    edge("start", location.id, "available");
  }

  const orderedBuildings = [...catalog.buildings].sort((a, b) => {
    const order = ["home", ...productionOrder];
    const rank = (id: string) => order.includes(id) ? order.indexOf(id) : order.length;
    return rank(a.id) - rank(b.id);
  });
  const levels = [...new Set(catalog.buildings.flatMap(building => building.levels.map(level => level.level)))].sort((a, b) => a - b);
  for (const level of levels) {
    for (const building of orderedBuildings) {
      const data = building.levels.find(value => value.level === level);
      if (!data) continue;
      const requirements: Record<string, number> = { home: data.requiredHomeLevel, ...data.requiredBuildings };
      if (level > 1) requirements[building.id] = Math.max(requirements[building.id] || 0, level - 1);
      if (building.id === "home" && level === 1) delete requirements.home;
      const node = add({
        id: buildingNodeId(building.id, level), title: `${buildingLabels[building.id] || building.name} · уровень ${level}`,
        label: `${buildingLabels[building.id] || building.name} ${level}`, icon: buildingIcons[building.id] || "🏗️",
        // The storage ladder can exceed the five home tiers. Its display phase
        // follows real home/previous-storage gates, not its own level number.
        kind: "building", status: "active", phase: building.id === "warehouse" ? data.requiredHomeLevel : level,
        buildingId: building.id, locationId: locationByBuilding.get(building.id)?.id, level,
        cost: cloneCost(data.cost), seconds: data.seconds, requirements, children: [],
        description: `${initialBuildings.has(building.id) && level === 1 ? "Есть на старте. " : ""}${building.description}${building.id === "warehouse" ? " Каждая единица товара занимает место; монеты, жемчуг и удочки не занимают. Товар в объявлениях рынка продолжает занимать место. Перед получением результата может понадобиться освободить склад. Расширение удобно для запасов, но не требуется для улучшения дома." : " В хозяйстве идёт только одна стройка. Заказ этого оборудования нужно забрать перед его улучшением."}`,
        ...(data.warehouseCapacity != null ? { warehouseCapacity: data.warehouseCapacity } : {}),
      });
      for (const recipe of catalog.recipes.filter(value => value.buildingId === building.id && value.buildingLevel === level)) {
        const outputs = Object.keys(recipe.rewards), single = outputs.length === 1, itemId = outputs[0];
        const fishIngredients = catalog.fishing?.classes.filter(group => (recipe.cost.items[group.itemId] ?? 0) > 0) ?? [];
        const outputLabel = itemLabels[itemId] || items.get(itemId)?.name || recipe.name;
        const requirements: Record<string, number> = { home: recipe.requiredHomeLevel, ...recipe.requiredBuildings };
        requirements[recipe.buildingId] = Math.max(requirements[recipe.buildingId] || 0, recipe.buildingLevel);
        const child = add({
          id: `r:${recipe.id}`, title: recipe.name,
          label: `${single ? outputLabel : "Партия"} · ${shortTime(recipe.seconds)}`,
          icon: single ? itemIcons[itemId] || "📦" : "📦", kind: "recipe", status: "active", phase: level,
          buildingId: recipe.buildingId, locationId: locationByBuilding.get(recipe.buildingId)?.id, level: recipe.buildingLevel, cost: cloneCost(recipe.cost), seconds: recipe.seconds,
          rewards: { ...recipe.rewards }, requirements, children: [],
          description: `${fishIngredients.length ? `Рыбный ингредиент по классу: ${fishIngredients.map(group => items.get(group.itemId)?.name ?? group.itemId).join(", ")}. Виды внутри нужного класса взаимозаменяемы. Быстрый выбор показывает собственных подходящих рыб; автозаполнение сначала берёт неуточнённый остаток, затем самые многочисленные виды. Только «Готовить» расходует выбранное. Более редкий класс автоматически не подставляется. ` : ""}${recipe.collection ? "После созревания нажмите «Собрать всё»: Мохлик заберёт все уже готовые ягоды за один подход. Общая серверная фаза сбора длится не менее 8 секунд и сохраняется после перезагрузки. Во время активной вылазки он занят, сбор ждёт возвращения. " : ""}${Object.keys(recipe.requiredRecipes).length ? `Для открытия произведите и заберите: ${Object.entries(recipe.requiredRecipes).map(([id, count]) => `${recipeResultName(id, catalog)} × ${count}`).join(", ")}. ` : ""}${recipe.rewards.fish_soup && catalog.food ? `Рыбный суп даёт Мохлику +${(catalog.food.meals.find(meal => meal.itemId === "fish_soup")?.heroSpeedBps ?? 0) / 100}% скорости одной вылазки и строителю +${(catalog.food.meals.find(meal => meal.itemId === "fish_soup")?.builderSpeedBps ?? 0) / 100}% скорости одной стройки; шахтёра не ускоряет. ` : ""}В карточке рисунок и название предмета стоят рядом, ниже время и необходимые материалы с нехваткой. Одиночный результат не повторяет «×1», соседние карточки выровнены. ${fishIngredients.length ? "Нажатие открывает выбор рыб и подтверждение готовки." : "Нажатие сразу запускает производство."} Незавершённую работу можно отменить вторым нажатием в её ячейке в течение 5 секунд после «Удалить?» с возвратом потраченного; таймаут ничего не отменяет. Живой таймер показывает секунды в MM:SS или H:MM:SS без повторных «Осталось» и «Ещё». Он идёт и после закрытия приложения; готовый результат нужно забрать. Каждый запуск выпускает один предмет и занимает отдельное место до получения. Изначально место одно; второе открывается за ${formatPearls(catalog.productionSlots.upgrades[0].pricePearls)} жемчужин с дома ${catalog.productionSlots.upgrades[0].requiredHomeLevel}, третье за ${formatPearls(catalog.productionSlots.upgrades[1].pricePearls)} с дома ${catalog.productionSlots.upgrades[1].requiredHomeLevel}. Перед получением проверьте место в кладовой.`,
        });
        node.children.push(child.id);
        edge(node.id, child.id, "unlock");
      }
    }
    for (const exploration of catalog.explorations.filter(value => value.requiredHomeLevel === level)) {
      const mineLevel = exploration.requiredBuildings.quarry;
      add({
        id: `e:${exploration.id}`, title: exploration.name, label: `${routeLabels[exploration.id] || exploration.name} · ${shortTime(exploration.seconds)}`,
        icon: exploration.id.includes("shore") ? "🎣" : exploration.id.includes("cave") || exploration.id.includes("quarry") ? "⛏️" : exploration.id === "coastal_deposits" ? "🏖️" : "🧭",
        kind: "exploration", status: "active", phase: level,
        ...(mineLevel ? { buildingId: "quarry", locationId: "place:quarry", level: mineLevel } : {}), cost: cloneCost(exploration.cost), seconds: exploration.seconds,
        rewards: { ...exploration.rewards }, requirements: { home: exploration.requiredHomeLevel, ...exploration.requiredBuildings }, children: [], description: `${exploration.description} ${exploration.activity === "mining" ? "Шахтёр выполняет одну работу в собственной очереди; Мохлик свободен для других занятий. Обед Мохлика эту добычу не ускоряет." : "Мохлик выполняет одну вылазку. Еду для ускорения можно выбрать в отдельной ячейке; только явное кормление расходует одну порцию."} Подготовка показывает находки, время и необходимые припасы; выполненные условия скрыты. У начатой работы остаются результат, секундный таймер MM:SS или H:MM:SS и действия без повторной подготовки. Таймер идёт и после закрытия приложения. Находки нужно получить, освободив место в кладовой.${catalog.fishing?.routeIds.includes(exploration.id) ? ` Снасти определяют ${catalog.fishing.collectionDrawsByRoute[exploration.id] ?? 1} попыток выбора класса и вида — по одной на каждую рыбу; редкий улов не гарантирован.` : ""}`,
      });
    }
  }

  // Character mining is opened by the mine, so its levels keep visible unlocks
  // even though those activities are no longer passive production recipes.
  for (const route of nodes.filter(node => node.kind === "exploration" && node.buildingId === "quarry")) {
    const parent = byId.get(buildingNodeId("quarry", route.level!));
    if (parent) { parent.children.push(route.id); edge(parent.id, route.id, "unlock"); }
  }

  // A producer may start later than its own level number: quarry 1 and kiln 1 need home 2.
  // Group recipes with the phase of their actual producer, including additional AND gates.
  const phaseCache = new Map<string, number>();
  const phasePending = new Set<string>();
  function phaseFor(node: ProgressionNode): number {
    const cached = phaseCache.get(node.id);
    if (cached !== undefined) return cached;
    if (phasePending.has(node.id)) throw new Error(`Cyclic progression requirements: ${node.id}`);
    phasePending.add(node.id);
    let phase = node.phase;
    for (const [buildingId, level] of Object.entries(node.requirements)) {
      const prerequisite = byId.get(buildingNodeId(buildingId, level));
      if (prerequisite && prerequisite !== node) phase = Math.max(phase, phaseFor(prerequisite));
    }
    phasePending.delete(node.id);
    phaseCache.set(node.id, phase);
    return phase;
  }
  for (const node of nodes.filter(value => ["building", "recipe", "exploration"].includes(value.kind))) node.phase = phaseFor(node);
  for (const location of progressionLocations) {
    const node = byId.get(location.id)!;
    for (const buildingId of location.buildingIds) {
      const childId = buildingNodeId(buildingId, 1);
      if (!byId.has(childId)) continue;
      node.children.push(childId);
      edge(node.id, childId, "contains");
    }
  }

  fixed("claimed", catalog.market.requiredExplorations > 0 ? `Любая ${catalog.market.requiredExplorations} вылазка` : "Завершённые вылазки", "✅", 1,
    `Завершить исследование или рыбалку и получить награду. ${catalog.market.requiredExplorations > 0 ? `Для рынка нужно завершённых вылазок: ${catalog.market.requiredExplorations}.` : "Рынок открывается восстановлением моста, дополнительная вылазка для него не требуется."} Рабочие смены в шахте этот счётчик не повышают.`, "milestone");
  const market = fixed("market", "Рынок игроков", "⚖️", catalog.market.requiredHomeLevel, `Личная витрина: до ${catalog.market.showcaseSlots} лотов, до ${catalog.market.showcasePerSeller} от продавца, смена раз в ${catalog.market.showcaseRefreshSeconds / 60} минут. Купленные лоты не заменяются до смены. Продавцу бесплатно доступны ${catalog.market.baseSlots} мест; дополнительные покупаются по очереди до ${catalog.market.maxListings}: ${catalog.market.slotPricesPearls.map((price, index) => `${catalog.market.baseSlots + index + 1}-е — ${formatPearls(price)} жемчужин`).join("; ")}. Можно покупать открытые товары: одного уровня дома недостаточно, нужны условия источника. Открытие сохраняется после продажи запасов и недоступности источника. Цена от полной базовой стоимости до ${catalog.market.maxPriceMultiplier}×; комиссия новых лотов ${catalog.market.feeBps / 100}%. Дома 2–3 и 4–5 торгуют в своих группах. Суточные покупки и продажи отдельно ограничены базовой стоимостью товаров. Перед рыбным объявлением выберите подходящие виды вручную или автозаполнением. Только «Выставить лот» сохраняет точный состав партии; снятие или истечение возвращает те же виды. Покупка не открывает личную коллекцию. Рынок дополняет собственное производство; покупатель не гарантирован.`, "market");
  market.requirements = { home: catalog.market.requiredHomeLevel, ...catalog.market.requiredBuildings,
    ...(catalog.market.requiredExplorations > 0 ? { completedExplorations: catalog.market.requiredExplorations } : {}) };
  market.description = `${Object.keys(catalog.market.requiredBuildings ?? {}).length ? `Сначала восстановите и получите: ${Object.entries(catalog.market.requiredBuildings).map(([id, level]) => `${buildingLabels[id] ?? id} ${level}`).join(", ")}. ` : ""}${market.description}`;
  market.description += " После дома 3 при открытом рынке доступен отдельный обмен реликвиями 1:1, без монет и жемчуга. Обычные объявления реликвии не принимают. Один успешный обмен в сутки UTC на каждого участника; дом 3 отдельно, дома 4–5 вместе.";
  edge(buildingNodeId("home", catalog.market.requiredHomeLevel), market.id);
  for (const [id, level] of Object.entries(catalog.market.requiredBuildings ?? {})) edge(buildingNodeId(id, level), market.id);
  if (catalog.market.requiredExplorations > 0) edge("claimed", market.id);

  for (const node of nodes.filter(value => ["building", "recipe", "exploration"].includes(value.kind))) {
    if (node.id === "b:home:1") edge("start", node.id, "available");
    for (const [buildingId, requiredLevel] of Object.entries(node.requirements)) {
      const source = buildingNodeId(buildingId, requiredLevel);
      // Producer -> recipe is already its unlock edge, while all other gates are AND requirements.
      if (node.kind === "recipe" && buildingId === node.buildingId && requiredLevel === node.level) continue;
      edge(source, node.id);
    }
    if (node.kind === "exploration" && !node.id.startsWith("e:quarry_")) edge(node.id, "claimed", "any");
  }

  if (catalog.rareDrops) {
    const rare = catalog.rareDrops, meanHours = (rare.minSeconds + rare.maxSeconds) / 7200;
    const source = fixed("rare_materials", "Реликвии исследований", "", rare.requiredHomeLevel,
      `После дома ${rare.requiredHomeLevel} подтверждённые часы вылазок Мохлика, включая рыбалку, и работы шахтёра двигают два отдельных счётчика — по одному на персонажа. Типы реликвий используют общий счётчик внутри очереди своего персонажа. Сервер выбирает порог от ${rare.minSeconds / 3600} до ${rare.maxSeconds / 3600} часов, в среднем ${meanHours} часов, и один из ${rare.itemIds.length} равновероятных типов. Находка выдаётся при получении пересёкшей порог работы; перерасход переносится в очередь того же персонажа. Длинный маршрут учитывает свою длительность, короткий не даёт дополнительного розыгрыша. Отмена не двигает счётчик и не меняет результат. Конкретный тип не гарантирован случайной добычей.${thirdStage && Object.keys(thirdStage.completionRewards).length ? ` Отдельно завершение проекта дома 3 гарантирует ${Object.entries(thirdStage.completionRewards).map(([id, count]) => `${items.get(id)?.name ?? id} × ${count}`).join(", ")}; этот путь к дому 4 не зависит от случайной находки.` : ""} Седьмой ежедневный подарок даёт древнее ядро. Реликвии можно обменивать между игроками, купить или продать за монеты нельзя.`, "acquisition");
    source.requirements = { home: rare.requiredHomeLevel };
    source.rareDrops = { ...rare, itemIds: [...rare.itemIds] };
    edge(buildingNodeId("home", rare.requiredHomeLevel), source.id);
    for (const route of catalog.explorations) edge(`e:${route.id}`, source.id, "any");
  }

  if (catalog.fishing) {
    const fishing = catalog.fishing;
    const routes = catalog.explorations.filter(route => fishing.routeIds.includes(route.id));
    const home = Math.min(...routes.map(route => route.requiredHomeLevel));
    const source = fixed("fishing_species", "Классы рыбы из улова", "🐟", home,
      "Каждая рыба получает класс с учётом снастей, затем равновероятный вид внутри класса. В кладовой, рецептах и заказах используются пять классов; конкретный класс не гарантирован. Рыбу также можно купить у Плёски, но покупка не открывает коллекцию. Легендарный улов открывает легендарная удочка. Крючок и наживка усиливают свой класс. Известные оставшиеся виды можно выбирать для готовки и заказов; старый классовый остаток показан без указания вида. Автозаполнение сначала берёт такой остаток, затем самые многочисленные виды. Личная запись в книге сохраняется после продажи или приготовления улова.", "acquisition");
    source.requirements = { home };
    source.fishingSource = { itemIds: fishing.classes.map(group => group.itemId), routeIds: routes.map(route => route.id) };
    edge(buildingNodeId("home", home), source.id);
    for (const route of routes) edge(`e:${route.id}`, source.id, "any");
  }

  for (const node of nodes) {
    for (const itemId of Object.keys(node.cost?.items || {})) {
      const source = getProgressionResourceSource({ nodes, edges }, itemId);
      if (!source) throw new Error(`No progression source for resource ${itemId}`);
      edge(source.id, node.id, "cost");
    }
    if (node.cost?.coins) edge("coins", node.id, "cost");
  }

  for (const [id, label, icon, description, kind] of worldDefinitions) fixed(id, label, icon, 6, description, kind);
  if (catalog.food) {
    const orders = catalog.food.orders;
    const heroSpeeds = catalog.food.meals.map(meal => meal.heroSpeedBps / 100), builderSpeeds = catalog.food.meals.map(meal => meal.builderSpeedBps / 100);
    fixed("orders", "Доска заказов", "📜", 6,
      `${orders.slots} обычные просьбы с именами заказчиков: Плёске нужен улов и блюда, Шишколапу — материалы. После сдачи новая карточка появляется сразу. Варианты разнообразны и используют постоянно открытые товары. Текущие просьбы различаются, недавно снятые откладываются. Каждые ${orders.replacementWindowSeconds / 3600} часов доступны ${orders.freeReplacements} бесплатные замены; следующие стоят по ${formatPearls(orders.replacementPricePearls)} жемчужин с подтверждением. Доска обновляется через ${orders.refreshSeconds / 3600} часов. Отдельно идут четыре учебных задания и ${secondStageCount} постоянных просьб дома 2, включая улов и жареную рыбу. Все нужны перед новым домом 3.${thirdStage ? ` Для дома 4 нужен проект из ${thirdStage.orders.length} поставок: первая сразу, остальные через ${thirdStage.intervalSeconds / 3600} ч после сдачи предыдущей. Смена суток UTC и жемчуг интервал не сокращают. Ожидание между всеми поставками: ${shortTime((thirdStage.orders.length - 1) * thirdStage.intervalSeconds)}; строительство дома считается отдельно; последняя поставка гарантирует ${Object.entries(thirdStage.completionRewards).map(([id, count]) => `${items.get(id)?.name ?? id} × ${count}`).join(", ")}.` : ""} Постоянные просьбы не истекают и не заменяются. Заказ с сырой рыбой открывает подходящие виды и автозаполнение; только «Отдать заказ» списывает товары. Это действует и в постоянных учебных и проектных просьбах, сохраняя классы, количества и выплаты. Обычные заказы дают монеты; сытость отдельно.`);
    fixed("meals", "Еда и сытость", "🍲", 6,
      `Порцию можно съесть рядом с таймером вылазки или отдать строителю. Сила зависит от блюда: Мохлик +${Math.min(...heroSpeeds)}–${Math.max(...heroSpeeds)}%, строитель +${Math.min(...builderSpeeds)}–${Math.max(...builderSpeeds)}% скорости. Есть блюда из обычной, необычной, редкой, эпической и легендарной рыбы. В идущей стройке ускоряется только остаток. Эффекты не складываются, не убывают офлайн и не меняют шанс рыбы. Обед Мохлика не ускоряет независимую добычу шахтёра. Заказ жителя не кормит персонажа.`);
    edge("start", "orders", "available"); edge("campfire", "meals", "flow");
    edge("orders", "coins", "flow");
    for (const recipe of catalog.recipes.filter(recipe => catalog.food!.meals.some(meal => recipe.rewards[meal.itemId]))) {
      edge(`r:${recipe.id}`, "meals", "flow"); edge(`r:${recipe.id}`, "orders", "flow");
    }
  }
  byId.get("achievements")!.description += ` За самостоятельно полученные ступени можно вручную забрать до ${formatPearls(achievementPearls)} жемчужин суммарно, каждую награду только один раз. Администраторская выдача достижения не создаёт валютную награду.`;
  if (fourthStage) {
    const orders = byId.get("orders");
    if (orders) orders.description += ` Дом 5 требует ${fourthStage.orders.length} поставок с интервалом ${fourthStage.intervalSeconds / 3600} ч. Жители однократно финансируют развитие дальнего берега и хозяйства: ${fourthStage.orders.reduce((sum, order) => sum + order.coins, 0)} монет за весь проект. Финал гарантирует ${Object.entries(fourthStage.completionRewards).map(([id, count]) => `${items.get(id)?.name ?? id} × ${count}`).join(", ")}. Для завершения нужны восстановленные объекты и полученный результат исследования руин; запуск или отмена не засчитываются.`;
    const rare = byId.get("rare_materials");
    if (rare) rare.description += ` Проект дома 4 отдельно гарантирует ${Object.entries(fourthStage.completionRewards).map(([id, count]) => `${items.get(id)?.name ?? id} × ${count}`).join(", ")}; переход к дому 5 не зависит от случайного вида реликвии.`;
  }
  for (const course of catalog.stageOrders ?? []) {
    const home = byId.get(buildingNodeId("home", course.homeLevel + 1));
    if (!home) continue;
    home.description += ` Перед новой стройкой завершите все ${course.orders.length} поставок проекта текущего дома.`;
    for (const order of course.orders) for (const [routeId, count] of Object.entries(order.requiredExplorations ?? {})) {
      edge(`e:${routeId}`, home.id);
      home.description += ` Получите результат «${catalog.explorations.find(route => route.id === routeId)?.name ?? routeId}» × ${count}.`;
    }
  }
  edge("achievements", "pearls", "flow");
  edge("start", "pleska", "available");
  edge("pleska", "fishing_catches", "flow");
  for (const id of catalog.fishing?.routeIds ?? []) edge("pleska", `e:${id}`, "flow");
  edge("start", "living", "available");
  for (const id of ["wildlife", "bridge_ruin", "lighthouse_ruin"]) edge("living", id, "available");
  edge("bush", "living", "flow"); edge("campfire", "living", "flow");
  edge("start", "album", "available"); edge("start", "wardrobe", "available");
  edge("album", "travel_book", "flow"); edge("album", "fishing_catches", "flow"); edge("album", "quarry_book", "flow");
  edge("wardrobe", "explorer_cap", "flow"); edge("fishing_catches", "willow_rod", "flow");
  edge("place:quarry", "quarry_book", "flow");
  for (const [source, target] of [
    ["start", "life_marks"], ["life_marks", "day_streak"], ["day_streak", "calendar_gifts"], ["day_streak", "achievements"],
    ["start", "taps"], ["taps", "player_level"], ["taps", "tap_streak"], ["taps", "leaderboard"], ["tap_streak", "leaderboard"],
    ["taps", "achievements"], ["tap_streak", "achievements"], ["album", "achievements"], ["claimed", "achievements"], ["market", "achievements"],
  ]) edge(source, target, "flow");

  for (const [id, title, icon, description] of projectDefinitions) fixed(id, title, icon, 7, description, "project", "plan");
  edge("place:quarry", "mine_interior", "plan");
  edge("start", "public_profiles", "available"); edge("achievements", "public_profiles", "flow");
  edge("album", "public_profiles", "flow"); edge("public_profiles", "friend_glade", "plan");
  edge("pleska", "pleska_home", "plan");
  edge("pearls", "pearl_trader", "plan");
  if (catalog.rareDrops) edge("rare_materials", "pearl_trader", "plan");
  edge("bridge_ruin", "bridge", "available"); edge("lighthouse_ruin", "lighthouse", "available");
  for (const [source, target] of [
    ["r:make_planks", "bridge"], ["r:make_rope", "bridge"], ["r:make_tools", "bridge"], ["bridge", "far_bank"],
    ["far_bank", "regional_trips"], ["regional_trips", "new_finds"], ["new_finds", "album"], ["r:make_beams", "shore_site"],
    ["shore_site", "boat"], ["boat", "port"], ["r:make_beams", "lighthouse"], ["r:make_glass", "lighthouse"],
    ["r:make_metal_parts", "lighthouse"], ["b:lighthouse:1", "ships"], ["ships", "sea_trips"],
    ["sea_trips", "new_finds"], ["r:grow_berries", "new_fruits"],
    ["r:make_rope", "tackle"], ["tackle", "sea_trips"],
  ]) edge(source, target, "plan");

  for (const value of edges) {
    if (!byId.has(value.source) || !byId.has(value.target)) throw new Error(`Unknown progression edge endpoint: ${value.id}`);
  }
  return { nodes, edges };
}

export const progressionGraph = buildProgressionGraph();

/** Shared by graph costs and UI source links; chance sources never become recipes. */
export function getProgressionResourceSource(graph: ProgressionGraph, itemId: string): ProgressionNode | undefined {
  return graph.nodes.filter(node => node.rewards?.[itemId] || node.rareDrops?.itemIds.includes(itemId) || node.fishingSource?.itemIds.includes(itemId))
    .sort((a, b) => (a.requirements.home ?? 0) - (b.requirements.home ?? 0) || (a.level ?? 0) - (b.level ?? 0))[0];
}

/** Includes the selected node; flow/any/contains are informational, and proposals never gate an active node. */
export function getPrerequisiteIds(graph: ProgressionGraph, nodeId: string, includeCosts = true): Set<string> {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const selected = nodes.get(nodeId);
  if (!selected) return new Set();
  const incoming = new Map<string, ProgressionEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "flow" || edge.kind === "any" || edge.kind === "contains" || (!includeCosts && edge.kind === "cost")) continue;
    if (selected.status !== "plan" && (edge.kind === "plan" || nodes.get(edge.source)?.status === "plan")) continue;
    const values = incoming.get(edge.target) || [];
    values.push(edge);
    incoming.set(edge.target, values);
  }
  const seen = new Set([nodeId]);
  const pending = [nodeId];
  while (pending.length) {
    for (const edge of incoming.get(pending.pop()!) || []) {
      if (!nodes.has(edge.source) || seen.has(edge.source)) continue;
      seen.add(edge.source);
      pending.push(edge.source);
    }
  }
  return seen;
}
