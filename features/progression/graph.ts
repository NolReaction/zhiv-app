import { economyCatalog, type EconomyCatalog, type EconomyCost } from "@/features/economy/model";

export type ProgressionNodeKind = "location" | "building" | "recipe" | "exploration" | "world" | "collection" | "equipment" | "milestone" | "market" | "project";

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
  home: "Дом", garden: "Ягодный куст", woodlot: "Лесозаготовки", quarry: "Шахта", kiln: "Печь", workshop: "Верстак", dryer: "Заготовки у костра", warehouse: "Кладовая",
};
export const progressionLocations = [
  { id: "place:home", title: "Дом", icon: "🏠", buildingIds: ["home", "warehouse"], description: "Дом на полянке. Уровень дома открывает новые возможности хозяйства; кладовая расширяется отдельно внутри дома." },
  { id: "bush", title: "Ягодный куст", icon: "🫐", buildingIds: ["garden"], description: "Закажите выращивание: ягоды на кусте созревают по таймеру. По нажатию «Собрать» Мохлик принесёт урожай в корзинке, затем он поступит в кладовую. Полив сохраняет влажность, но не сокращает срок заказа." },
  { id: "place:woodlot", title: "Лесной участок", icon: "🌲", buildingIds: ["woodlot"], description: "Лес и существующий навес. Здесь обустраиваются лесозаготовки: сначала древесина и волокно, затем твёрдая древесина и смола." },
  { id: "place:workshop", title: "Мастерская", icon: "🛠️", buildingIds: ["workshop", "kiln"], description: "Одно здание мастерской: внутри отдельно развиваются верстак и печь. У каждого оборудования свои условия обустройства и рецепты." },
  { id: "campfire", title: "Костёр", icon: "🏕️", buildingIds: ["dryer"], description: "Существующий костёр служит местом отдыха и приготовления запасов. Заготовки еды развиваются здесь, без отдельного здания сушилки." },
  { id: "place:quarry", title: "Шахта", icon: "⛏️", buildingIds: ["quarry"], description: "Заброшенная шахта уже есть на карте. Добыча начинается после её открытия по условиям хозяйства. Интерьер и его мини-карта относятся к будущему этапу." },
] as const;
const locationByBuilding = new Map<string, typeof progressionLocations[number]>(progressionLocations.flatMap(location => location.buildingIds.map(id => [id, location] as const)));
const buildingIcons: Record<string, string> = { home: "🏠", garden: "🌱", woodlot: "🌲", quarry: "⛏️", kiln: "🔥", workshop: "🛠️", dryer: "♨️", warehouse: "📦" };
const itemIcons: Record<string, string> = {
  berries: "🫐", wood: "🪵", stone: "🪨", ore: "⛏️", fiber: "🌾", fish: "🐟", planks: "🪵", rope: "🪢", metal_parts: "⚙️", dried_berries: "🫐", smoked_fish: "🐟", clay: "🏺", sand: "⌛", charcoal: "🔥", iron_ingot: "🔩", bricks: "🧱", glass: "💎", hardwood: "🌳", resin: "🍯", cloth: "🧵", beams: "🏗️", tools: "🛠️", reinforced_parts: "⚙️", cut_stone: "🪨",
};
export const itemLabels: Record<string, string> = {
  berries: "Ягоды", wood: "Древесина", stone: "Камень", ore: "Руда", fiber: "Волокно", fish: "Рыба", planks: "Доски", rope: "Верёвка", metal_parts: "Метал. детали", dried_berries: "Сушёные ягоды", smoked_fish: "Копчёная рыба", clay: "Глина", sand: "Песок", charcoal: "Уголь", iron_ingot: "Слитки", bricks: "Кирпичи", glass: "Стекло", hardwood: "Твёрдая древесина", resin: "Смола", cloth: "Полотно", beams: "Балки", tools: "Инструменты", reinforced_parts: "Усиленные узлы", cut_stone: "Тёсаный камень",
};
export const progressionItemNames: Record<string, string> = Object.fromEntries(economyCatalog.items.map(item => [item.id, item.name]));

const recipeLabels: Record<string, string> = {
  garden_season: "Сад · 6ч", garden_supply: "Сад · 8ч", garden_abundance: "Сад · 8ч", woodlot_shift: "Лес · 6ч", hardwood_shift: "Лес · 8ч", woodland_shift: "Лес · 8ч", woodland_supply: "Лес · 8ч", quarry_shift: "Карьер · 8ч", quarry_deep_face: "Карьер · 8ч", quarry_supply: "Карьер · 8ч", workshop_overnight: "Материалы · 8ч", workshop_materials: "Материалы · 6ч", workshop_structures: "Строймат. · 8ч", workshop_assembly: "Сборка · 8ч", prepare_provisions: "Припасы · 6ч", prepare_expedition_provisions: "Припасы · 8ч", provisions_supply: "Припасы · 8ч", kiln_shift: "Плавка · 8ч", kiln_supply: "Печь · 12ч",
};
const routeLabels: Record<string, string> = { forest: "Лесная разведка", shore: "Берег", forest_camp: "Лес · 8ч", shore_camp: "Берег · 8ч", cave: "Пещера", deep_cave: "Глубокий проход", old_woodland: "Старый лес", coastal_deposits: "Отложения", uplands: "Нагорье", abandoned_quarry: "Заброш. карьер" };
const productionOrder = ["garden", "woodlot", "quarry", "kiln", "workshop", "dryer", "warehouse"];
const initialBuildings = new Set(["home", "garden", "warehouse"]);
const buildingNodeId = (id: string, level: number) => `b:${id}:${level}`;
const cloneCost = (cost: EconomyCost): EconomyCost => ({ coins: cost.coins, items: { ...cost.items } });
const shortTime = (seconds: number) => seconds % 3600 === 0 ? `${seconds / 3600} ч` : `${seconds / 60} мин`;

type WorldDefinition = [id: string, label: string, icon: string, description: string, kind?: ProgressionNodeKind];
const worldDefinitions: WorldDefinition[] = [
  ["living", "Живая поляна", "🌿", "Мохлик выбирает занятия, отдыхает, спит, встречает живность и запоминает состояние полянки. Эта жизнь развивается отдельно от серверного хозяйства."],
  ["wildlife", "Птицы и живность", "🦋", "Птицы, бабочки и светлячки взаимодействуют с полянкой. Они не являются производством ресурсов."],
  ["bridge_ruin", "Мост · уровень 0", "🌉", "Существующий разрушенный мост на карте. Для него пока нет экономической стройки, действующего перехода на другой берег или игровых требований восстановления."],
  ["lighthouse_ruin", "Маяк · уровень 0", "🔦", "Существующий маяк на карте. Рисунок следующего состояния можно примерить в редакторе, но это ещё не игровое восстановление и не доступ к кораблям."],
  ["album", "Коллекции", "📖", "Ранее полученные лесные и речные находки сохранены. Новые экономические вылазки сейчас дают товары для склада; новые находки для альбомов относятся к будущей ветке.", "collection"],
  ["forest_set", "6 лесных находок", "🍃", "Шесть разных находок лесной коллекции открывают шляпу следопыта. Сохранённое правило коллекции.", "collection"],
  ["river_set", "6 речных находок", "🐚", "Шесть разных речных находок открывают ивовую удочку. Сохранённое правило коллекции.", "collection"],
  ["explorer_cap", "Шляпа следопыта", "👒", "Награда за полную лесную коллекцию. Полученную вещь можно надеть.", "equipment"],
  ["willow_rod", "Ивовая удочка · гардероб", "🎣", "Награда прежнего гардероба за полную речную коллекцию. Это отдельная вещь от рыбацкой удочки, которую продаёт Плёска: награда альбома не открывает купленную снасть.", "equipment"],
  ["wardrobe", "Гардероб", "🧣", "Полученные вещи можно надевать. Создание новых вещей через прежний крафт сейчас отключено.", "equipment"],
  ["full_collection", "Все 12 находок", "🏅", "Полная лесная и речная коллекция связана с достижением за все 12 находок.", "collection"],
  ["life_marks", "Отметки жизни", "💚", "Подтверждённые отметки жизни поддерживают дневную серию. Это отдельная ветка от строительства и производства."],
  ["day_streak", "Серия дней", "📅", "Следующая отметка продлевает серию, если между отметками прошло не больше 24 часов. Серия связана с календарными наградами и достижением за 7 дней."],
  ["calendar_gifts", "Подарки 3/7/14/30", "🎁", "Подарки за серию дней сохраняются: цветы, коврик, ящик находок и гирлянда. Их размещение и показ на текущей карте пока скрыты."],
  ["taps", "Игровые тапы", "👆", "Тапы увеличивают игровой счёт и участвуют в рейтингах. Они не начисляют монеты или ресурсы текущей экономики."],
  ["player_level", "Уровень игрока", "⭐", "Суммарный счёт тапов определяет игровой уровень 1–100 и значок. Этот уровень отличается от уровня дома и не открывает хозяйственные постройки."],
  ["tap_streak", "Серия тапов", "⚡", "Непрерывная серия тапов заканчивается после паузы 10 секунд. Она даёт лучший рекорд серии."],
  ["leaderboard", "Рейтинг и рекорды", "🏆", "Месячные тапы и лучшая непрерывная серия — две метрики рейтинга. Уровень по общему счёту не входит в эти рейтинги."],
  ["achievements", "Достижения", "🏅", "Достижения включают 7 дней серии отметок, 1000 суммарных тапов, 10 000 тапов за игру и полную коллекцию. Они не служат воротами экономического развития."],
  ["pleska", "Плёска · лавка и рыбалка", "🎣", "Открывается через «Ещё → Персонажи» или нажатием на жительницу берега. Плёска продаёт удочки, наживку и сырую рыбу. Стартовая удочка бесплатна; купленные снасти выбираются перед следующей вылазкой. Плёска покупает сырую рыбу по полной базовой цене. Её декоративная рыбалка не выдаёт игроку товары."],
  ["fishing_catches", "Коллекция пойманной рыбы", "🐟", "Четыре вида записываются после получения улова береговой вылазки. Купленная рыба не открывает коллекцию. Снасти и наживка повышают шанс необычного вида, но не гарантируют его; одна рыба в партии определяется серверным розыгрышем.", "collection"],
];

const projectDefinitions: WorldDefinition[] = [
  ["mine_interior", "Шахта: интерьер", "⛏️", "Будущий внутренний экран шахты с собственной мини-картой. Он не требуется для действующих заказов добычи: их результат определяется серверным таймером, без непрерывного присутствия Мохлика у шахты."],
  ["bridge", "Восстановить мост", "🌉", "На карте есть разрушенный мост уровня 0. Восстановление и проход ещё не реализованы."],
  ["far_bank", "Другой берег", "🗺️", "Предлагаемое открытие территории после восстановления моста."],
  ["regional_trips", "Новые территории", "🧭", "Предлагаемые региональные исследования за пределами нынешних маршрутов."],
  ["new_finds", "Новые находки", "🔍", "Будущее пополнение альбомов за новые исследования."],
  ["shore_site", "Личный берег", "🏖️", "Развитие собственного берега — задокументированное будущее направление."],
  ["boat", "Лодка", "🛶", "Предлагаемое продолжение ветки берега."],
  ["port", "Порт", "⚓", "Предлагаемый следующий этап лодки и берегового хозяйства."],
  ["lighthouse", "Восстановить маяк", "🔦", "Маяк есть в карте; рисунок уровня 1 доступен для примерки. Экономического восстановления и кораблей ещё нет."],
  ["ships", "Прибывающие корабли", "⛵", "Предлагаемая связь маяка и порта с прибытием кораблей."],
  ["sea_trips", "Морские экспедиции", "🌊", "Будущее направление экспедиций и маяка. Конкретные маршруты и награды ещё не утверждены."],
  ["orders", "Заказы жителей", "📜", "Будущие заказы жителей и торговца: применение продукции хозяйства."],
  ["new_fruits", "Новые плоды", "🍎", "Будущее расширение сада новыми плодами. Уровень сада для открытия ещё не выбран."],
  ["tackle", "Новые снасти", "🪝", "Будущее расширение мастерской и рыбалки новыми снастями. Уровень верстака для открытия ещё не выбран."],
  ["public_profiles", "Чужие профили", "👥", "План: смотреть уровень и достижения других игроков; позднее — их обустройство. Собственный уровень и достижения уже работают. Просмотр чужого хозяйства и его правила ещё не реализованы."],
  ["pleska_home", "Домик Плёски", "🏠", "Будущий домик жительницы. Место, внешний вид, уровни и игровые правила ещё не утверждены. Действующие лавка и рыбалка не требуют этой постройки."],
];

/** A read-only map of current game rules and explicitly separate world proposals. */
export function buildProgressionGraph(catalog: EconomyCatalog = economyCatalog): ProgressionGraph {
  const nodes: ProgressionNode[] = [];
  const edges: ProgressionEdge[] = [];
  const byId = new Map<string, ProgressionNode>();
  const edgeIds = new Set<string>();
  const items = new Map(catalog.items.map(item => [item.id, item]));

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

  fixed("start", "Начало", "🌱", 0, "Есть дом 1, ягодный куст 1 и кладовая 1, без монет и материалов. Закажите ягоды и через «В путь» отправьте Мохлика в бесплатную лесную разведку. Получите результаты; часть продайте, древесину, камень и волокно оставьте для стройки. Первые цели — лесозаготовки 1, верстак 1 и дом 2. Тапы не дают хозяйственную валюту.");
  fixed("trader", "Быстрая продажа", "🧑‍🌾", 0, `Продажа из кладовой с начала игры: ${100 - (catalog.localBuyer?.payoutBps ?? 10000) / 100}% уценки от базовой цены, итог стопки округляется вниз. Сырую рыбу выгоднее продать Плёске по полной базовой цене. Рынок игроков открывается позднее; покупатель там не гарантирован.`);
  fixed("coins", "Монеты", "🪙", 0, "Выручка за товары идёт на строительство и улучшения. Монеты не занимают место на складе.");
  fixed("pearls", "Жемчуг · ускорение", "◉", 0, `Можно сразу завершить текущую стройку: 1 жемчужина за каждые начатые ${catalog.constructionSpeedup.secondsPerPearl / 60} минут остатка. Цена подтверждается перед списанием. Бесплатный путь — дождаться таймера. Производство и вылазки не ускоряются; получение и покупка жемчуга ещё готовятся.`);
  edge("start", "trader", "available");
  edge("start", "pearls", "available");
  edge("trader", "coins", "flow");
  for (const location of progressionLocations) {
    fixed(location.id, location.title, location.icon, 0, location.description, "location");
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
        kind: "building", status: "active", phase: level, buildingId: building.id, locationId: locationByBuilding.get(building.id)?.id, level,
        cost: cloneCost(data.cost), seconds: data.seconds, requirements, children: [],
        description: `${initialBuildings.has(building.id) && level === 1 ? "Есть на старте. " : ""}${building.description}${building.id === "warehouse" ? " Каждая единица товара занимает место; монеты, жемчуг и удочки не занимают. Товар в объявлениях рынка продолжает занимать место. Перед получением результата может понадобиться освободить склад." : " В хозяйстве идёт только одна стройка. Заказ этого оборудования нужно забрать перед его улучшением."}`,
        ...(data.warehouseCapacity != null ? { warehouseCapacity: data.warehouseCapacity } : {}),
      });
      for (const recipe of catalog.recipes.filter(value => value.buildingId === building.id && value.buildingLevel === level)) {
        const outputs = Object.keys(recipe.rewards), single = outputs.length === 1, itemId = outputs[0];
        const outputLabel = itemLabels[itemId] || items.get(itemId)?.name || recipe.name;
        const requirements: Record<string, number> = { home: recipe.requiredHomeLevel, ...recipe.requiredBuildings };
        requirements[recipe.buildingId] = Math.max(requirements[recipe.buildingId] || 0, recipe.buildingLevel);
        const child = add({
          id: `r:${recipe.id}`, title: recipe.name,
          label: recipeLabels[recipe.id] || (single ? outputLabel + (recipe.seconds >= 14400 ? ` · ${shortTime(recipe.seconds)}` : "") : "Партия"),
          icon: single ? itemIcons[itemId] || "📦" : "📦", kind: "recipe", status: "active", phase: level,
          buildingId: recipe.buildingId, locationId: locationByBuilding.get(recipe.buildingId)?.id, level: recipe.buildingLevel, cost: cloneCost(recipe.cost), seconds: recipe.seconds,
          rewards: { ...recipe.rewards }, requirements, children: [],
          description: `${recipe.collection ? "После созревания нажмите «Собрать»: Мохлик принесёт урожай. Во время активной вылазки он занят — сбор ждёт возвращения. " : ""}Таймер идёт и после закрытия приложения; готовый результат нужно забрать. Одно оборудование выполняет один заказ. Партия: до ${recipe.maxBatch ?? catalog.maxBatch}; короткая переработка допускает очередь до двух часов, бесплатный сбор и длинные заказы — одну партию. Перед получением проверьте место в кладовой.`,
        });
        node.children.push(child.id);
        edge(node.id, child.id, "unlock");
      }
    }
    for (const exploration of catalog.explorations.filter(value => value.requiredHomeLevel === level)) {
      add({
        id: `e:${exploration.id}`, title: exploration.name, label: routeLabels[exploration.id] || exploration.name,
        icon: exploration.id.includes("shore") ? "🎣" : exploration.id.includes("cave") || exploration.id.includes("quarry") ? "⛏️" : exploration.id === "coastal_deposits" ? "🏖️" : "🧭",
        kind: "exploration", status: "active", phase: level, cost: cloneCost(exploration.cost), seconds: exploration.seconds,
        rewards: { ...exploration.rewards }, requirements: { home: exploration.requiredHomeLevel, ...exploration.requiredBuildings }, children: [], description: `${exploration.description} Мохлик выполняет одну вылазку; таймер идёт и после закрытия приложения. Находки нужно получить, освободив место в кладовой.${catalog.fishing?.routeIds.includes(exploration.id) ? " В рыбалке со снастями одна рыба заменяется серверным выбранным видом; редкий улов не гарантирован." : ""}`,
      });
    }
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

  fixed("claimed", `Любая ${catalog.market.requiredExplorations} вылазка`, "✅", 1, `Завершить любой маршрут и получить награду. Для рынка нужно завершённых вылазок: ${catalog.market.requiredExplorations}. Подходит любой маршрут, а не все десять.`, "milestone");
  const market = fixed("market", "Рынок игроков", "⚖️", catalog.market.requiredHomeLevel, `Личная витрина: до ${catalog.market.showcaseSlots} лотов, до ${catalog.market.showcasePerSeller} от продавца, смена раз в ${catalog.market.showcaseRefreshSeconds / 60} минут. Купленные лоты не заменяются до смены. Товары доступны с уровня дома, необходимого для их источника: свою мастерскую иметь необязательно. Цена не ниже полной базовой стоимости. Рынок дополняет собственное производство; покупатель не гарантирован.`, "market");
  market.requirements = { home: catalog.market.requiredHomeLevel, completedExplorations: catalog.market.requiredExplorations };
  edge(buildingNodeId("home", catalog.market.requiredHomeLevel), market.id);
  if (catalog.market.requiredExplorations > 0) edge("claimed", market.id);

  for (const node of nodes.filter(value => ["building", "recipe", "exploration"].includes(value.kind))) {
    if (node.id === "b:home:1") edge("start", node.id, "available");
    for (const [buildingId, requiredLevel] of Object.entries(node.requirements)) {
      const source = buildingNodeId(buildingId, requiredLevel);
      // Producer -> recipe is already its unlock edge, while all other gates are AND requirements.
      if (node.kind === "recipe" && buildingId === node.buildingId && requiredLevel === node.level) continue;
      edge(source, node.id);
    }
    if (node.kind === "exploration") edge(node.id, "claimed", "any");
  }

  const sources = new Map(catalog.items.map(item => [item.id, nodes.filter(node =>
    (node.kind === "recipe" || node.kind === "exploration") && node.rewards?.[item.id],
  ).sort((a, b) => a.requirements.home - b.requirements.home || (a.level || 0) - (b.level || 0))]));
  for (const node of nodes) {
    for (const itemId of Object.keys(node.cost?.items || {})) {
      const source = sources.get(itemId)?.[0];
      if (!source) throw new Error(`No progression source for resource ${itemId}`);
      edge(source.id, node.id, "cost");
    }
    if (node.cost?.coins) edge("coins", node.id, "cost");
  }

  for (const [id, label, icon, description, kind] of worldDefinitions) fixed(id, label, icon, 6, description, kind);
  edge("start", "pleska", "available");
  edge("pleska", "fishing_catches", "flow");
  for (const id of catalog.fishing?.routeIds ?? []) edge("pleska", `e:${id}`, "flow");
  edge("start", "living", "available");
  for (const id of ["wildlife", "bridge_ruin", "lighthouse_ruin"]) edge("living", id, "available");
  edge("bush", "living", "flow"); edge("campfire", "living", "flow");
  edge("start", "album", "available"); edge("start", "wardrobe", "available");
  edge("album", "forest_set", "flow"); edge("album", "river_set", "flow");
  edge("forest_set", "explorer_cap"); edge("river_set", "willow_rod");
  edge("explorer_cap", "wardrobe", "flow"); edge("willow_rod", "wardrobe", "flow");
  edge("forest_set", "full_collection"); edge("river_set", "full_collection");
  for (const [source, target] of [
    ["start", "life_marks"], ["life_marks", "day_streak"], ["day_streak", "calendar_gifts"], ["day_streak", "achievements"],
    ["start", "taps"], ["taps", "player_level"], ["taps", "tap_streak"], ["taps", "leaderboard"], ["tap_streak", "leaderboard"],
    ["taps", "achievements"], ["tap_streak", "achievements"], ["full_collection", "achievements"],
  ]) edge(source, target, "flow");

  for (const [id, title, icon, description] of projectDefinitions) fixed(id, title, icon, 7, description, "project", "plan");
  byId.get("bridge")!.label = "Мост: ремонт";
  byId.get("lighthouse")!.label = "Маяк: ремонт";
  edge("place:quarry", "mine_interior", "plan");
  edge("player_level", "public_profiles", "plan"); edge("achievements", "public_profiles", "plan");
  edge("pleska", "pleska_home", "plan");
  edge("bridge_ruin", "bridge", "plan"); edge("lighthouse_ruin", "lighthouse", "plan");
  for (const [source, target] of [
    ["r:make_planks", "bridge"], ["r:make_rope", "bridge"], ["r:make_tools", "bridge"], ["bridge", "far_bank"],
    ["far_bank", "regional_trips"], ["regional_trips", "new_finds"], ["new_finds", "album"], ["r:make_beams", "shore_site"],
    ["shore_site", "boat"], ["boat", "port"], ["r:make_beams", "lighthouse"], ["r:make_glass", "lighthouse"],
    ["r:make_metal_parts", "lighthouse"], ["lighthouse", "ships"], ["port", "ships"], ["ships", "sea_trips"],
    ["sea_trips", "new_finds"], ["market", "orders"], ["ships", "orders"], ["r:grow_berries", "new_fruits"],
    ["r:make_rope", "tackle"], ["tackle", "sea_trips"],
  ]) edge(source, target, "plan");

  for (const value of edges) {
    if (!byId.has(value.source) || !byId.has(value.target)) throw new Error(`Unknown progression edge endpoint: ${value.id}`);
  }
  return { nodes, edges };
}

export const progressionGraph = buildProgressionGraph();

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
