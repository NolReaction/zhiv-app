import { economyCatalog, recipeBuildingLevel, type EconomyCatalog, type EconomyCost } from "@/features/economy/domain/model";
import { economyLocalSellPrice } from "@/features/economy/domain/local-sale";
import { pearlDisplayAmount } from "@/features/economy/domain/money";
import { constructionTimePearlPrice } from "@/features/economy/domain/rules";
import { currencyShopGoldOffers, GOLD_SHOP_PACKAGES, MAX_BUILDING_BONUS_PERCENT, PEARL_SHOP_PACKAGES } from "@/features/economy/domain/currency-shop";
import { storefrontCatalog } from "@/features/economy/domain/storefront";
import { VISIBLE_GAME_ACHIEVEMENTS } from "@/features/game/game-rewards";
import { sourceRetired, timeEconomyPolicy } from "./economy-sources";
import progressionRewards from "@/apps/api/src/main/resources/world/progression-rewards-catalog.json";

export type EconomyItemSource = {
  id: string;
  kind: "starter" | "recipe" | "exploration" | "fishing" | "rare" | "daily" | "project" | "shop";
  name: string;
  homeLevel: number;
  quantity?: number;
  seconds?: number;
  guaranteed: boolean;
  detail: string;
  recipeId?: string;
  routeId?: string;
  cost?: EconomyCost;
  /** Guaranteed outputs of the whole route; random fishing draws are excluded. */
  rewards?: Record<string, number>;
  requiredBuildings?: Record<string, number>;
  requiredRecipes?: Record<string, number>;
};
export type EconomyItemUse = {
  id: string;
  kind: "recipe" | "building" | "order" | "weekly" | "project" | "meal" | "fishing" | "exploration";
  name: string;
  quantity: number;
  homeLevel: number;
};
export type EconomyItem = EconomyCatalog["items"][number] & {
  npcSellPrice: number | null;
  kind: "inventory" | "fish-species" | "relic";
  inventoryItemId?: string;
  sources: EconomyItemSource[];
  uses: EconomyItemUse[];
  meal?: { heroSpeedBps: number; builderSpeedBps: number; heroWorkSeconds?: number };
};
export type EconomyRecipe = EconomyCatalog["recipes"][number] & {
  inputNpcValue: number;
  outputNpcValue: number;
  addedNpcValue: number;
  /** Theoretical output of the production timer alone, with all inputs supplied. */
  unitsPerHour: number;
  grossNpcPerHour: number;
  collectionSeconds: number;
  /** Includes the producer and every prerequisite, not just the direct home gate. */
  unlockHomeLevel: number;
};
export type EconomyStageOrder = {
  id: string; name: string; items: Record<string, number>; coins: number;
  inputNpcValue: number; addedNpcValue: number;
  requiredBuildings: Record<string, number>;
  requiredExplorations: Record<string, number>;
};
export type EconomyStage = {
  homeLevel: number;
  nextHomeLevel: number;
  buildings: { id: string; name: string; level: number; cost: EconomyCost; seconds: number; availableHomeLevel: number }[];
  buildingCoins: number;
  buildingItems: Record<string, number>;
  /** One builder's total queue, not a complete playthrough duration. */
  buildSeconds: number;
  orders: EconomyStageOrder[];
  orderCoins: number;
  orderItems: Record<string, number>;
  intervalSeconds: number;
  /** Only the waits between sequential deliveries. Does not include construction. */
  minimumGateSeconds: number;
  completionRewards: Record<string, number>;
  preliminary: boolean;
};
export type EconomyHomeUnlock = {
  homeLevel: number;
  berries: { itemId: string; recipeId: string }[];
  newItems: string[];
  recipes: string[];
  landmarks: { id: string; name: string; level: number; cost: EconomyCost; seconds: number }[];
};
export type RecipePlan = {
  recipeId: string;
  quantity: number;
  rawInputs: Record<string, number>;
  queues: { buildingId: string; seconds: number; collectionSeconds: number }[];
  steps: { recipeId: string; runs: number }[];
  miningSteps: { routeId: string; runs: number }[];
  coins: number;
  uncertainItemIds: string[];
  warnings: string[];
};

const addCounts = (target: Record<string, number>, source: Record<string, number>, multiplier = 1) => {
  for (const [id, count] of Object.entries(source)) target[id] = (target[id] ?? 0) + count * multiplier;
};
const copyCost = (cost: EconomyCost): EconomyCost => ({ coins: cost.coins, items: { ...cost.items } });

/** Use the same NPC valuation as a real sale; relics cannot be sold. */
function npcPrice(catalog: EconomyCatalog, itemId: string): number | null {
  const item = catalog.items.find(value => value.id === itemId);
  if (!item || !item.tradable) return null;
  return economyLocalSellPrice(item.baseSellPrice, 1, catalog.localBuyer, itemId);
}
function npcValue(catalog: EconomyCatalog, items: Record<string, number>): number {
  return Object.entries(items).reduce((sum, [id, count]) => sum + (npcPrice(catalog, id) ?? 0) * count, 0);
}

/** Stable baseline: the earliest recipe, before optional mastery variants. */
function baselineRecipe(catalog: EconomyCatalog, itemId: string) {
  const baseline = timeEconomyPolicy(catalog)?.baselineRecipes[itemId];
  return catalog.recipes.filter(recipe => !sourceRetired(recipe) && (recipe.rewards[itemId] ?? 0) > 0).sort((a, b) =>
    Number(b.id === baseline) - Number(a.id === baseline) || a.requiredHomeLevel - b.requiredHomeLevel || recipeBuildingLevel(a) - recipeBuildingLevel(b)
    || Object.keys(a.requiredRecipes ?? {}).length - Object.keys(b.requiredRecipes ?? {}).length
    || a.id.localeCompare(b.id))[0];
}

/** Follow real source gates, including a station's previous levels and recipe discoveries. */
function recipeUnlockHomes(catalog: EconomyCatalog): Map<string, number> {
  const buildingCache = new Map<string, number>(), recipeCache = new Map<string, number>(), pending = new Set<string>();
  function resolve(key: string, cache: Map<string, number>, compute: () => number) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (pending.has(key)) throw new Error(`Cyclic economy unlock: ${key}`);
    pending.add(key);
    const value = compute();
    pending.delete(key); cache.set(key, value);
    return value;
  }
  function buildingHome(id: string, level: number): number {
    if (id === "home") return level;
    return resolve(`building:${id}:${level}`, buildingCache, () => {
      const specs = catalog.buildings.find(building => building.id === id)?.levels.filter(spec => spec.level <= level) ?? [];
      return Math.max(1, ...specs.flatMap(spec => [spec.requiredHomeLevel,
        ...Object.entries(spec.requiredBuildings).map(([id, level]) => buildingHome(id, level))]));
    });
  }
  function recipeHome(id: string): number {
    return resolve(id, recipeCache, () => {
      const recipe = catalog.recipes.find(recipe => recipe.id === id);
      if (!recipe) return 1;
      return Math.max(recipe.requiredHomeLevel, buildingHome(recipe.buildingId, recipeBuildingLevel(recipe)),
        ...Object.entries(recipe.requiredBuildings).map(([id, level]) => buildingHome(id, level)),
        ...Object.keys(recipe.requiredRecipes ?? {}).map(recipeHome));
    });
  }
  for (const recipe of catalog.recipes) recipeHome(recipe.id);
  return recipeCache;
}

function buildHomeUnlocks(catalog: EconomyCatalog, recipes: EconomyRecipe[]): EconomyHomeUnlock[] {
  const firstHome = new Map<string, number>();
  for (const recipe of recipes) for (const id of Object.keys(recipe.rewards)) {
    firstHome.set(id, Math.min(firstHome.get(id) ?? Infinity, recipe.unlockHomeLevel));
  }
  return (catalog.buildings.find(building => building.id === "home")?.levels ?? []).map(home => ({
    homeLevel: home.level,
    berries: catalog.items.filter(item => item.category === "produce" && firstHome.get(item.id) === home.level).flatMap(item => {
      const recipe = recipes.find(recipe => recipe.buildingId === "garden" && recipe.rewards[item.id] && recipe.unlockHomeLevel === home.level);
      return recipe ? [{ itemId: item.id, recipeId: recipe.id }] : [];
    }),
    newItems: catalog.items.filter(item => firstHome.get(item.id) === home.level).map(item => item.id),
    recipes: recipes.filter(recipe => recipe.unlockHomeLevel === home.level).map(recipe => recipe.id),
    landmarks: catalog.buildings.filter(building => building.id === "bridge" || building.id === "lighthouse").flatMap(building => building.levels
      .filter(level => level.requiredHomeLevel === home.level)
      .map(level => ({ id: building.id, name: building.name, level: level.level, cost: copyCost(level.cost), seconds: level.seconds }))),
  }));
}

/**
 * Expand only production recipes. Free production becomes raw material and its
 * gathering queue is still counted. A free single-output mine job is counted in
 * its own queue. Multi-output travel, purchases and chance catches remain outside
 * acquisitions; no expected fishing time is invented.
 * Queues of different buildings may overlap; this is not a wall-clock estimate.
 */
export function calculateRecipePlan(recipeId: string, quantity = 1, catalog: EconomyCatalog = economyCatalog): RecipePlan {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) throw new RangeError("Quantity must be an integer from 1 to 999");
  const chosen = catalog.recipes.find(recipe => recipe.id === recipeId && !sourceRetired(recipe));
  if (!chosen) throw new RangeError(`Unknown recipe: ${recipeId}`);
  const rawInputs: Record<string, number> = {}, runsByRecipe = new Map<string, number>();
  const miningRuns = new Map<string, number>();
  const queues = new Map<string, { buildingId: string; seconds: number; collectionSeconds: number }>();
  const uncertain = new Set<string>(), outside = new Set<string>(), warnings = new Set<string>();
  let coins = 0;

  function run(recipe: EconomyCatalog["recipes"][number], runs: number, path: Set<string>) {
    coins += recipe.cost.coins * runs;
    const queue = queues.get(recipe.buildingId) ?? { buildingId: recipe.buildingId, seconds: 0, collectionSeconds: 0 };
    queue.seconds += recipe.seconds * runs;
    queue.collectionSeconds += (recipe.collection?.seconds ?? 0) * runs;
    queues.set(recipe.buildingId, queue);
    for (const [id, count] of Object.entries(recipe.cost.items)) expand(id, count * runs, path);
    // Insertion follows dependencies, even when an earlier ingredient has
    // already accumulated work for a later branch of the same recipe.
    runsByRecipe.set(recipe.id, (runsByRecipe.get(recipe.id) ?? 0) + runs);
  }
  function expand(itemId: string, count: number, path: Set<string>) {
    if (path.has(itemId)) {
      addCounts(rawInputs, { [itemId]: count }); uncertain.add(itemId);
      warnings.add(`Цикл рецептов: ${itemId}. Дальнейший расчёт этой ветки остановлен.`);
      return;
    }
    const recipe = baselineRecipe(catalog, itemId);
    if (!recipe) {
      addCounts(rawInputs, { [itemId]: count });
      const mining = catalog.explorations.filter(route => !sourceRetired(route) && route.activity === "mining" && route.rewards[itemId] === 1
        && Object.keys(route.rewards).length === 1 && route.cost.coins === 0 && !Object.keys(route.cost.items).length)
        .sort((a, b) => a.requiredHomeLevel - b.requiredHomeLevel || a.seconds - b.seconds || a.id.localeCompare(b.id))[0];
      if (mining) {
        miningRuns.set(mining.id, (miningRuns.get(mining.id) ?? 0) + count);
        const queue = queues.get("quarry") ?? { buildingId: "quarry", seconds: 0, collectionSeconds: 0 };
        queue.seconds += mining.seconds * count; queues.set("quarry", queue);
      } else { outside.add(itemId); uncertain.add(itemId); }
      if (!catalog.items.some(item => item.id === itemId)) warnings.add(`Неизвестный ингредиент: ${itemId}.`);
      return;
    }
    const runs = Math.ceil(count / recipe.rewards[itemId]);
    const free = recipe.cost.coins === 0 && !Object.keys(recipe.cost.items).length;
    if (free) addCounts(rawInputs, { [itemId]: count });
    run(recipe, runs, new Set([...path, itemId]));
  }

  run(chosen, quantity, new Set(Object.keys(chosen.rewards)));
  // For a freely gathered chosen item, show its own units as the raw material.
  if (!Object.keys(chosen.cost.items).length && chosen.cost.coins === 0) addCounts(rawInputs, chosen.rewards, quantity);
  if (outside.size) warnings.add("Добыча сырья вне производств не включена в очереди: маршрут выбирается отдельно; улов и конкретная реликвия не гарантированы.");
  warnings.add("Очереди показаны для одного места каждого производства. Разные производства могут работать параллельно; сбор урожая указан отдельно. Это не длительность прохождения.");
  warnings.add("Базовые рецепты выбраны по раннему открытию. Строительство, открытие рецептов и подготовка запасов для них в расчёт не входят.");
  return { recipeId, quantity, rawInputs, queues: [...queues.values()], steps: [...runsByRecipe].map(([id, runs]) => ({ recipeId: id, runs })),
    miningSteps: [...miningRuns].map(([routeId, runs]) => ({ routeId, runs })), coins, uncertainItemIds: [...uncertain], warnings: [...warnings] };
}

/** Required building closure: excludes optional storage and already-required previous stages. */
function requiredBuildings(catalog: EconomyCatalog, homeLevel: number) {
  const levels = new Map<string, number>();
  function requireBuilding(id: string, level: number) {
    if (id === "warehouse" || level <= (levels.get(id) ?? 0)) return;
    levels.set(id, level);
    const building = catalog.buildings.find(value => value.id === id);
    for (const spec of building?.levels.filter(value => value.level <= level) ?? []) {
      for (const [requiredId, requiredLevel] of Object.entries(spec.requiredBuildings)) requireBuilding(requiredId, requiredLevel);
      if (id !== "home" && spec.requiredHomeLevel > 1) requireBuilding("home", spec.requiredHomeLevel);
    }
  }
  requireBuilding("home", homeLevel);
  // These three buildings are already placed for a new household.
  levels.set("garden", Math.max(1, levels.get("garden") ?? 0));
  return levels;
}

function buildStages(catalog: EconomyCatalog): EconomyStage[] {
  const homes = catalog.buildings.find(building => building.id === "home");
  return (homes?.levels.filter(level => level.level > 1) ?? []).map(home => {
    const homeLevel = home.level - 1;
    const before = requiredBuildings(catalog, homeLevel), after = requiredBuildings(catalog, home.level);
    const buildings = catalog.buildings.flatMap(building => building.id === "warehouse" ? [] : building.levels
      .filter(level => level.level > (before.get(building.id) ?? 0) && level.level <= (after.get(building.id) ?? 0))
      .map(level => ({ id: building.id, name: building.name, level: level.level, cost: copyCost(level.cost), seconds: level.seconds,
        availableHomeLevel: level.requiredHomeLevel })));
    const course = catalog.stageOrders?.find(stage => stage.homeLevel === homeLevel);
    const terms = homeLevel === 1 ? [...(catalog.onboarding?.residentOrders ?? (catalog.onboarding ? [catalog.onboarding.residentOrder] : [])), ...(course?.orders ?? [])] : course?.orders ?? [];
    const orders: EconomyStageOrder[] = terms.map(order => ({ id: order.id, name: order.name, items: { ...order.items }, coins: order.coins,
      inputNpcValue: npcValue(catalog, order.items), addedNpcValue: order.coins - npcValue(catalog, order.items),
      requiredBuildings: { ...order.requiredBuildings }, requiredExplorations: { ...order.requiredExplorations } }));
    const buildingItems: Record<string, number> = {}, orderItems: Record<string, number> = {};
    for (const building of buildings) addCounts(buildingItems, building.cost.items);
    for (const order of orders) addCounts(orderItems, order.items);
    const intervalSeconds = course?.intervalSeconds ?? 0;
    return { homeLevel, nextHomeLevel: home.level, buildings, buildingCoins: buildings.reduce((sum, building) => sum + building.cost.coins, 0),
      buildingItems, buildSeconds: buildings.reduce((sum, building) => sum + building.seconds, 0), orders,
      orderCoins: orders.reduce((sum, order) => sum + order.coins, 0), orderItems, intervalSeconds,
      minimumGateSeconds: Math.max(0, orders.length - 1) * intervalSeconds, completionRewards: { ...course?.completionRewards }, preliminary: false };
  });
}

export function buildProgressionEconomy(catalog: EconomyCatalog = economyCatalog) {
  const fish = catalog.fishing;
  const species = new Map(fish?.fish.map(value => [value.itemId, value]) ?? []);
  const items: EconomyItem[] = catalog.items.map(item => ({ ...item, npcSellPrice: npcPrice(catalog, item.id),
    kind: item.category === "special" ? "relic" : species.has(item.id) ? "fish-species" : "inventory",
    ...(species.has(item.id) ? { inventoryItemId: fish?.classes.find(group => group.rarity === species.get(item.id)?.rarity)?.itemId } : {}),
    sources: [], uses: [] }));
  const byId = new Map(items.map(item => [item.id, item]));
  const addSource = (id: string, source: EconomyItemSource) => byId.get(id)?.sources.push(source);
  const addUse = (id: string, use: EconomyItemUse) => byId.get(id)?.uses.push(use);
  const unlockHomes = recipeUnlockHomes(catalog);
  const recipes: EconomyRecipe[] = catalog.recipes.filter(recipe => !sourceRetired(recipe)).map(recipe => {
    const inputNpcValue = npcValue(catalog, recipe.cost.items), outputNpcValue = npcValue(catalog, recipe.rewards);
    const count = Object.values(recipe.rewards).reduce((sum, value) => sum + value, 0);
    return { ...recipe, buildingLevel: recipeBuildingLevel(recipe), cost: copyCost(recipe.cost), rewards: { ...recipe.rewards }, requiredBuildings: { ...recipe.requiredBuildings }, requiredRecipes: { ...recipe.requiredRecipes },
      ...(recipe.collection ? { collection: { ...recipe.collection } } : {}), inputNpcValue, outputNpcValue,
      addedNpcValue: outputNpcValue - inputNpcValue - recipe.cost.coins, unitsPerHour: 3600 * count / recipe.seconds,
      grossNpcPerHour: 3600 * outputNpcValue / recipe.seconds, collectionSeconds: recipe.collection?.seconds ?? 0,
      unlockHomeLevel: unlockHomes.get(recipe.id) ?? recipe.requiredHomeLevel };
  });
  for (const [id, quantity] of Object.entries(catalog.onboarding?.startingItems ?? {})) addSource(id,
    { id: "starter", kind: "starter", name: "Стартовый запас", homeLevel: 1, quantity, guaranteed: true, detail: "Однократно при создании хозяйства." });
  for (const recipe of recipes) {
    for (const [id, quantity] of Object.entries(recipe.rewards)) addSource(id, { id: `recipe:${recipe.id}`, kind: "recipe", name: recipe.name,
      homeLevel: recipe.unlockHomeLevel, quantity, seconds: recipe.seconds, guaranteed: true, recipeId: recipe.id,
      cost: copyCost(recipe.cost), requiredBuildings: { ...recipe.requiredBuildings,
        [recipe.buildingId]: Math.max(recipe.buildingLevel, recipe.requiredBuildings[recipe.buildingId] ?? 0) },
      requiredRecipes: { ...recipe.requiredRecipes },
      detail: `${catalog.buildings.find(building => building.id === recipe.buildingId)?.name ?? recipe.buildingId}, уровень ${recipe.buildingLevel}. Один предмет за запуск; получение вручную.` });
    for (const [id, quantity] of Object.entries(recipe.cost.items)) addUse(id,
      { id: `recipe:${recipe.id}`, kind: "recipe", name: recipe.name, quantity, homeLevel: recipe.unlockHomeLevel });
  }
  for (const route of catalog.explorations.filter(route => !sourceRetired(route))) {
    const isFishing = fish?.routeIds.includes(route.id);
    // Route reward `fish` denotes random catches, never guaranteed common fish.
    for (const [id, quantity] of Object.entries(route.rewards)) {
      if (isFishing && id === "fish") continue;
      addSource(id, { id: `exploration:${route.id}`, kind: "exploration", name: route.name, homeLevel: route.requiredHomeLevel,
        quantity, seconds: route.seconds, guaranteed: true, routeId: route.id,
        cost: copyCost(route.cost), requiredBuildings: { ...route.requiredBuildings },
        rewards: Object.fromEntries(Object.entries(route.rewards).filter(([rewardId]) => !isFishing || rewardId !== "fish")),
        detail: `${route.activity === "mining" ? "Отдельная очередь шахтёра" : "Вылазка Мохлика"}. Набор гарантирован после успешного получения.` });
    }
    if (route.finds) {
      const total = route.finds.emptyWeight + route.finds.entries.reduce((sum, entry) => sum + entry.weight, 0);
      route.finds.entries.forEach((entry, index) => addSource(entry.itemId, {
        id: `find:${route.id}:${index}`, kind: "exploration", name: `${route.name} · дополнительная находка`, homeLevel: route.requiredHomeLevel,
        quantity: entry.quantity, seconds: route.seconds, guaranteed: false, routeId: route.id,
        cost: copyCost(route.cost), requiredBuildings: { ...route.requiredBuildings },
        detail: `Шанс ${(100 * entry.weight / total).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}% за завершённый поход. Одна дополнительная находка или ничего; в гарантированный производственный план не включается.`,
      }));
    }
    for (const [id, quantity] of Object.entries(route.cost.items)) addUse(id,
      { id: `route:${route.id}`, kind: "exploration", name: route.name, quantity, homeLevel: route.requiredHomeLevel });
  }
  if (fish) {
    for (const item of items.filter(value => species.has(value.id) || fish.classes.some(group => group.itemId === value.id))) {
      const rarity = species.get(item.id)?.rarity ?? fish.classes.find(group => group.itemId === item.id)!.rarity;
      const eligible = fish.rods.filter(rod => (rod.classOddsBps?.[rarity] ?? 0) > 0 && (rarity !== "legendary" || rod.rarity === "legendary"));
      const homeLevel = eligible.length ? Math.min(...eligible.map(rod => rod.requiredHomeLevel)) : 5;
      addSource(item.id, { id: `fishing:${rarity}`, kind: "fishing", name: "Рыбалка с подходящими снастями", homeLevel, guaranteed: false,
        detail: `${item.kind === "fish-species" ? "Вид хранится в запасе улова и подходит для именного рецепта, пока рыба не потрачена. Запись в книге сама по себе не является запасом. " : ""}Класс и вид разыгрываются для каждой рыбы. Время получения нужного улова не фиксировано. Подходящие удочки: ${eligible.map(rod => `${rod.name} (дом ${rod.requiredHomeLevel})`).join(", ") || "нет в текущем каталоге"}.` });
      if (item.kind === "fish-species") addUse(item.id, { id: "fish-class", kind: "fishing", name: `В кладовой: ${byId.get(item.inventoryItemId ?? "")?.name ?? rarity}`, quantity: 1, homeLevel });
    }
    for (const bait of fish.baits) {
      addSource(bait.itemId, { id: `shop:${bait.itemId}`, kind: "shop", name: "Лавка Плёски", homeLevel: bait.requiredHomeLevel, guaranteed: false,
        detail: `Цена ${bait.price} монет. Ассортимент меняется; наличие в текущей поставке не гарантировано.` });
      addUse(bait.itemId, { id: "bait", kind: "fishing", name: "Одна порция на одну рыбалку", quantity: 1, homeLevel: bait.requiredHomeLevel });
    }
  }
  for (const building of catalog.buildings) for (const level of building.levels) for (const [id, quantity] of Object.entries(level.cost.items)) addUse(id,
    { id: `building:${building.id}:${level.level}`, kind: "building", name: `${building.name} · ${level.level}`, quantity, homeLevel: level.requiredHomeLevel });
  const stages = buildStages(catalog);
  for (const stage of stages) {
    for (const order of stage.orders) for (const [id, quantity] of Object.entries(order.items)) addUse(id,
      { id: `project:${order.id}`, kind: "project", name: `${stage.homeLevel} → ${stage.nextHomeLevel}: ${order.name}`, quantity, homeLevel: stage.homeLevel });
    for (const [id, quantity] of Object.entries(stage.completionRewards)) addSource(id,
      { id: `project:${stage.homeLevel}`, kind: "project", name: `Завершение проекта ${stage.homeLevel} → ${stage.nextHomeLevel}`, homeLevel: stage.homeLevel, quantity, guaranteed: true,
        detail: `После всех ${stage.orders.length} поставок; интервалы между ними не ускоряются жемчугом.` });
  }
  for (const order of catalog.food?.orders.templates ?? []) for (const [id, quantity] of Object.entries(order.items)) addUse(id,
    { id: `order:${order.id}`, kind: "order", name: order.name, quantity, homeLevel: order.requiredHomeLevel });
  for (const weekly of catalog.tradeRelations?.weekly.templates ?? []) for (const stage of weekly.stages) for (const [id, quantity] of Object.entries(stage.items)) addUse(id,
    { id: `weekly:${weekly.id}:${stage.id}`, kind: "weekly", name: `${weekly.name}: ${stage.name}`, quantity, homeLevel: weekly.requiredHomeLevel });
  for (const meal of catalog.food?.meals ?? []) {
    const item = byId.get(meal.itemId);
    if (item) item.meal = { heroSpeedBps: meal.heroSpeedBps, builderSpeedBps: meal.builderSpeedBps, ...(meal.heroWorkSeconds ? { heroWorkSeconds: meal.heroWorkSeconds } : {}) };
    addUse(meal.itemId, { id: "meal", kind: "meal", name: `Обед: Мохлик +${meal.heroSpeedBps / 100}%, строитель +${meal.builderSpeedBps / 100}% скорости`, quantity: 1,
      homeLevel: unlockHomes.get(baselineRecipe(catalog, meal.itemId)?.id ?? "") ?? 1 });
  }
  if (catalog.rareDrops) for (const id of catalog.rareDrops.itemIds) addSource(id,
    { id: "rare", kind: "rare", name: "Редкая находка в исследованиях и шахте", homeLevel: catalog.rareDrops.requiredHomeLevel, guaranteed: false,
      detail: `Два независимых счётчика завершённой работы: ${catalog.rareDrops.minSeconds / 3600}–${catalog.rareDrops.maxSeconds / 3600} часов до находки. Конкретная реликвия случайна; это не календарный таймер и не обещание нужного предмета за этот срок.` });
  progressionRewards.daily.forEach((reward, index) => {
    for (const [id, quantity] of Object.entries(reward.items)) addSource(id,
      { id: `daily:${index + 1}`, kind: "daily", name: `Подарок ${index + 1} из ${progressionRewards.daily.length}`, homeLevel: 1, quantity, guaranteed: true,
        detail: `Получение вручную: следующая дата UTC и минимум ${progressionRewards.dailyMinimumHours} часов после предыдущего. Подарок не открывает неизвестную производственную цепочку.` });
  });
  // Species are collection identities. Their caught inventory class can satisfy
  // every class-based recipe/order; this does not imply a species-specific recipe.
  for (const item of items) if (item.inventoryItemId) {
    for (const use of byId.get(item.inventoryItemId)?.uses ?? []) item.uses.push({ ...use });
  }
  const marketSlotPrices = catalog.market.slotPricesPearls.map(pearlDisplayAmount);
  const step = catalog.constructionSpeedup.priceStepPearls;
  const points = catalog.constructionSpeedup.pricingPoints ?? [];
  const proportional = points.length >= 2 && points.every(point => point.pearls * points[0].seconds === points[0].pearls * point.seconds);
  return { catalogVersion: catalog.version, items, recipes, stages, homeUnlocks: buildHomeUnlocks(catalog, recipes),
    market: { homeLevel: catalog.market.requiredHomeLevel, requiredBuildings: { ...catalog.market.requiredBuildings },
      requiredExplorations: catalog.market.requiredExplorations },
    starter: { coins: catalog.onboarding?.startingWallet.coins ?? 0,
      pearls: pearlDisplayAmount(catalog.onboarding?.startingWallet.pearls ?? 0), items: { ...catalog.onboarding?.startingItems } },
    storage: (catalog.buildings.find(building => building.id === "warehouse")?.levels ?? []).map(level => ({ level: level.level,
      capacity: level.warehouseCapacity ?? 0, homeLevel: level.requiredHomeLevel, cost: copyCost(level.cost), seconds: level.seconds })),
    pearls: { dailyCycle: pearlDisplayAmount(progressionRewards.daily.reduce((sum, reward) => sum + reward.pearls, 0)),
      achievementLifetime: pearlDisplayAmount(Object.values(progressionRewards.achievementPearls).flat().reduce((sum, value) => sum + value, 0)),
      renewableWeeklyPearls: [...new Set((catalog.tradeRelations?.weekly.templates ?? []).map(template => pearlDisplayAmount(template.stages.reduce((sum, stage) => sum + (stage.pearls ?? 0), 0))))].filter(value => value > 0).sort((a, b) => a - b),
      dailyRewards: progressionRewards.daily.map((reward, index) => ({ step: index + 1, pearls: pearlDisplayAmount(reward.pearls) })),
      achievementRewards: VISIBLE_GAME_ACHIEVEMENTS.map(quest => ({ id: quest.id, title: quest.title, description: quest.description,
        tiers: quest.tiers.map((target, index) => ({ level: index + 1, target,
          pearls: pearlDisplayAmount(progressionRewards.achievementPearls[quest.id][index]) })) })),
      dailyMinimumHours: progressionRewards.dailyMinimumHours, dailyCycleLength: progressionRewards.daily.length,
      marketBaseSlots: catalog.market.baseSlots, marketSlotPrices, marketTotal: marketSlotPrices.reduce((sum, value) => sum + value, 0),
      productionSlots: catalog.productionSlots.upgrades.map(upgrade => ({ slots: upgrade.slots, pearls: pearlDisplayAmount(upgrade.pricePearls), requiredHomeLevel: upgrade.requiredHomeLevel })),
      construction: { stepPearls: pearlDisplayAmount(step), curved: points.length >= 2 && !proportional,
        secondsPerVisiblePearl: proportional ? points[0].seconds / pearlDisplayAmount(points[0].pearls) : null,
        prices: [60, 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400].map(seconds => ({ seconds,
          pearls: pearlDisplayAmount(constructionTimePearlPrice(seconds, catalog.constructionSpeedup)) })) } },
    currencyShop: { preview: true,
      pearlPackages: PEARL_SHOP_PACKAGES.map(pack => ({ ...pack, pearls: pearlDisplayAmount(pack.pearls) })),
      starterPacks: storefrontCatalog.starterPacks.map(pack => ({ ...pack,
        rewards: { ...pack.rewards, pearls: pearlDisplayAmount(pack.rewards.pearls), items: { ...pack.rewards.items } } })),
      costumeOffers: storefrontCatalog.costumeOffers.map(offer => ({ ...offer })),
      goldPrices: GOLD_SHOP_PACKAGES.map(pack => pearlDisplayAmount(pack.pearls)),
      productionBonusPercent: MAX_BUILDING_BONUS_PERCENT,
      goldByHome: (catalog.buildings.find(building => building.id === "home")?.levels ?? []).map(level => ({ homeLevel: level.level,
        offers: currencyShopGoldOffers({ catalog, buildings: { home: level.level } }).map(pack => ({ pearls: pearlDisplayAmount(pack.pearls), coins: pack.coins })) })),
      maximumGold: currencyShopGoldOffers({ catalog, buildings: Object.fromEntries(catalog.buildings.map(building => [building.id,
        Math.max(0, ...building.levels.map(level => level.level))])) }).at(-1)?.coins ?? 0 },
    fishingShop: fish ? { refreshSeconds: fish.shop.refreshSeconds, maximumRefreshPearls: pearlDisplayAmount(fish.shop.refreshPricePearls) } : null,
    orderBoard: { templates: catalog.food?.orders.templates.length ?? 0, slots: catalog.food?.orders.slots ?? 0,
      perResident: Boolean(catalog.tradeRelations),
      refreshSeconds: catalog.food?.orders.refreshSeconds ?? 0, freeReplacements: catalog.food?.orders.freeReplacements ?? 0,
      replacementPricePearls: pearlDisplayAmount(catalog.food?.orders.replacementPricePearls ?? 0) },
  };
}

export type EconomyData = ReturnType<typeof buildProgressionEconomy>;
export const progressionEconomy = buildProgressionEconomy();
