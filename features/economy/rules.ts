import { wardrobeItems, wardrobeOwned, wardrobePurchaseTarget } from "@/features/world/wardrobe";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_ITEMS, ECONOMY_CURRENCY_SCALE, ECONOMY_PEARL_SCALE, economyCatalog, type EconomyCommand, type EconomyCost, type EconomyJob, type EconomyState, type EconomyStorage } from "./model";
import { productionSlotCount, productionSlotOffer, productionStationSupported } from "./production-slots";

import { refreshFishingShop, fishingShopExpired } from "./fishing-shop";
import { fishingState, fishingTripCost, fishingCollectionDraws, selectFishingCatch } from "./fishing";
import { advanceEconomyProgression, newEconomyProgression } from "./collection-progress";
import { prepareRareDrop, settleRareDrop, secureRareInteger, type RareRandomInteger } from "./rare-drops";
import { economyLocalSellPrice } from "./local-sale";
import { economyActorConflict } from "./actor-availability";
export { economyLocalSellPrice, economyLocalSaleMinimumQuantity, economyLocalSaleLimit } from "./local-sale";

export class EconomyRuleError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
/** A display quote only: the authoritative command recomputes this from its own clock. */
export function constructionSpeedupPrice(job: Pick<EconomyJob, "kind" | "finishesAt">, now: number,
  config = economyCatalog.constructionSpeedup): number {
  if (job.kind !== "construction") return 0;
  return Math.ceil(Math.max(0, Date.parse(job.finishesAt) - now) / (config.secondsPerPearl * 1000)) * ECONOMY_PEARL_SCALE;
}
const fail = (code: string, message: string): never => { throw new EconomyRuleError(code, message); };
export function canAffordEconomy(state: Pick<EconomyState, "wallet" | "inventory">, cost: EconomyCost, quantity = 1) {
  return state.wallet.coins >= cost.coins * quantity && Object.entries(cost.items).every(([item, amount]) => (state.inventory[item] ?? 0) >= amount * quantity);
}
export function scaledEconomyCost(cost: EconomyCost, quantity: number): EconomyCost {
  return { coins: cost.coins * quantity, items: Object.fromEntries(Object.entries(cost.items).map(([item, amount]) => [item, amount * quantity])) };
}
export function unmetEconomyBuildings(state: Pick<EconomyState, "buildings">, requiredBuildings: Record<string, number> = {}) {
  return Object.entries(requiredBuildings).filter(([buildingId, level]) => (state.buildings[buildingId] ?? 0) < level)
    .map(([buildingId, requiredLevel]) => ({ buildingId, requiredLevel, currentLevel: state.buildings[buildingId] ?? 0 }));
}
export function economyStorage(state: Pick<EconomyState, "buildings" | "inventory">, reservedItems: Record<string, number> = {}): EconomyStorage {
  const warehouse = economyCatalog.buildings.find(building => building.id === "warehouse");
  const capacity = warehouse?.levels.find(level => level.level === (state.buildings.warehouse ?? 1))?.warehouseCapacity ?? 0;
  const used = Object.values(state.inventory).reduce((total, quantity) => total + quantity, 0);
  const reserved = Object.values(reservedItems).reduce((total, quantity) => total + quantity, 0);
  return { capacity, used, reserved, available: Math.max(0, capacity - used - reserved), overflow: Math.max(0, used + reserved - capacity) };
}
/** Escrow occupies storage too. Existing over-capacity inventories can shrink or move, never grow. */
export function assertEconomyStorageTransition(previous: Pick<EconomyState, "buildings" | "inventory">, next: Pick<EconomyState, "buildings" | "inventory">,
  previousReserved: Record<string, number> = {}, nextReserved: Record<string, number> = previousReserved) {
  const totals = { ...next.inventory };
  for (const [item, quantity] of Object.entries(nextReserved)) totals[item] = (totals[item] ?? 0) + quantity;
  if (Object.values(totals).some(quantity => quantity > ECONOMY_MAX_ITEMS)) fail("ECONOMY_CAPACITY", "Сначала освободите место для этого материала");
  const before = economyStorage(previous, previousReserved), after = economyStorage(next, nextReserved);
  if (after.used + after.reserved > after.capacity && after.used + after.reserved > before.used + before.reserved)
    fail("ECONOMY_STORAGE_FULL", "Склад заполнен. Продайте лишнее, используйте материалы или расширьте склад");
}
export function marketUnlocked(state: Pick<EconomyState, "buildings" | "completedExplorations">) {
  return (state.buildings.home ?? 1) >= economyCatalog.market.requiredHomeLevel && state.completedExplorations >= economyCatalog.market.requiredExplorations;
}
export function convertLegacyEconomy(resources: { sparks: number; wood: number; stone: number }) {
  const safe = (value: number) => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const wood = Math.sqrt(safe(resources.wood)), stone = Math.sqrt(safe(resources.stone));
  return { version: 1 as const, coinsGranted: ECONOMY_CURRENCY_SCALE * Math.min(500, Math.floor(2 * Math.sqrt(safe(resources.sparks)) + wood + stone)),
    woodGranted: Math.min(30, Math.floor(wood)), stoneGranted: Math.min(30, Math.floor(stone)) };
}
export function newEconomyState(legacy: { resources: { sparks: number; wood: number; stone: number }; houseLevel: number; workshopLevel: number }): EconomyState {
  const migration = convertLegacyEconomy(legacy.resources);
  return { currencyScale: ECONOMY_CURRENCY_SCALE, pearlScale: ECONOMY_PEARL_SCALE, wallet: { coins: migration.coinsGranted, pearls: 0 },
    inventory: { ...(migration.woodGranted ? { wood: migration.woodGranted } : {}), ...(migration.stoneGranted ? { stone: migration.stoneGranted } : {}) },
    buildings: Object.fromEntries(economyCatalog.buildings.map(building => [building.id, building.id === "home" ? Math.max(1, Math.min(5, legacy.houseLevel))
      : ["garden", "warehouse"].includes(building.id) ? 1 : building.id === "workshop" ? Math.max(0, Math.min(3, legacy.workshopLevel)) : 0])),
    jobs: [], wardrobe: wardrobeOwned(), migration, completedExplorations: 0, fishing: fishingState({}), progression: newEconomyProgression() };
}
function debit(state: EconomyState, cost: EconomyCost) {
  if (!canAffordEconomy(state, cost)) fail("ECONOMY_RESOURCES", "Не хватает монет или материалов");
  state.wallet.coins -= cost.coins;
  for (const [item, amount] of Object.entries(cost.items)) {
    state.inventory[item] = (state.inventory[item] ?? 0) - amount;
    if (!state.inventory[item]) delete state.inventory[item];
  }
}
export function creditEconomyItems(state: EconomyState, rewards: Record<string, number>) {
  for (const [item, amount] of Object.entries(rewards)) {
    if ((state.inventory[item] ?? 0) + amount > ECONOMY_MAX_ITEMS) fail("ECONOMY_CAPACITY", "Сначала освободите место для этого материала");
  }
  for (const [item, amount] of Object.entries(rewards)) {
    state.inventory[item] = (state.inventory[item] ?? 0) + amount;
    if (!state.inventory[item]) delete state.inventory[item];
  }
}
function requireHome(state: EconomyState, level: number) {
  if ((state.buildings.home ?? 1) < level) fail("ECONOMY_HOME_REQUIRED", `Нужен дом уровня ${level}`);
}
function requireBuildings(state: EconomyState, required: Record<string, number>) {
  const missing = unmetEconomyBuildings(state, required);
  if (missing.length) fail("ECONOMY_BUILDING_REQUIRED", `Нужны постройки: ${missing.map(item => `${economyCatalog.buildings.find(building => building.id === item.buildingId)?.name ?? item.buildingId} ${item.requiredLevel}`).join(", ")}`);
}
function requireActorAvailable(state: EconomyState, intent: "departure" | "collection", now: number) {
  const conflict = economyActorConflict(state.jobs, intent, now);
  if (conflict) fail(conflict.code, conflict.message);
}
/** Pure domain transition. The caller owns the clone, authentication, receipt and atomic commit. */
export function applyEconomyCommand(state: EconomyState, command: EconomyCommand, now: number, jobId: () => string, reservedItems: Record<string, number> = {}, rareRandom: RareRandomInteger = secureRareInteger): string {
  if (!["speedup_construction", "buy_fishing_item", "buy_wardrobe_item", "refresh_fishing_shop", "sell"].includes(command.action) && command.totalPrice !== 0) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Цена не используется в этом действии", 400);
  const createJob = (job: Pick<EconomyJob, "kind" | "targetId" | "recipeId" | "targetLevel" | "rewards" | "collection" | "fishing" | "rareDrop">, seconds: number, cost: EconomyCost, id = jobId()) => {
    if (Object.values(job.rewards).reduce((total, quantity) => total + quantity, 0) > economyStorage(state).capacity)
      fail("ECONOMY_STORAGE_FULL", "Вся партия не поместится на складе. Уменьшите её или расширьте склад");
    debit(state, cost);
    state.jobs.push({ ...job, id, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + seconds * 1000).toISOString(), cost, catalogVersion: economyCatalog.version });
  };
  if (!["start_production", "sell", "sell_fish", "buy_fishing_item"].includes(command.action) && command.quantity !== 1) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Для этого действия количество должно быть равно одному", 400);
  switch (command.action) {
    case "start_production": {
      if (command.targetId.startsWith("quarry_")) return fail("ECONOMY_MINING_ACTIVITY", "В шахте работает Мохлик. Выберите участок для вылазки");
      if (command.quantity > economyCatalog.maxBatch) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Слишком большая партия", 400);
      const recipe = economyCatalog.recipes.find(item => item.id === command.targetId);
      if (!recipe) return fail("ECONOMY_RECIPE", "Рецепт не найден");
      if (command.quantity > (recipe.maxBatch ?? economyCatalog.maxBatch))
        throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Для этого заказа превышено число партий", 400);
      if ((state.buildings[recipe.buildingId] ?? 0) < recipe.buildingLevel) fail("ECONOMY_BUILDING_REQUIRED", "Сначала постройте или улучшите нужное здание");
      requireHome(state, recipe.requiredHomeLevel);
      requireBuildings(state, recipe.requiredBuildings);
      if (state.jobs.some(job => job.targetId === recipe.buildingId && job.kind === "construction"))
        fail("ECONOMY_BUILDING_BUSY", "Дождитесь улучшения здания и заберите результат");
      if (state.jobs.filter(job => job.targetId === recipe.buildingId && job.kind === "production").length >= productionSlotCount(state, recipe.buildingId))
        fail("ECONOMY_BUILDING_BUSY", "Все места производства заняты. Заберите готовый результат");
      createJob({ kind: "production", targetId: recipe.buildingId, recipeId: recipe.id, targetLevel: null,
        ...(recipe.collection ? { collection: { ...recipe.collection, startedAt: null, finishesAt: null } } : {}),
        rewards: Object.fromEntries(Object.entries(recipe.rewards).map(([item, amount]) => [item, amount * command.quantity])) },
      recipe.seconds * command.quantity, scaledEconomyCost(recipe.cost, command.quantity));
      return "Производство запущено";
    }
    case "buy_production_slot": {
      if (!productionStationSupported(command.targetId)) return fail("ECONOMY_PRODUCTION_STATION", "В этой постройке нет мест производства");
      if (!(state.buildings[command.targetId] > 0)) return fail("ECONOMY_BUILDING_REQUIRED", "Сначала постройте нужное здание");
      const offer = productionSlotOffer(state, command.targetId);
      if (!offer) return fail("ECONOMY_PRODUCTION_SLOTS_MAX", "Все три места производства уже открыты");
      requireHome(state, offer.requiredHomeLevel);
      if (state.jobs.some(job => job.kind === "construction" && job.targetId === command.targetId))
        return fail("ECONOMY_BUILDING_BUSY", "Дождитесь улучшения здания и заберите результат");
      if (state.wallet.pearls < offer.pricePearls) return fail("ECONOMY_PEARLS", "Не хватает жемчужин для нового места");
      state.wallet.pearls -= offer.pricePearls;
      state.productionSlots = { ...state.productionSlots, [command.targetId]: offer.slots };
      return "Открыто новое место производства";
    }
    case "start_collection": {
      const job = state.jobs.find(item => item.id === command.targetId);
      if (!job) return fail("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено");
      const spec = job.collection ?? economyCatalog.recipes.find(recipe => recipe.id === job.recipeId)?.collection;
      if (job.kind !== "production" || job.targetId !== "garden" || !(job.rewards.berries > 0) || !spec)
        return fail("ECONOMY_COLLECTION_KIND", "Для этой работы сбор Мохликом не требуется");
      if (job.collection?.startedAt) return fail("ECONOMY_COLLECTION_STARTED", "Мохлик уже собирает этот урожай");
      if (now < Date.parse(job.finishesAt)) return fail("ECONOMY_JOB_NOT_READY", "Урожай ещё не созрел");
      requireActorAvailable(state, "collection", now);
      const inventory = { ...state.inventory };
      for (const [item, quantity] of Object.entries(job.rewards)) inventory[item] = (inventory[item] ?? 0) + quantity;
      assertEconomyStorageTransition(state, { ...state, inventory }, reservedItems);
      job.collection = { kind: spec.kind, seconds: spec.seconds,
        startedAt: new Date(now).toISOString(), finishesAt: new Date(now + spec.seconds * 1000).toISOString() };
      return "Мохлик отправился собирать урожай";
    }
    case "start_fishing":
    case "start_exploration": {
      const route = economyCatalog.explorations.find(item => item.id === command.targetId);
      if (!route) return fail("ECONOMY_EXPLORATION", "Место исследования не найдено");
      requireHome(state, route.requiredHomeLevel);
      requireBuildings(state, route.requiredBuildings);
      if (route.requiredBuildings.quarry && state.jobs.some(job => job.kind === "construction" && job.targetId === "quarry"))
        return fail("ECONOMY_BUILDING_BUSY", "Дождитесь улучшения шахты и заберите результат");
      requireActorAvailable(state, "departure", now);
      const rare = economyCatalog.rareDrops && (state.buildings.home ?? 1) >= economyCatalog.rareDrops.requiredHomeLevel
        ? prepareRareDrop(state.rareDropState, route.seconds, economyCatalog.rareDrops, rareRandom) : null;
      // Older clients used the general exploration command for fishing routes.
      // Normalize it here so command choice cannot bypass tackle or bait costs.
      if (command.action === "start_fishing" || economyCatalog.fishing?.routeIds.includes(route.id)) {
        const catalog = economyCatalog.fishing, tackle = fishingState(state);
        if (!catalog?.routeIds.includes(route.id) || !(route.rewards.fish > 0)) return fail("ECONOMY_FISHING_ROUTE", "Здесь нельзя рыбачить со снастями Плёски");
        if (!tackle.ownedRods.includes(tackle.equippedRodId) || !catalog.rods.some(rod => rod.id === tackle.equippedRodId))
          return fail("ECONOMY_FISHING_ROD", "Сначала выберите свою удочку");
        if (!tackle.ownedHooks.includes(tackle.equippedHookId) || !catalog.hooks.some(hook => hook.id === tackle.equippedHookId))
          return fail("ECONOMY_FISHING_HOOK", "Сначала выберите свой крючок");
        if (tackle.equippedBaitId && !catalog.baits.some(bait => bait.itemId === tackle.equippedBaitId))
          return fail("ECONOMY_FISHING_BAIT", "Наживка не найдена");
        // Generated by the authenticated server adapter, independently of requestId.
        const id = jobId(), seed = state.fishingCastSeed ?? jobId();
        const draws = fishingCollectionDraws(route.id, catalog);
        const catches = Array.from({ length: draws }, (_, index) => selectFishingCatch(seed, tackle.equippedRodId, tackle.equippedBaitId, catalog, tackle.equippedHookId, index));
        const fishId = catches[0];
        const rewards: Record<string, number> = { ...route.rewards, ...rare?.rewards, fish: route.rewards.fish - draws };
        for (const caught of catches) rewards[caught] = (rewards[caught] ?? 0) + 1;
        if (!rewards.fish) delete rewards.fish;
        createJob({ kind: "exploration", targetId: route.id, recipeId: null, targetLevel: null, rewards,
          ...(rare ? { rareDrop: rare.delivery } : {}),
          fishing: { rodId: tackle.equippedRodId, hookId: tackle.equippedHookId, baitId: tackle.equippedBaitId, fishId } }, route.seconds, fishingTripCost(route.cost, state), id);
        state.fishingCastSeed = seed;
        if (rare) state.rareDropState = rare.clock;
        return "Мохлик отправился рыбачить. Снасти и наживка подготовлены";
      }
      createJob({ kind: "exploration", targetId: route.id, recipeId: null, targetLevel: null, rewards: { ...route.rewards, ...rare?.rewards },
        ...(rare ? { rareDrop: rare.delivery } : {}) }, route.seconds, route.cost);
      if (rare) state.rareDropState = rare.clock;
      return "Мохлик отправился исследовать мир";
    }
    case "cancel_exploration": {
      const job = state.jobs.find(item => item.id === command.targetId);
      if (!job) return fail("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено");
      if (job.kind !== "exploration") return fail("ECONOMY_CANCEL_KIND", "Можно отменить только вылазку Мохлика");
      // An unclaimed trip may be abandoned even after its timer ends. Its locked
      // rewards and spent provisions are forfeited; completion is never credited.
      state.jobs = state.jobs.filter(item => item.id !== job.id);
      return "Вылазка отменена. Добыча потеряна, потраченные припасы не возвращаются";
    }
    case "start_construction": {
      const building = economyCatalog.buildings.find(item => item.id === command.targetId);
      if (!building) return fail("ECONOMY_BUILDING", "Постройка не найдена");
      const target = building.levels.find(level => level.level === (state.buildings[building.id] ?? 0) + 1);
      if (!target) return fail("ECONOMY_MAX_LEVEL", "Доступные улучшения уже завершены");
      requireHome(state, target.requiredHomeLevel);
      requireBuildings(state, target.requiredBuildings);
      if (state.jobs.some(job => job.kind === "construction")) fail("ECONOMY_CONSTRUCTION_BUSY", "Строитель занят. Сначала завершите текущую стройку");
      if (building.id === "quarry" && state.jobs.some(job => job.kind === "exploration" && economyCatalog.explorations.some(route => route.id === job.targetId && route.requiredBuildings.quarry)))
        return fail("ECONOMY_BUILDING_BUSY", "Перед улучшением дождитесь Мохлика и заберите добычу");
      if (state.jobs.some(job => job.kind === "production" && job.targetId === building.id)) fail("ECONOMY_BUILDING_BUSY", "Перед улучшением заберите результат производства");
      createJob({ kind: "construction", targetId: building.id, recipeId: null, targetLevel: target.level, rewards: {} }, target.seconds, target.cost);
      return "Строительство началось";
    }
    case "speedup_construction": {
      const job = state.jobs.find(item => item.id === command.targetId);
      if (!job) return fail("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено");
      if (job.kind !== "construction") return fail("ECONOMY_SPEEDUP_KIND", "За жемчуг можно завершить только строительство");
      const price = constructionSpeedupPrice(job, now);
      // totalPrice is the user's accepted maximum, never a trusted price or reward.
      if (price > command.totalPrice) return fail("ECONOMY_SPEEDUP_PRICE_CHANGED", "Стоимость ускорения изменилась. Проверьте цену и подтвердите снова");
      if (state.wallet.pearls < price) return fail("ECONOMY_PEARLS", "Не хватает жемчужин для ускорения");
      state.wallet.pearls -= price;
      state.buildings[job.targetId] = job.targetLevel!;
      state.jobs = state.jobs.filter(item => item.id !== job.id);
      return price > 0 ? "Строительство завершено за жемчуг" : "Постройка готова";
    }
    case "claim_job": {
      const job = state.jobs.find(item => item.id === command.targetId);
      if (!job) return fail("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено");
      if (now < Date.parse(job.finishesAt)) fail("ECONOMY_JOB_NOT_READY", "Работа ещё не закончена");
      if (job.collection) {
        if (!job.collection.startedAt || !job.collection.finishesAt) fail("ECONOMY_COLLECTION_REQUIRED", "Сначала отправьте Мохлика собрать урожай");
        if (now < Date.parse(job.collection.finishesAt!)) fail("ECONOMY_COLLECTION_NOT_READY", "Мохлик ещё собирает урожай");
      }
      if (job.kind === "construction") state.buildings[job.targetId] = job.targetLevel!;
      else {
        const inventory = { ...state.inventory };
        for (const [item, quantity] of Object.entries(job.rewards)) inventory[item] = (inventory[item] ?? 0) + quantity;
        assertEconomyStorageTransition(state, { ...state, inventory }, reservedItems);
        creditEconomyItems(state, job.rewards);
      }
      state.progression = advanceEconomyProgression(state.progression, job);
      if (job.rareDrop) {
        if (!economyCatalog.rareDrops) return fail("ECONOMY_RARE_STATE", "Не удалось проверить редкую находку");
        state.rareDropState = settleRareDrop(state.rareDropState, job.rareDrop, economyCatalog.rareDrops, rareRandom);
      }
      if (job.kind === "exploration" && !job.targetId.startsWith("quarry_")) state.completedExplorations = Math.min(ECONOMY_MAX_ITEMS, state.completedExplorations + 1);
      if (job.kind === "exploration" && economyCatalog.fishing?.routeIds.includes(job.targetId)) {
        const current = fishingState(state), catches = { ...current.catches };
        for (const fish of economyCatalog.fishing.fish) if (job.rewards[fish.itemId])
          catches[fish.itemId] = Math.min(ECONOMY_MAX_ITEMS, (catches[fish.itemId] ?? 0) + job.rewards[fish.itemId]);
        state.fishing = { ...current, catches };
        state.fishingCastSeed = null;
      }
      state.jobs = state.jobs.filter(item => item.id !== job.id);
      return job.kind === "construction" ? "Постройка готова" : "Результат получен";
    }
    case "refresh_fishing_shop": {
      const shop = state.fishingShop, spec = economyCatalog.fishing?.shop;
      if (!shop || !spec || shop.id !== command.targetId || fishingShopExpired(shop, now))
        return fail("ECONOMY_FISHING_SHOP_CHANGED", "Предложения обновились. Загляните в лавку ещё раз");
      const price = spec.refreshPricePearls;
      if (price > command.totalPrice) return fail("ECONOMY_FISHING_PRICE_CHANGED", "Цена обновления изменилась. Проверьте предложение Плёски");
      if (state.wallet.pearls < price) return fail("ECONOMY_PEARLS", "Не хватает жемчужин для обновления лавки");
      const next = refreshFishingShop(state, now, rareRandom);
      if (!next) return fail("ECONOMY_FISHING_SHOP_NO_REPLACEMENT", "Плёска ждёт новую поставку. Жемчужины не потрачены");
      state.wallet.pearls -= price;
      state.fishingShop = next;
      return "Плёска подготовила новые предложения";
    }
    case "buy_wardrobe_item": {
      const item = wardrobeItems.find(item => item.purchase && wardrobePurchaseTarget(item) === command.targetId);
      if (!item?.purchase) return fail("ECONOMY_WARDROBE_ITEM", "Эта вещь не продаётся");
      const owned = wardrobeOwned(state.wardrobe);
      if (owned.includes(item.id)) return fail("ECONOMY_WARDROBE_OWNED", "Эта вещь уже есть в гардеробе");
      const { currency, amount } = item.purchase;
      if (command.totalPrice !== amount) return fail("ECONOMY_WARDROBE_PRICE_CHANGED", "Цена изменилась. Проверьте стоимость вещи");
      if (state.wallet[currency] < amount) return fail("ECONOMY_RESOURCES", currency === "pearls" ? "Не хватает жемчужин" : "Не хватает монет");
      state.wallet[currency] -= amount;
      state.wardrobe = wardrobeOwned(owned, [item.id]);
      return `${item.name} теперь в гардеробе`;
    }
    case "buy_fishing_item": {
      const catalog = economyCatalog.fishing, current = fishingState(state), shop = state.fishingShop;
      if (!catalog) return fail("ECONOMY_FISHING_ITEM", "Лавка Плёски пока недоступна");
      if (!shop || fishingShopExpired(shop, now)) return fail("ECONOMY_FISHING_SHOP_CHANGED", "Предложения обновились. Загляните в лавку ещё раз");
      const offer = shop.offers.find(item => item.id === command.targetId);
      if (!offer) return fail("ECONOMY_FISHING_SHOP_CHANGED", "Этого предложения уже нет. Загляните в лавку ещё раз");
      const rod = offer.kind === "rod" ? catalog.rods.find(item => item.id === offer.itemId) : undefined;
      const hook = offer.kind === "hook" ? catalog.hooks.find(item => item.id === offer.itemId) : undefined;
      const bait = offer.kind === "bait" ? catalog.baits.find(item => item.itemId === offer.itemId) : undefined;
      const fish = offer.kind === "fish" ? catalog.fish.find(item => item.itemId === offer.itemId && item.rarity === "common") : undefined;
      if (!rod && !hook && !bait && !fish) return fail("ECONOMY_FISHING_ITEM", "Плёска не продаёт этот предмет");
      requireHome(state, (rod ?? hook ?? bait)?.requiredHomeLevel ?? 1);
      if (command.quantity > economyCatalog.maxBatch || (rod || hook) && command.quantity !== 1)
        throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Проверьте количество товара", 400);
      if (rod && current.ownedRods.includes(rod.id)) return fail("ECONOMY_FISHING_OWNED", "Эта удочка уже есть в коллекции");
      if (hook && current.ownedHooks.includes(hook.id)) return fail("ECONOMY_FISHING_OWNED", "Этот крючок уже есть в коллекции");
      if (command.quantity > offer.remaining) return fail("ECONOMY_FISHING_STOCK", "Плёска уже продала эту партию. Дождитесь новых предложений");
      const price = offer.unitPrice * command.quantity;
      if (price > command.totalPrice) return fail("ECONOMY_FISHING_PRICE_CHANGED", "Цена изменилась. Проверьте предложение Плёски");
      if (bait || fish) {
        const inventory = { ...state.inventory, [offer.itemId]: (state.inventory[offer.itemId] ?? 0) + command.quantity };
        assertEconomyStorageTransition(state, { ...state, inventory }, reservedItems);
      }
      debit(state, { coins: price, items: {} });
      if (rod) state.fishing = { ...current, ownedRods: [...current.ownedRods, rod.id] };
      else if (hook) state.fishing = { ...current, ownedHooks: [...current.ownedHooks, hook.id] };
      else creditEconomyItems(state, { [offer.itemId]: command.quantity });
      offer.remaining -= command.quantity;
      return rod ? "Удочка добавлена в коллекцию" : hook ? "Крючок добавлен в коллекцию" : "Покупка у Плёски отправлена на склад";
    }
    case "equip_fishing_rod": {
      const current = fishingState(state);
      if (!economyCatalog.fishing?.rods.some(rod => rod.id === command.targetId) || !current.ownedRods.includes(command.targetId))
        return fail("ECONOMY_FISHING_ROD", "Сначала приобретите эту удочку");
      state.fishing = { ...current, equippedRodId: command.targetId };
      return "Удочка выбрана для следующих вылазок";
    }
    case "equip_fishing_bait": {
      const baitId = command.targetId === "none" ? null : command.targetId;
      if (baitId && !economyCatalog.fishing?.baits.some(bait => bait.itemId === baitId))
        return fail("ECONOMY_FISHING_BAIT", "Наживка не найдена");
      if (baitId && !(state.inventory[baitId] > 0)) return fail("ECONOMY_RESOURCES", "Сначала приобретите эту наживку");
      state.fishing = { ...fishingState(state), equippedBaitId: baitId };
      return baitId ? "Наживка выбрана: одна порция на следующую вылазку" : "Выбрана рыбалка без наживки";
    }
    case "equip_fishing_hook": {
      const current = fishingState(state);
      if (!economyCatalog.fishing?.hooks.some(hook => hook.id === command.targetId) || !current.ownedHooks.includes(command.targetId))
        return fail("ECONOMY_FISHING_HOOK", "Сначала приобретите этот крючок");
      state.fishing = { ...current, equippedHookId: command.targetId };
      return "Крючок выбран для следующих вылазок";
    }
    case "sell_fish":
    case "sell": {
      if (command.action === "sell_fish" && !economyCatalog.fishing?.fish.some(fish => fish.itemId === command.targetId))
        return fail("ECONOMY_FISHING_ITEM", "Плёска принимает здесь только рыбу");
      const item = economyCatalog.items.find(item => item.id === command.targetId && item.tradable && item.category !== "special");
      if (!item) return fail("ECONOMY_ITEM", "Этот предмет нельзя продать");
      if ((state.inventory[item.id] ?? 0) < command.quantity) fail("ECONOMY_RESOURCES", "Не хватает предметов для продажи");
      const coins = command.action === "sell_fish" ? command.quantity * item.baseSellPrice
        : economyLocalSellPrice(item.baseSellPrice, command.quantity, economyCatalog.localBuyer);
      if (coins === 0) return fail("ECONOMY_SALE_QUANTITY", "Для продажи добавьте предметы в партию: выручка должна быть хотя бы одна монета");
      if (command.action === "sell" && coins < command.totalPrice)
        return fail("ECONOMY_SALE_PRICE_CHANGED", "Выручка изменилась. Проверьте цену продажи и подтвердите снова");
      if (state.wallet.coins + coins > ECONOMY_MAX_BALANCE) fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
      state.inventory[item.id] -= command.quantity; state.wallet.coins += coins;
      if (!state.inventory[item.id]) delete state.inventory[item.id];
      return "Предметы проданы местному покупателю";
    }
  }
}
