import { wardrobeItems, wardrobeOwned, wardrobePurchaseTarget } from "@/features/world/domain/wardrobe";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS, ECONOMY_MAX_ITEMS, ECONOMY_CURRENCY_SCALE, ECONOMY_PEARL_SCALE, economyCatalog, recipeBuildingLevel, type EconomyCatalog, type EconomyCommand, type EconomyCost, type EconomyJob, type EconomyState, type EconomyStorage } from "./model";
import { productionSlotCount, productionSlotOffer, productionStationSupported } from "./production-slots";
import { productionCollectionRewards, readyProductionJobs } from "./production-collection";
import { recipeResultName } from "./recipe-prerequisites";

import { refreshFishingShop, fishingShopExpired, fishingShopRefreshPrice, fishingOfferUnitPrice } from "./fishing-shop";
import { fishingState, fishingTripCost, fishingCollectionDraws, selectFishingCatch, fishClassForItem, fishClassInventory, fishingClassItemId, fishingBaitCompatible } from "./fishing";
import { advanceEconomyProgression, newEconomyProgression } from "./collection-progress";
import { prepareRareDrop, settleRareDrop, secureRareInteger, type RareRandomInteger } from "./rare-drops";
import { economyLocalSellPrice } from "./local-sale";
import { economyActorConflict, economyMinerConflict, explorationActorId, isMinerJob } from "./actor-availability";
import { durationPearlPrice, remainingTimePearlPrice, type PearlPricePoint } from "./time-price";
import { hasGardenBerryReward } from "./garden-berries";
import { advanceResidentOrder, foodState, initialResidentOrders, normalizedResidentOrders, pendingMeal, heroMealWorkDuration, heroMealWorkUsed, spendHeroMealWork, recipeWithFish, residentOrderBoard } from "./food";
import { canPrepareTutorialHarvest, isTutorialOrderId, newTutorialOrder, TUTORIAL_ORDER_ID, tutorialOrderProgress, tutorialResidentOrder } from "./tutorial-order";
import { ensureStageOrders, isStageOrderId, stageCourseRequired, stageOrderProgress, stageOrdersProgress, stageResidentOrder } from "./stage-orders";
import { persistEconomyItemUnlocks, unlockedEconomyItems } from "./item-unlocks";
import { economyMarketUnlocked, marketSlotOffer } from "./market-rules";
import { leaftailShopStock, leaftailShopUsesUnits, leaftailShopView } from "./leaftail-shop";
import { creditFishStock, debitFishStock, FishSelectionChangedError, fishStockWithinItems, normalizeFishStockInventory, reconcileFishStock, type FishSelection } from "./fish-stock";
import { canStartTutorialWorkshop } from "./workshop-starter";
import { acceptWeeklyOrder, awardTradeOrderXp, awardTradePurchaseXp, tradePurchaseXpEligible, tradeRelationBonusBps, tradeRelationsState, tradeWorkDuration, tradeMealDuration, weeklyOrderBoard } from "./trade-relations";
import { drawExpeditionFinds, expeditionJobRewards } from "./expedition-finds";
export { economyLocalSellPrice, economyLocalSaleMinimumQuantity, economyLocalSaleLimit } from "./local-sale";

export class EconomyRuleError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
/** A display quote only: the authoritative command recomputes this from its own clock. */
export function constructionSpeedupPrice(job: Pick<EconomyJob, "kind" | "finishesAt">, now: number,
  config: ConstructionPriceConfig = economyCatalog.constructionSpeedup): number {
  if (job.kind !== "construction") return 0;
  return remainingTimePearlPrice(job.finishesAt, now, config.secondsPerPearl, ECONOMY_PEARL_SCALE, config.priceStepPearls, config.pricingPoints);
}
type ConstructionPriceConfig = { secondsPerPearl: number; priceStepPearls: number; pricingPoints?: readonly PearlPricePoint[] };
export function constructionTimePearlPrice(seconds: number, config: ConstructionPriceConfig = economyCatalog.constructionSpeedup): number {
  return durationPearlPrice(seconds * 1000, config.secondsPerPearl, ECONOMY_PEARL_SCALE, config.priceStepPearls, config.pricingPoints);
}
const fail = (code: string, message: string): never => { throw new EconomyRuleError(code, message); };
function normalizedInventory(items: Record<string, number>): Record<string, number> {
  try { return fishClassInventory(items); }
  catch (error) {
    if (error instanceof RangeError) return fail("ECONOMY_CAPACITY", "Сначала освободите место для этого материала");
    throw error;
  }
}
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
/** Escrow and pending meals are already owned. Returning them can preserve overflow, never grow stock. */
export function assertEconomyStorageTransition(previous: Pick<EconomyState, "buildings" | "inventory" | "food">, next: Pick<EconomyState, "buildings" | "inventory" | "food">,
  previousReserved: Record<string, number> = {}, nextReserved: Record<string, number> = previousReserved) {
  const totals = normalizedInventory(next.inventory);
  for (const [item, quantity] of Object.entries(normalizedInventory(nextReserved))) totals[item] = (totals[item] ?? 0) + quantity;
  if (Object.values(totals).some(quantity => quantity > ECONOMY_MAX_ITEMS)) fail("ECONOMY_CAPACITY", "Сначала освободите место для этого материала");
  const before = economyStorage(previous, previousReserved), after = economyStorage(next, nextReserved);
  const pending = (state: Pick<EconomyState, "food">) => Number(Boolean(state.food?.heroMeal) && (!state.food?.heroMealEffect
    || state.food.heroMealEffect.remainingWorkSeconds === state.food.heroMealEffect.totalWorkSeconds)) + Number(Boolean(state.food?.builderMeal));
  if (after.used + after.reserved > after.capacity && after.used + after.reserved + pending(next) > before.used + before.reserved + pending(previous))
    fail("ECONOMY_STORAGE_FULL", "Склад заполнен. Продайте лишнее, используйте материалы или расширьте склад");
}
export function marketUnlocked(state: Pick<EconomyState, "buildings" | "completedExplorations">) {
  return economyMarketUnlocked(state);
}
export function convertLegacyEconomy(resources: { sparks: number; wood: number; stone: number }) {
  const safe = (value: number) => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const wood = Math.sqrt(safe(resources.wood)), stone = Math.sqrt(safe(resources.stone));
  return { version: 1 as const, coinsGranted: ECONOMY_CURRENCY_SCALE * Math.min(500, Math.floor(2 * Math.sqrt(safe(resources.sparks)) + wood + stone)),
    woodGranted: Math.min(30, Math.floor(wood)), stoneGranted: Math.min(30, Math.floor(stone)) };
}
export function newEconomyState(legacy: { resources: { sparks: number; wood: number; stone: number }; houseLevel: number; workshopLevel: number }): EconomyState {
  const migration = convertLegacyEconomy(legacy.resources);
  const starting = economyCatalog.onboarding;
  const inventory = { ...starting?.startingItems };
  if (migration.woodGranted) inventory.wood = (inventory.wood ?? 0) + migration.woodGranted;
  if (migration.stoneGranted) inventory.stone = (inventory.stone ?? 0) + migration.stoneGranted;
  return { currencyScale: ECONOMY_CURRENCY_SCALE, pearlScale: ECONOMY_PEARL_SCALE,
    wallet: { coins: migration.coinsGranted + (starting?.startingWallet.coins ?? 0), pearls: starting?.startingWallet.pearls ?? 0 }, inventory,
    buildings: Object.fromEntries(economyCatalog.buildings.map(building => [building.id, building.id === "home" ? Math.max(1, Math.min(5, legacy.houseLevel))
      : ["garden", "warehouse"].includes(building.id) ? 1 : building.id === "workshop" ? Math.max(0, Math.min(3, legacy.workshopLevel)) : 0])),
    jobs: [], tutorialOrder: newTutorialOrder(), stageOrders: stageOrdersProgress({}), minerRareDropState: null,
    marketSlots: economyCatalog.market.baseSlots, unlockedItems: [], itemUnlockVersion: 1,
    workshopStarterClaimed: false, wardrobe: wardrobeOwned(), migration, completedExplorations: 0, fishing: fishingState({}), progression: newEconomyProgression(),
    food: foodState({}), residentOrders: initialResidentOrders(), tradeRelations: tradeRelationsState({}) };
}
function debit(state: EconomyState, cost: EconomyCost, fishSelection?: FishSelection, exactSpecies = false): FishSelection {
  const items = normalizedInventory(cost.items);
  if (!canAffordEconomy(state, { ...cost, items })) fail("ECONOMY_RESOURCES", "Не хватает монет или материалов");
  let consumed: FishSelection;
  try { consumed = debitFishStock(state, exactSpecies ? cost.items : items, fishSelection); }
  catch (error) { if (error instanceof FishSelectionChangedError) return fail("ECONOMY_FISH_SELECTION_CHANGED", error.message); throw error; }
  state.wallet.coins -= cost.coins;
  for (const [item, amount] of Object.entries(items)) {
    state.inventory[item] = (state.inventory[item] ?? 0) - amount;
    if (!state.inventory[item]) delete state.inventory[item];
  }
  return consumed;
}
export function creditEconomyItems(state: EconomyState, rewards: Record<string, number>) {
  state.inventory = normalizedInventory(state.inventory);
  rewards = normalizedInventory(rewards);
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
  const previousInventory = state.inventory;
  const previousFishing = state.fishing;
  try { normalizeFishStockInventory(state); }
  catch (error) { if (error instanceof RangeError) return fail("ECONOMY_CAPACITY", "Сначала освободите место для этого материала"); throw error; }
  const previousOrders = state.residentOrders;
  const previousStageOrders = state.stageOrders;
  const previousTutorial = state.tutorialOrder;
  const previousUnlocks = unlockedEconomyItems(state);
  const boardBefore = economyCatalog.food ? normalizedResidentOrders(state, now) : undefined;
  let message: string;
  try {
    ensureStageOrders(state, economyCatalog, now);
    message = applyEconomyTransition(state, command, now, jobId, reservedItems, rareRandom);
    ensureStageOrders(state, economyCatalog, now);
  } catch (error) { state.inventory = previousInventory; state.fishing = previousFishing; state.stageOrders = previousStageOrders; state.tutorialOrder = previousTutorial; throw error; }
  reconcileFishStock(state);
  // Pin the board before this command unlocks a new building. Failed commands
  // never migrate it, and an order command already supplied its next board.
  if (boardBefore && state.residentOrders === previousOrders) state.residentOrders = boardBefore;
  state.unlockedItems = [...new Set([...(state.unlockedItems ?? []), ...previousUnlocks])];
  state.itemUnlockVersion = 1;
  persistEconomyItemUnlocks(state);
  return message;
}

function applyEconomyTransition(state: EconomyState, command: EconomyCommand, now: number, jobId: () => string, reservedItems: Record<string, number>, rareRandom: RareRandomInteger): string {
  if (command.fishSelection != null && !["start_production", "complete_resident_order", "sell", "sell_fish"].includes(command.action))
    throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Выбор рыбы не используется в этом действии", 400);
  if (!["speedup_construction", "buy_market_slot", "buy_production_slot", "buy_fishing_item", "buy_wardrobe_item", "buy_leaftail_item", "refresh_fishing_shop", "sell", "replace_resident_order"].includes(command.action) && command.totalPrice !== 0) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Цена не используется в этом действии", 400);
  const createJob = (job: Pick<EconomyJob, "kind" | "targetId" | "recipeId" | "targetLevel" | "rewards" | "collection" | "fishing" | "rareDrop" | "meal" | "actorId" | "tradeSpeedBps" | "expeditionFinds">, seconds: number, cost: EconomyCost | null, id = jobId(), fishSelection?: FishSelection, exactSpecies = false, finds?: EconomyCatalog["explorations"][number]["finds"]) => {
    if (state.jobs.length >= 18) fail("ECONOMY_JOBS_CAPACITY", "Сначала заберите результат одной из текущих работ");
    if (Object.values(job.rewards).reduce((total, quantity) => total + quantity, 0) + Math.max(0, ...(finds?.entries.map(entry => entry.quantity) ?? [])) > economyStorage(state).capacity)
      fail("ECONOMY_STORAGE_FULL", "Вся партия не поместится на складе. Уменьшите её или расширьте склад");
    // A null cost is the one-time tutorial construction aid, paid straight to
    // the builder. It never credits or debits spendable stock or legacy debt.
    if (cost && !canAffordEconomy(state, { ...cost, items: normalizedInventory(cost.items) })) fail("ECONOMY_RESOURCES", "Не хватает монет или материалов");
    const hiddenFinds = finds ? { expeditionFinds: drawExpeditionFinds(finds, rareRandom) } : {};
    const fishStockCost = cost === null ? {} : debit(state, cost, fishSelection, exactSpecies);
    state.jobs.push({ ...job, ...hiddenFinds, ...(Object.keys(fishStockCost).length ? { fishStockCost } : {}), id, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + seconds * 1000).toISOString(), cost: cost ?? { coins: 0, items: {} }, catalogVersion: economyCatalog.version });
  };
  if (!["start_production", "sell", "sell_fish", "buy_fishing_item", "buy_leaftail_item"].includes(command.action) && command.quantity !== 1) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Для этого действия количество должно быть равно одному", 400);
  switch (command.action) {
    case "buy_market_slot": {
      if (!marketUnlocked(state)) return fail("ECONOMY_MARKET_LOCKED", "Сначала откройте рынок");
      const offer = marketSlotOffer(state);
      if (!offer) return fail("MARKET_SLOTS_MAX", "Все места прилавка уже открыты");
      if (command.targetId !== offer.targetId) return fail("MARKET_SLOT_CHANGED", "Число мест прилавка изменилось. Проверьте следующее расширение");
      if (command.totalPrice !== offer.pricePearls) return fail("MARKET_SLOT_PRICE_CHANGED", "Цена расширения изменилась. Проверьте стоимость и подтвердите снова");
      if (state.wallet.pearls < offer.pricePearls) return fail("ECONOMY_PEARLS", "Не хватает жемчуга для расширения прилавка");
      state.wallet.pearls -= offer.pricePearls;
      state.marketSlots = offer.slots;
      return "Новое место прилавка открыто";
    }
    case "claim_tutorial_order": {
      if (command.targetId !== TUTORIAL_ORDER_ID) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Действие предназначено для первого учебного заказа", 400);
      const progress = tutorialOrderProgress(state);
      if (progress.ingredientsClaimed || progress.completed) return fail("ECONOMY_TUTORIAL_ORDER_CLAIMED", "Учебный заказ уже открыт или выполнен");
      const terms = progress.terms ?? economyCatalog.onboarding?.residentOrder;
      if (!terms) return fail("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", "Учебный заказ пока недоступен");
      state.tutorialOrder = { ...progress, ingredientsClaimed: true, terms: { ...terms, items: { ...terms.items } } };
      return "Учебный заказ открыт. Соберите нужные предметы и отдайте их на доске заказов";
    }
    case "claim_workshop_starter": {
      if (command.targetId !== "workshop") throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Этот подарок предназначен для первой мастерской", 400);
      return fail("ECONOMY_WORKSHOP_STARTER_UNAVAILABLE", "Материалы для мастерской теперь получают из производства и заказов");
    }
    case "start_tutorial_harvest":
    case "start_production": {
      const tutorialHarvest = command.action === "start_tutorial_harvest";
      if (tutorialHarvest && (command.targetId !== "grow_berries" || command.quantity !== 1))
        throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Некорректный запрос учебного урожая", 400);
      if (tutorialHarvest && !canPrepareTutorialHarvest(state, command.targetId, command.quantity))
        return fail("ECONOMY_TUTORIAL_HARVEST_UNAVAILABLE", "Помощь с первым урожаем уже использована или сейчас недоступна");
      if (command.targetId.startsWith("quarry_")) return fail("ECONOMY_MINING_ACTIVITY", "Выберите участок добычи для шахтёра");
      if (command.quantity > economyCatalog.maxBatch) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Слишком большая партия", 400);
      const [recipeId, fishItemId, extra] = command.targetId.split("@");
      const source = economyCatalog.recipes.find(item => item.id === recipeId);
      if (!source) return fail("ECONOMY_RECIPE", "Рецепт не найден");
      if (source.retired) return fail("ECONOMY_SOURCE_RETIRED", "Этот способ больше недоступен. Выберите действующий рецепт или добычу");
      if (extra !== undefined || command.targetId.includes("@") && (!fishItemId || !source.fishInput?.itemIds.includes(fishItemId)
        || !economyCatalog.fishing?.fish.some(fish => fish.itemId === fishItemId)))
        return fail("ECONOMY_RECIPE_FISH", "Эта рыба не подходит для рецепта");
      const recipe = recipeWithFish(source, fishItemId);
      if (command.quantity > (recipe.maxBatch ?? economyCatalog.maxBatch))
        throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Для этого заказа превышено число партий", 400);
      if ((state.buildings[recipe.buildingId] ?? 0) < recipeBuildingLevel(recipe)) fail("ECONOMY_BUILDING_REQUIRED", "Сначала постройте или улучшите нужное здание");
      requireHome(state, recipe.requiredHomeLevel);
      requireBuildings(state, recipe.requiredBuildings);
      const missingRecipes = Object.entries(recipe.requiredRecipes).filter(([recipeId, count]) => (state.progression.recipes[recipeId] ?? 0) < count);
      if (missingRecipes.length) fail("ECONOMY_RECIPE_REQUIRED", `Произведите и заберите: ${missingRecipes.map(([recipeId]) => recipeResultName(recipeId, economyCatalog)).join(", ")}`);
      if (state.jobs.some(job => job.targetId === recipe.buildingId && job.kind === "construction"))
        fail("ECONOMY_BUILDING_BUSY", "Дождитесь улучшения здания и заберите результат");
      if (state.jobs.filter(job => job.targetId === recipe.buildingId && job.kind === "production").length >= productionSlotCount(state, recipe.buildingId))
        fail("ECONOMY_BUILDING_BUSY", "Все места производства заняты. Заберите готовый результат");
      const firstHarvest = tutorialHarvest;
      const tradeSpeedBps = recipe.buildingId === "woodlot" ? tradeRelationBonusBps(state, "lopukh", economyCatalog, now) : 0;
      createJob({ kind: "production", targetId: recipe.buildingId, recipeId: recipe.id, targetLevel: null, ...(tradeSpeedBps ? { tradeSpeedBps } : {}),
        ...(recipe.collection ? { collection: { ...recipe.collection, startedAt: null, finishesAt: null } } : {}),
        rewards: Object.fromEntries(Object.entries(recipe.rewards).map(([item, amount]) => [item, amount * command.quantity])) },
      // Keep a positive saved interval for the scene's crop clock. One millisecond
      // has elapsed before a real next command, without a visible growth wait.
      firstHarvest ? .001 : recipe.buildingId === "woodlot" ? tradeWorkDuration(state, recipe.seconds * command.quantity, "lopukh", 0, economyCatalog, now) : recipe.seconds * command.quantity, scaledEconomyCost(recipe.cost, command.quantity), jobId(), command.fishSelection ?? undefined, recipe.fishInput?.exactSpecies === true);
      if (firstHarvest) state.tutorialOrder = { ...tutorialOrderProgress(state), firstHarvestPrepared: true };
      return firstHarvest ? "Первый учебный урожай созрел. Отправьте Мохлика собрать малину" : "Производство запущено";
    }
    case "buy_production_slot": {
      if (!productionStationSupported(command.targetId)) return fail("ECONOMY_PRODUCTION_STATION", "В этой постройке нет мест производства");
      if (!(state.buildings[command.targetId] > 0)) return fail("ECONOMY_BUILDING_REQUIRED", "Сначала постройте нужное здание");
      const offer = productionSlotOffer(state, command.targetId);
      if (!offer) return fail("ECONOMY_PRODUCTION_SLOTS_MAX", "Все три места производства уже открыты");
      requireHome(state, offer.requiredHomeLevel);
      if (state.jobs.some(job => job.kind === "construction" && job.targetId === command.targetId))
        return fail("ECONOMY_BUILDING_BUSY", "Дождитесь улучшения здания и заберите результат");
      if (command.totalPrice !== offer.pricePearls) return fail("ECONOMY_PRODUCTION_SLOT_PRICE_CHANGED", "Цена места изменилась. Проверьте стоимость и подтвердите снова");
      if (state.wallet.pearls < offer.pricePearls) return fail("ECONOMY_PEARLS", "Не хватает жемчужин для нового места");
      state.wallet.pearls -= offer.pricePearls;
      state.productionSlots = { ...state.productionSlots, [command.targetId]: offer.slots };
      return "Открыто новое место производства";
    }
    case "start_garden_collection":
    case "start_collection": {
      const job = state.jobs.find(item => item.id === command.targetId);
      if (!job) return fail("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено");
      const spec = job.collection ?? economyCatalog.recipes.find(recipe => recipe.id === job.recipeId)?.collection;
      if (job.kind !== "production" || job.targetId !== "garden" || !hasGardenBerryReward(job.rewards) || !spec)
        return fail("ECONOMY_COLLECTION_KIND", "Для этой работы сбор Мохликом не требуется");
      if (job.collection?.startedAt) return fail("ECONOMY_COLLECTION_STARTED", "Мохлик уже собирает этот урожай");
      if (now < Date.parse(job.finishesAt)) return fail("ECONOMY_JOB_NOT_READY", "Урожай ещё не созрел");
      requireActorAvailable(state, "collection", now);
      const batch = command.action === "start_garden_collection";
      const jobs = batch ? state.jobs.filter(item => item.kind === "production" && item.targetId === "garden" &&
        hasGardenBerryReward(item.rewards) && !item.collection?.startedAt && now >= Date.parse(item.finishesAt) &&
        (item.collection ?? economyCatalog.recipes.find(recipe => recipe.id === item.recipeId)?.collection)) : [job];
      const inventory = { ...state.inventory };
      for (const current of jobs) for (const [item, quantity] of Object.entries(current.rewards)) inventory[item] = (inventory[item] ?? 0) + quantity;
      assertEconomyStorageTransition(state, { ...state, inventory }, reservedItems);
      const seconds = batch ? Math.max(8, ...jobs.map(item => (item.collection ?? economyCatalog.recipes.find(recipe => recipe.id === item.recipeId)?.collection)!.seconds)) : spec.seconds;
      for (const current of jobs) {
        const saved = (current.collection ?? economyCatalog.recipes.find(recipe => recipe.id === current.recipeId)?.collection)!;
        current.collection = { kind: saved.kind, seconds: saved.seconds, startedAt: new Date(now).toISOString(),
          finishesAt: new Date(now + seconds * 1000).toISOString(), ...(batch ? { batchId: command.requestId } : {}) };
      }
      return "Мохлик отправился собирать урожай";
    }
    case "start_fishing":
    case "start_exploration": {
      const route = economyCatalog.explorations.find(item => item.id === command.targetId);
      if (!route) return fail("ECONOMY_EXPLORATION", "Место исследования не найдено");
      if (route.retired) return fail("ECONOMY_SOURCE_RETIRED", "Этот способ больше недоступен. Выберите действующий рецепт или добычу");
      requireHome(state, route.requiredHomeLevel);
      requireBuildings(state, route.requiredBuildings);
      if (route.requiredBuildings.quarry && state.jobs.some(job => job.kind === "construction" && job.targetId === "quarry"))
        return fail("ECONOMY_BUILDING_BUSY", "Дождитесь улучшения шахты и заберите результат");
      const actorId = explorationActorId(route), miner = actorId === "miner";
      if (miner) {
        const conflict = economyMinerConflict(state.jobs, now);
        if (conflict) return fail(conflict.code, conflict.message);
      } else requireActorAvailable(state, "departure", now);
      const fishingRoute = command.action === "start_fishing" || economyCatalog.fishing?.routeIds.includes(route.id);
      if (fishingRoute) {
        const catalog = economyCatalog.fishing, tackle = fishingState(state);
        if (!catalog?.routeIds.includes(route.id) || !(route.rewards.fish > 0)) return fail("ECONOMY_FISHING_ROUTE", "Здесь нельзя рыбачить со снастями Плёски");
        if (!tackle.ownedRods.includes(tackle.equippedRodId) || !catalog.rods.some(rod => rod.id === tackle.equippedRodId))
          return fail("ECONOMY_FISHING_ROD", "Сначала выберите свою удочку");
        if (!tackle.ownedHooks.includes(tackle.equippedHookId) || !catalog.hooks.some(hook => hook.id === tackle.equippedHookId))
          return fail("ECONOMY_FISHING_HOOK", "Сначала выберите свой крючок");
        if (tackle.equippedBaitId && !catalog.baits.some(bait => bait.itemId === tackle.equippedBaitId))
          return fail("ECONOMY_FISHING_BAIT", "Наживка не найдена");
        if (!fishingBaitCompatible(tackle.equippedRodId, tackle.equippedBaitId, catalog))
          return fail("ECONOMY_FISHING_BAIT", "Эта удочка не ловит рыбу для выбранной наживки");
      }
      const meal = miner ? null : pendingMeal(state, "hero");
      const tradeSpeedBps = miner ? tradeRelationBonusBps(state, "kamneshmyg", economyCatalog, now) : 0;
      const seconds = miner ? tradeWorkDuration(state, route.seconds, "kamneshmyg", 0, economyCatalog, now) : heroMealWorkDuration(state, route.seconds);
      const mealAnnotation = meal ? { meal: { itemId: meal.itemId, consumer: "hero" as const, speedBps: meal.heroSpeedBps, ...(heroMealWorkUsed(state, route.seconds) ? { workSeconds: heroMealWorkUsed(state, route.seconds) } : {}) } } : {};
      // Validate the complete offer before any private clock or bonus draw.
      if (state.jobs.length >= 18) fail("ECONOMY_JOBS_CAPACITY", "Сначала заберите результат одной из текущих работ");
      const tripCost = fishingRoute ? fishingTripCost(route.cost, state) : route.cost;
      const rareEnabled = economyCatalog.rareDrops && (state.buildings.home ?? 1) >= economyCatalog.rareDrops.requiredHomeLevel;
      const clock = miner ? state.minerRareDropState : state.rareDropState;
      const rareCount = Number(Boolean(rareEnabled && clock && clock.remainingSeconds <= seconds));
      if (Object.values(route.rewards).reduce((sum, count) => sum + count, 0) + rareCount
        + Math.max(0, ...(route.finds?.entries.map(entry => entry.quantity) ?? [])) > economyStorage(state).capacity)
        fail("ECONOMY_STORAGE_FULL", "Вся партия не поместится на складе. Уменьшите её или расширьте склад");
      if (!canAffordEconomy(state, { ...tripCost, items: normalizedInventory(tripCost.items) }))
        fail("ECONOMY_RESOURCES", "Не хватает монет или материалов");
      const rare = economyCatalog.rareDrops && (state.buildings.home ?? 1) >= economyCatalog.rareDrops.requiredHomeLevel
        ? prepareRareDrop(miner ? state.minerRareDropState : state.rareDropState, seconds, economyCatalog.rareDrops, rareRandom) : null;
      // Older clients used the general exploration command for fishing routes.
      // Normalize it here so command choice cannot bypass tackle or bait costs.
      if (fishingRoute) {
        const catalog = economyCatalog.fishing!, tackle = fishingState(state);
        // Generated by the authenticated server adapter, independently of requestId.
        const id = jobId(), seed = state.fishingCastSeed ?? jobId();
        const draws = fishingCollectionDraws(route.id, catalog);
        const catches = Array.from({ length: draws }, (_, index) => selectFishingCatch(seed, tackle.equippedRodId, tackle.equippedBaitId, catalog, tackle.equippedHookId, index));
        const fishId = catches[0];
        const rewards: Record<string, number> = { ...route.rewards, ...rare?.rewards, fish: route.rewards.fish - draws };
        for (const caught of catches) rewards[caught] = (rewards[caught] ?? 0) + 1;
        if (!rewards.fish) delete rewards.fish;
        createJob({ kind: "exploration", actorId: "mochlik", targetId: route.id, recipeId: null, targetLevel: null, rewards,
          ...mealAnnotation,
          ...(rare ? { rareDrop: rare.delivery } : {}),
          fishing: { rodId: tackle.equippedRodId, hookId: tackle.equippedHookId, baitId: tackle.equippedBaitId, fishId } }, seconds, tripCost, id, undefined, false, route.finds);
        if (meal) spendHeroMealWork(state, route.seconds);
        state.fishingCastSeed = seed;
        if (rare) state.rareDropState = rare.clock;
        return "Мохлик отправился рыбачить. Снасти и наживка подготовлены";
      }
      createJob({ kind: "exploration", actorId, targetId: route.id, recipeId: null, targetLevel: null, ...(tradeSpeedBps ? { tradeSpeedBps } : {}), rewards: { ...route.rewards, ...rare?.rewards },
        ...mealAnnotation, ...(rare ? { rareDrop: rare.delivery } : {}) }, seconds, route.cost, jobId(), undefined, false, route.finds);
      if (meal) spendHeroMealWork(state, route.seconds);
      if (rare) {
        if (miner) state.minerRareDropState = rare.clock;
        else state.rareDropState = rare.clock;
      }
      return miner ? "Шахтёр начал добывать материалы" : "Мохлик отправился исследовать мир";
    }
    case "cancel_production": {
      const job = state.jobs.find(item => item.id === command.targetId);
      if (!job) return fail("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено");
      if (job.kind !== "production" || !productionStationSupported(job.targetId))
        return fail("ECONOMY_CANCEL_KIND", "Можно отменить только обычное производство");
      if (now >= Date.parse(job.finishesAt) || job.collection?.startedAt != null)
        return fail("ECONOMY_CANCEL_READY", "Готовое производство уже нельзя отменить. Заберите результат");
      if (job.cost.coins > ECONOMY_MAX_BALANCE - state.wallet.coins) return fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
      // Refund the paid job, including its selected fish, never today's recipe.
      // Check the complete return before changing the wallet or removing a slot.
      const next = { ...state, inventory: { ...state.inventory } };
      creditEconomyItems(next, job.cost.items);
      assertEconomyStorageTransition(state, next, reservedItems);
      creditFishStock(next, fishStockWithinItems(job.fishStockCost ?? job.cost.items, job.cost.items));
      state.inventory = next.inventory;
      state.fishing = next.fishing;
      state.wallet.coins += job.cost.coins;
      state.jobs = state.jobs.filter(item => item.id !== job.id);
      return "Производство отменено. Потраченные монеты и материалы возвращены";
    }
    case "cancel_exploration": {
      const job = state.jobs.find(item => item.id === command.targetId);
      if (!job) return fail("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено");
      if (job.kind !== "exploration") return fail("ECONOMY_CANCEL_KIND", "Можно отменить только вылазку или работу в шахте");
      if (isMinerJob(job)) {
        if (job.cost.coins > ECONOMY_MAX_BALANCE - state.wallet.coins) return fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
        const next = { ...state, inventory: { ...state.inventory } };
        creditEconomyItems(next, job.cost.items);
        assertEconomyStorageTransition(state, next, reservedItems);
        state.inventory = next.inventory;
        state.wallet.coins += job.cost.coins;
        state.jobs = state.jobs.filter(item => item.id !== job.id);
        return "Добыча отменена. Потраченные припасы возвращены, результат потерян";
      }
      // An unclaimed trip may be abandoned even after its timer ends. Its locked
      // rewards and spent provisions are forfeited; completion is never credited.
      state.jobs = state.jobs.filter(item => item.id !== job.id);
      return "Вылазка отменена. Добыча потеряна, потраченные припасы не возвращаются";
    }
    case "start_tutorial_workshop":
    case "start_construction": {
      const tutorialWorkshop = command.action === "start_tutorial_workshop";
      if (tutorialWorkshop && command.targetId !== "workshop")
        throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Учебные материалы предназначены для первой мастерской", 400);
      if (tutorialWorkshop && !canStartTutorialWorkshop(state))
        return fail("ECONOMY_WORKSHOP_STARTER_UNAVAILABLE", "Помощь для первой мастерской уже использована или стройка началась");
      const building = economyCatalog.buildings.find(item => item.id === command.targetId);
      if (!building) return fail("ECONOMY_BUILDING", "Постройка не найдена");
      const target = building.levels.find(level => level.level === (state.buildings[building.id] ?? 0) + 1);
      if (!target) return fail("ECONOMY_MAX_LEVEL", "Доступные улучшения уже завершены");
      requireHome(state, target.requiredHomeLevel);
      const tutorial = tutorialOrderProgress(state);
      if (building.id === "home" && target.level === 2 && tutorial.version !== 1 && !tutorial.completed)
        fail("ECONOMY_TUTORIAL_REQUIRED", "Сначала выполните первый заказ с Шишколапом");
      if (building.id === "home" && stageCourseRequired(state, target.level))
        fail("ECONOMY_STAGE_REQUIRED", "Сначала выполните постоянные заказы этого этапа на доске жителей");
      requireBuildings(state, target.requiredBuildings);
      if (state.jobs.some(job => job.kind === "construction")) fail("ECONOMY_CONSTRUCTION_BUSY", "Строитель занят. Сначала завершите текущую стройку");
      if (building.id === "quarry" && state.jobs.some(job => isMinerJob(job) || job.kind === "exploration"
        && economyCatalog.explorations.some(route => route.id === job.targetId && route.requiredBuildings.quarry)))
        return fail("ECONOMY_BUILDING_BUSY", "Перед улучшением дождитесь окончания добычи и заберите результат");
      if (state.jobs.some(job => job.kind === "production" && job.targetId === building.id)) fail("ECONOMY_BUILDING_BUSY", "Перед улучшением заберите результат производства");
      const meal = pendingMeal(state, "builder"), tradeSpeedBps = tradeRelationBonusBps(state, "builder", economyCatalog, now);
      createJob({ kind: "construction", targetId: building.id, recipeId: null, targetLevel: target.level, rewards: {}, ...(tradeSpeedBps ? { tradeSpeedBps } : {}),
        ...(meal ? { meal: { itemId: meal.itemId, consumer: "builder", speedBps: meal.builderSpeedBps } } : {}) },
      tradeWorkDuration(state, target.seconds, "builder", meal?.builderSpeedBps ?? 0, economyCatalog, now), tutorialWorkshop ? null : target.cost);
      if (tutorialWorkshop) state.workshopStarterClaimed = true;
      if (meal) { const food = foodState(state); delete food.builderMealSpeedBps; state.food = { ...food, builderMeal: null }; }
      return tutorialWorkshop ? "Учебные материалы переданы Шишколапу, строительство мастерской началось" : "Строительство началось";
    }
    case "cancel_meal": {
      if (command.targetId !== "hero" && command.targetId !== "builder")
        throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Выберите Мохлика или Шишколапа", 400);
      const food = foodState(state), field = command.targetId === "hero" ? "heroMeal" : "builderMeal";
      const itemId = food[field];
      if (!itemId) return fail("ECONOMY_MEAL_UNAVAILABLE", "Нет блюда для возврата: оно уже использовано или не выбрано");
      if (!economyCatalog.food?.meals.some(meal => meal.itemId === itemId))
        return fail("ECONOMY_FOOD", "Не удалось определить сохранённое блюдо");
      const next = { ...state, inventory: { ...state.inventory }, food: { ...food, [field]: null } };
      const used = command.targetId === "hero" && food.heroMealEffect
        && food.heroMealEffect.remainingWorkSeconds < food.heroMealEffect.totalWorkSeconds;
      if (command.targetId === "hero") delete next.food.heroMealEffect;
      else delete next.food.builderMealSpeedBps;
      if (!used) creditEconomyItems(next, { [itemId]: 1 });
      assertEconomyStorageTransition(state, next, reservedItems);
      state.inventory = next.inventory;
      state.food = next.food;
      return used ? "Остаток действия блюда убран" : "Неиспользованное блюдо возвращено в кладовую";
    }
    case "eat_food":
    case "feed_builder": {
      const meal = economyCatalog.food?.meals.find(item => item.itemId === command.targetId);
      if (!meal) return fail("ECONOMY_FOOD", "Это блюдо нельзя съесть");
      const food = foodState(state);
      if (command.action === "eat_food") {
        requireActorAvailable(state, "departure", now);
        if (food.heroMeal) return fail("ECONOMY_ALREADY_FED", "У Мохлика ещё действует выбранное блюдо");
        debit(state, { coins: 0, items: { [meal.itemId]: 1 } });
        state.food = { ...food, heroMeal: meal.itemId,
          ...(meal.heroWorkSeconds ? { heroMealEffect: { remainingWorkSeconds: meal.heroWorkSeconds,
            totalWorkSeconds: meal.heroWorkSeconds, speedBps: meal.heroSpeedBps } } : {}) };
        return meal.heroWorkSeconds ? "Мохлик поел. Бонус расходуется только во время вылазок" : "Мохлик поел. Следующая вылазка будет быстрее";
      }
      if (food.builderMeal) return fail("ECONOMY_ALREADY_FED", "Шишколап уже сыт: бонус ждёт следующей стройки");
      const construction = state.jobs.find(job => job.kind === "construction");
      if (construction && now >= Date.parse(construction.finishesAt))
        return fail("ECONOMY_JOB_READY", "Стройка уже завершена. Сначала заберите результат");
      if (construction?.meal) return fail("ECONOMY_ALREADY_FED", "Шишколап уже поел для этой стройки");
      debit(state, { coins: 0, items: { [meal.itemId]: 1 } });
      if (construction) {
        const remaining = Date.parse(construction.finishesAt) - now;
        construction.finishesAt = new Date(now + tradeMealDuration(remaining, construction.tradeSpeedBps ?? 0, meal.builderSpeedBps)).toISOString();
        construction.meal = { itemId: meal.itemId, consumer: "builder", speedBps: meal.builderSpeedBps };
      } else state.food = { ...food, builderMeal: meal.itemId, builderMealSpeedBps: meal.builderSpeedBps };
      return construction ? `Шишколап поел и строит на ${meal.builderSpeedBps / 100}% быстрее` : "Шишколап поел. Следующая стройка будет быстрее";
    }
    case "accept_weekly_order": {
      const board = weeklyOrderBoard(state, now);
      if (!board.canChoose) return fail("ECONOMY_WEEKLY_UNAVAILABLE", "Недельное поручение уже выбрано. Следующий выбор откроется после указанного срока");
      const candidate = board.offers.find(offer => offer.id === command.targetId);
      if (!candidate) return fail("ECONOMY_WEEKLY_CHANGED", "Поручения изменились. Проверьте доступные предложения жителей");
      acceptWeeklyOrder(state, candidate, now);
      return "Недельное поручение принято. На три поставки есть семь дней";
    }
    case "complete_resident_order":
    case "replace_resident_order": {
      if (command.targetId.startsWith("weekly1_")) {
        const board = weeklyOrderBoard(state, now), saved = tradeRelationsState(state).weekly;
        if (saved && now >= Date.parse(saved.expiresAt)) return fail("ECONOMY_WEEKLY_EXPIRED", "Срок поручения закончился. Полученные награды сохранены");
        const offer = board.active;
        if (command.action !== "complete_resident_order" || !offer || offer.id !== command.targetId || !board.progress)
          return fail("ECONOMY_WEEKLY_CHANGED", "Эта поставка уже выполнена или поручение изменилось");
        if (now < Date.parse(offer.availableAt)) return fail("ECONOMY_WEEKLY_UNAVAILABLE", "Время принятия поручения ещё не наступило. Обновите состояние");
        requireBuildings(state, offer.requiredBuildings ?? {});
        const orders = normalizedResidentOrders(state, now), current = tradeRelationsState(state);
        const completed = board.progress.stage + 1 === board.progress.stages.length;
        if (state.wallet.coins > ECONOMY_MAX_BALANCE - offer.coins || state.wallet.pearls > ECONOMY_MAX_PEARLS - (offer.pearls ?? 0) || !Number.isSafeInteger(orders.earnedCoins + offer.coins)
          || orders.completed >= Number.MAX_SAFE_INTEGER || completed && current.completedWeekly >= Number.MAX_SAFE_INTEGER)
          return fail("ECONOMY_CAPACITY", "Нет места для награды");
        debit(state, { coins: 0, items: offer.items }, command.fishSelection ?? undefined);
        state.wallet.coins += offer.coins;
        state.wallet.pearls += offer.pearls ?? 0;
        state.residentOrders = { ...orders, completed: orders.completed + 1, earnedCoins: orders.earnedCoins + offer.coins };
        const awarded = awardTradeOrderXp(state, offer.residentId, offer.reputationXp ?? 0, now, true);
        const relations = tradeRelationsState(state);
        state.tradeRelations = { ...relations, completedWeekly: relations.completedWeekly + Number(completed),
          weekly: completed ? null : { ...board.progress, stage: board.progress.stage + 1 } };
        return completed ? `Поручение завершено. Монеты и ${awarded} репутации получены` : `Поставка принята. Получено ${awarded} репутации, открыта следующая часть поручения`;
      }
      if (isStageOrderId(command.targetId)) {
        const home = state.buildings.home ?? 1, course = economyCatalog.stageOrders?.find(stage => stage.homeLevel === home);
        const progress = stageOrderProgress(state, home), offer = stageResidentOrder(state);
        if (command.action !== "complete_resident_order" || !course || progress.completed || progress.step >= course.orders.length
          || !progress.terms || !offer || offer.id !== command.targetId)
          return fail("ECONOMY_STAGE_ORDER_UNAVAILABLE", "Постоянный заказ недоступен или уже выполнен");
        if (now < Date.parse(offer.availableAt)) return fail("ECONOMY_STAGE_WAIT", "Следующая просьба ещё не готова. Дождитесь указанного времени");
        requireBuildings(state, offer.requiredBuildings ?? {});
        if (Object.entries(offer.requiredExplorations ?? {}).some(([routeId, count]) => (state.progression?.routes[routeId] ?? 0) < count))
          return fail("ECONOMY_EXPLORATION_REQUIRED", "Сначала завершите нужную экспедицию и заберите её результат");
        const nextStep = progress.step + 1, completed = nextStep === course.orders.length;
        const nextTerms = completed ? progress.terms : course.orders[nextStep];
        if (!nextTerms) return fail("ECONOMY_STAGE_ORDER_UNAVAILABLE", "Следующий постоянный заказ пока недоступен");
        const orders = normalizedResidentOrders(state, now);
        if (offer.coins > ECONOMY_MAX_BALANCE - state.wallet.coins || !Number.isSafeInteger(orders.earnedCoins + offer.coins)
          || orders.completed >= Number.MAX_SAFE_INTEGER) return fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
        const earnedRewards = completed ? progress.completionRewards ?? course.completionRewards : {};
        const delivered = { ...state, wallet: { ...state.wallet }, inventory: { ...state.inventory } };
        debit(delivered, { coins: 0, items: offer.items }, command.fishSelection ?? undefined);
        creditEconomyItems(delivered, earnedRewards);
        assertEconomyStorageTransition(state, delivered, reservedItems);
        state.inventory = delivered.inventory;
        state.fishing = delivered.fishing;
        state.wallet.coins += offer.coins;
        state.residentOrders = { ...orders, completed: orders.completed + 1, earnedCoins: orders.earnedCoins + offer.coins };
        const current = stageOrdersProgress(state);
        state.stageOrders = { ...current, stages: { ...current.stages, [String(home)]: {
          ...progress, step: nextStep, completed, terms: { ...nextTerms, items: { ...nextTerms.items },
            ...(nextTerms.requiredBuildings ? { requiredBuildings: { ...nextTerms.requiredBuildings } } : {}),
            ...(nextTerms.requiredExplorations ? { requiredExplorations: { ...nextTerms.requiredExplorations } } : {}) },
          availableAt: completed ? null : new Date(now + (progress.intervalSeconds ?? course.intervalSeconds) * 1000).toISOString() } } };
        state.unlockedItems = [...new Set([...(state.unlockedItems ?? []), ...Object.entries(earnedRewards).filter(([, quantity]) => quantity > 0).map(([itemId]) => itemId)])];
        return completed ? "Все постоянные заказы этапа выполнены. Монеты получены" : "Постоянный заказ выполнен. Следующая просьба открыта";
      }
      if (isTutorialOrderId(command.targetId)) {
        const progress = tutorialOrderProgress(state), offer = tutorialResidentOrder(state);
        if (command.action !== "complete_resident_order" || !progress.ingredientsClaimed || progress.completed || progress.version === 3 && progress.step >= 1 || !progress.terms || !offer || offer.id !== command.targetId)
          return fail("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", "Учебный заказ недоступен или уже выполнен");
        const nextStep = progress.version === 1 ? progress.step : 1;
        const completed = true;
        const nextTerms = progress.terms;
        if (!nextTerms) return fail("ECONOMY_TUTORIAL_ORDER_UNAVAILABLE", "Следующий учебный заказ пока недоступен");
        const orders = normalizedResidentOrders(state, now);
        if (offer.coins > ECONOMY_MAX_BALANCE - state.wallet.coins || !Number.isSafeInteger(orders.earnedCoins + offer.coins)
          || orders.completed >= Number.MAX_SAFE_INTEGER) return fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
        debit(state, { coins: 0, items: offer.items }, command.fishSelection ?? undefined);
        state.wallet.coins += offer.coins;
        state.residentOrders = { ...orders, completed: orders.completed + 1, earnedCoins: orders.earnedCoins + offer.coins };
        state.tutorialOrder = { ...progress, step: nextStep, completed, terms: { ...nextTerms, items: { ...nextTerms.items } } };
        return "Первый заказ выполнен. Теперь доступны просьбы для улучшения дома";
      }
      const config = economyCatalog.food?.orders;
      const board = residentOrderBoard(state, now);
      const offer = board.offers.find(item => item.id === command.targetId);
      if (!config || !offer) return fail("ECONOMY_ORDER_CHANGED", "Заказы обновились. Выберите актуальную просьбу жителя");
      const current = normalizedResidentOrders(state, now);
      if (current.slots[offer.slot].sequence >= Number.MAX_SAFE_INTEGER) return fail("ECONOMY_CAPACITY", "Заказы требуют обслуживания");
      const complete = command.action === "complete_resident_order";
      const selected = current.slots[offer.slot];
      const retiringReplacement = !complete && current.version === 3 && selected.residentId && current.slots.some((entry, index) => index !== offer.slot
        && !entry.retired && entry.residentId === selected.residentId && entry.templateId);
      const price = complete || retiringReplacement ? 0 : board.replacementPricePearls;
      if (!complete && price > command.totalPrice) return fail("ECONOMY_ORDER_PRICE_CHANGED", "Цена замены изменилась. Проверьте стоимость и подтвердите снова");
      if (!complete && state.wallet.pearls < price) return fail("ECONOMY_PEARLS", "Не хватает жемчуга для замены заказа");
      if (complete && (state.wallet.coins + offer.coins > ECONOMY_MAX_BALANCE || !Number.isSafeInteger(current.earnedCoins + offer.coins)
        || current.completed >= Number.MAX_SAFE_INTEGER)) return fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
      const orders = advanceResidentOrder(state, offer.slot, now);
      const nextTemplate = orders.slots[offer.slot].terms;
      const retiring = Boolean(orders.slots[offer.slot].retired);
      if (!complete && !retiring && (!nextTemplate || nextTemplate.id === offer.templateId
        || Object.keys(nextTemplate.items).length === Object.keys(offer.items).length
          && Object.entries(nextTemplate.items).every(([id, quantity]) => offer.items[id] === quantity)))
        return fail("ECONOMY_ORDER_NO_ALTERNATIVE", "Других подходящих заказов пока нет. Замена не потрачена");
      if (complete) {
        debit(state, { coins: 0, items: offer.items }, command.fishSelection ?? undefined);
        state.wallet.coins += offer.coins;
        orders.completed++;
        orders.earnedCoins += offer.coins;
        awardTradeOrderXp(state, offer.residentId, offer.reputationXp ?? 0, now);
      } else if (!retiring) {
        state.wallet.pearls -= price;
        if (board.freeReplacementsRemaining > 0) orders.freeReplacementsUsed++;
      }
      state.residentOrders = orders;
      return complete ? "Заказ выполнен. Монеты и репутация получены" : retiring ? "Прежняя просьба убрана. Другой заказ этого жителя уже на доске" : "Заказ заменён. Новая просьба уже доступна";
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
    case "claim_garden_collection": {
      const jobs = state.jobs.filter(job => job.collection?.batchId === command.targetId);
      if (!jobs.length) return fail("ECONOMY_JOB_GONE", "Урожай уже получен или сбор не найден");
      for (const job of jobs) {
        if (now < Date.parse(job.finishesAt)) return fail("ECONOMY_JOB_NOT_READY", "Урожай ещё не созрел");
        if (!job.collection?.startedAt || !job.collection.finishesAt) return fail("ECONOMY_COLLECTION_REQUIRED", "Сначала отправьте Мохлика собрать урожай");
        if (now < Date.parse(job.collection.finishesAt)) return fail("ECONOMY_COLLECTION_NOT_READY", "Мохлик ещё собирает урожай");
      }
      const rewards: Record<string, number> = {};
      for (const job of jobs) for (const [item, quantity] of Object.entries(job.rewards)) rewards[item] = (rewards[item] ?? 0) + quantity;
      const inventory = { ...state.inventory };
      for (const [item, quantity] of Object.entries(rewards)) inventory[item] = (inventory[item] ?? 0) + quantity;
      assertEconomyStorageTransition(state, { ...state, inventory }, reservedItems);
      creditEconomyItems(state, rewards);
      for (const job of jobs) state.progression = advanceEconomyProgression(state.progression, job);
      const ids = new Set(jobs.map(job => job.id));
      state.jobs = state.jobs.filter(job => !ids.has(job.id));
      state.unlockedItems = [...new Set([...(state.unlockedItems ?? []), ...Object.entries(rewards).filter(([, quantity]) => quantity > 0).map(([item]) => item)])];
      return "Весь собранный урожай доставлен на склад";
    }
    case "claim_production": {
      if (!productionStationSupported(command.targetId)) return fail("ECONOMY_PRODUCTION_STATION", "В этом месте нет производства");
      const jobs = readyProductionJobs(state.jobs, command.targetId, now);
      if (!jobs.length) return fail("ECONOMY_JOB_NOT_READY", "Пока нет готовой продукции");
      const rewards = productionCollectionRewards(jobs), inventory = { ...state.inventory };
      for (const [item, quantity] of Object.entries(rewards)) inventory[item] = (inventory[item] ?? 0) + quantity;
      assertEconomyStorageTransition(state, { ...state, inventory }, reservedItems);
      creditEconomyItems(state, rewards);
      for (const job of jobs) state.progression = advanceEconomyProgression(state.progression, job);
      const ids = new Set(jobs.map(job => job.id));
      state.jobs = state.jobs.filter(job => !ids.has(job.id));
      state.unlockedItems = [...new Set([...(state.unlockedItems ?? []), ...Object.entries(rewards).filter(([, quantity]) => quantity > 0).map(([item]) => item)])];
      return "Вся готовая продукция доставлена в кладовую";
    }
    case "claim_job": {
      const job = state.jobs.find(item => item.id === command.targetId);
      if (!job) return fail("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено");
      if (now < Date.parse(job.finishesAt)) fail("ECONOMY_JOB_NOT_READY", "Работа ещё не закончена");
      if (job.collection) {
        if (job.collection.batchId) return fail("ECONOMY_COLLECTION_BATCH_REQUIRED", "Заберите весь собранный урожай вместе");
        if (!job.collection.startedAt || !job.collection.finishesAt) fail("ECONOMY_COLLECTION_REQUIRED", "Сначала отправьте Мохлика собрать урожай");
        if (now < Date.parse(job.collection.finishesAt!)) fail("ECONOMY_COLLECTION_NOT_READY", "Мохлик ещё собирает урожай");
      }
      const delivered = { ...job, rewards: expeditionJobRewards(job) };
      if (job.kind === "construction") state.buildings[job.targetId] = job.targetLevel!;
      else {
        const inventory = { ...state.inventory };
        for (const [item, quantity] of Object.entries(delivered.rewards)) inventory[item] = (inventory[item] ?? 0) + quantity;
        assertEconomyStorageTransition(state, { ...state, inventory }, reservedItems);
        creditEconomyItems(state, delivered.rewards);
      }
      state.progression = advanceEconomyProgression(state.progression, delivered);
      if (job.rareDrop) {
        if (!economyCatalog.rareDrops) return fail("ECONOMY_RARE_STATE", "Не удалось проверить редкую находку");
        if (isMinerJob(job)) state.minerRareDropState = settleRareDrop(state.minerRareDropState, job.rareDrop, economyCatalog.rareDrops, rareRandom);
        else state.rareDropState = settleRareDrop(state.rareDropState, job.rareDrop, economyCatalog.rareDrops, rareRandom);
      }
      if (job.kind === "exploration" && !isMinerJob(job) && !job.targetId.startsWith("quarry_")) state.completedExplorations = Math.min(ECONOMY_MAX_ITEMS, state.completedExplorations + 1);
      if (job.kind === "exploration" && !isMinerJob(job) && economyCatalog.fishing?.routeIds.includes(job.targetId)) {
        creditFishStock(state, job.rewards);
        const current = fishingState(state), catches = { ...current.catches };
        for (const fish of economyCatalog.fishing.fish) if (job.rewards[fish.itemId])
          catches[fish.itemId] = Math.min(ECONOMY_MAX_ITEMS, (catches[fish.itemId] ?? 0) + job.rewards[fish.itemId]);
        state.fishing = { ...current, catches };
        state.fishingCastSeed = null;
      }
      state.jobs = state.jobs.filter(item => item.id !== job.id);
      if (job.kind !== "construction") state.unlockedItems = [...new Set([...(state.unlockedItems ?? []), ...Object.entries(delivered.rewards).filter(([, quantity]) => quantity > 0).map(([itemId]) => itemId)])];
      return job.kind === "construction" ? "Постройка готова" : "Результат получен";
    }
    case "refresh_fishing_shop": {
      const shop = state.fishingShop, spec = economyCatalog.fishing?.shop;
      if (!shop || !spec || shop.id !== command.targetId || fishingShopExpired(shop, now))
        return fail("ECONOMY_FISHING_SHOP_CHANGED", "Предложения обновились. Загляните в лавку ещё раз");
      const price = fishingShopRefreshPrice(shop, now, spec);
      if (price > command.totalPrice) return fail("ECONOMY_FISHING_PRICE_CHANGED", "Цена обновления изменилась. Проверьте предложение Плёски");
      if (state.wallet.pearls < price) return fail("ECONOMY_PEARLS", "Не хватает жемчужин для обновления лавки");
      const next = refreshFishingShop(state, now, rareRandom);
      if (!next) return fail("ECONOMY_FISHING_SHOP_NO_REPLACEMENT", "Плёска ждёт новую поставку. Жемчужины не потрачены");
      state.wallet.pearls -= price;
      state.fishingShop = next;
      return "Плёска подготовила новые предложения";
    }
    case "buy_leaftail_item": {
      // The adapter has already authenticated command.ownerPublicId before this
      // transition; it is the same identity used by the displayed snapshot.
      const shop = leaftailShopView({ ...state, ownerPublicId: command.ownerPublicId }, now);
      if (!shop) return fail("ECONOMY_LEAFTAIL_UNAVAILABLE", "Листохвост пока не открыл лавку");
      const unitSales = leaftailShopUsesUnits(economyCatalog);
      if (command.quantity > (unitSales ? 20 : 1))
        throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Проверьте количество товара", 400);
      requireHome(state, shop.requiredHomeLevel);
      const offer = shop.offers.find(item => item.targetId === command.targetId);
      if (!offer) return fail("ECONOMY_LEAFTAIL_SHOP_CHANGED", "Поставка Листохвоста изменилась. Проверьте прилавок");
      requireHome(state, offer.requiredHomeLevel);
      const item = offer.kind === "item" && economyCatalog.items.find(item => item.id === offer.itemId);
      const clothing = offer.kind === "wardrobe" && wardrobeItems.find(item => item.id === offer.itemId && !item.premium && !item.starter && !item.purchase && item.sparks === 0);
      const rod = offer.kind === "rod" && economyCatalog.fishing?.rods.find(item => item.id === offer.itemId);
      const hook = offer.kind === "hook" && economyCatalog.fishing?.hooks.find(item => item.id === offer.itemId);
      const bait = offer.kind === "bait" && economyCatalog.fishing?.baits.find(item => item.itemId === offer.itemId);
      const gear = rod || hook || bait;
      if (item ? (item.category === "special" ? item.tradable || offer.quantity !== 1
        || unitSales && offer.currency !== "pearls" : offer.currency !== "coins" || !item.tradable
        || !["material", "crafted", "provisions", "produce"].includes(item.category)
        || (offer.baseUnitPrice ?? offer.unitPrice) < 2 * item.baseSellPrice * offer.quantity)
        : clothing ? offer.quantity !== 1 || offer.currency !== "coins" : !gear || offer.currency !== "coins"
          || (offer.baseUnitPrice ?? offer.unitPrice) !== gear.price * offer.quantity || !bait && offer.quantity !== 1)
        return fail("ECONOMY_LEAFTAIL_SHOP_CHANGED", "Этот товар пока недоступен");
      if ((offer.currency === "pearls" || clothing || rod || hook) && command.quantity !== 1)
        throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Эту вещь можно купить только одну", 400);
      const price = offer.unitPrice * command.quantity, quantity = offer.quantity * command.quantity;
      if (command.totalPrice !== price)
        return fail("ECONOMY_LEAFTAIL_PRICE_CHANGED", "Цена изменилась. Проверьте предложение Листохвоста");
      if (offer.remaining < command.quantity) return fail("ECONOMY_LEAFTAIL_STOCK", "В поставке осталось меньше товара. Проверьте количество");
      if (offer.owned) return fail(clothing ? "ECONOMY_WARDROBE_OWNED" : "ECONOMY_FISHING_OWNED",
        clothing ? "Эта вещь уже есть в гардеробе" : "Эта снасть уже есть в коллекции");
      if (state.wallet[offer.currency] < price) return fail(offer.currency === "pearls" ? "ECONOMY_PEARLS" : "ECONOMY_RESOURCES",
        offer.currency === "pearls" ? "Не хватает жемчужин" : "Не хватает монет");
      const inventory = item || bait ? { ...state.inventory, [offer.itemId]: (state.inventory[offer.itemId] ?? 0) + quantity } : state.inventory;
      if (item || bait) assertEconomyStorageTransition(state, { ...state, inventory }, reservedItems);
      const stock = leaftailShopStock(state, now), current = fishingState(state);
      // Every validation precedes the debit; the caller commits state and its receipt atomically.
      state.wallet[offer.currency] -= price;
      state.inventory = inventory;
      if (clothing) state.wardrobe = wardrobeOwned(state.wardrobe, [clothing.id]);
      if (rod) state.fishing = { ...current, ownedRods: [...current.ownedRods, rod.id] };
      if (hook) state.fishing = { ...current, ownedHooks: [...current.ownedHooks, hook.id] };
      state.leaftailShop = { cycle: stock.cycle, purchased: { ...stock.purchased, [offer.id]: (stock.purchased[offer.id] ?? 0) + command.quantity } };
      const resaleCoins = item && item.tradable && offer.currency === "coins"
        ? economyLocalSellPrice(item.baseSellPrice, quantity, economyCatalog.localBuyer, item.id) : 0;
      if (tradePurchaseXpEligible(offer.kind, price, resaleCoins)) awardTradePurchaseXp(state, "leaftail", now);
      return clothing ? "Покупка у Листохвоста добавлена в гардероб" : rod ? "Удочка у Листохвоста добавлена в коллекцию"
        : hook ? "Крючок у Листохвоста добавлен в коллекцию" : "Покупка у Листохвоста отправлена в кладовую";
    }
    case "buy_wardrobe_item": {
      const item = wardrobeItems.find(item => !item.premium && item.purchase && wardrobePurchaseTarget(item) === command.targetId);
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
      const rod = offer.kind === "rod" ? catalog.rods.find(item => item.id === offer.itemId && item.shop !== "leaftail") : undefined;
      const hook = offer.kind === "hook" ? catalog.hooks.find(item => item.id === offer.itemId && item.shop !== "leaftail") : undefined;
      const bait = offer.kind === "bait" ? catalog.baits.find(item => item.itemId === offer.itemId && item.shop !== "leaftail") : undefined;
      const fish = offer.kind === "fish" ? fishClassForItem(offer.itemId, catalog) : undefined;
      if (!rod && !hook && !bait && fish?.rarity !== "common") return fail("ECONOMY_FISHING_ITEM", "Плёска не продаёт этот предмет");
      requireHome(state, (rod ?? hook ?? bait)?.requiredHomeLevel ?? 1);
      if (command.quantity > economyCatalog.maxBatch || (rod || hook) && command.quantity !== 1)
        throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Проверьте количество товара", 400);
      if (rod && current.ownedRods.includes(rod.id)) return fail("ECONOMY_FISHING_OWNED", "Эта удочка уже есть в коллекции");
      if (hook && current.ownedHooks.includes(hook.id)) return fail("ECONOMY_FISHING_OWNED", "Этот крючок уже есть в коллекции");
      if (command.quantity > offer.remaining) return fail("ECONOMY_FISHING_STOCK", "Плёска уже продала эту партию. Дождитесь новых предложений");
      const price = fishingOfferUnitPrice(state, offer, economyCatalog, now) * command.quantity;
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
      const resaleCoins = fish ? (economyCatalog.items.find(item => item.id === fish.itemId)?.baseSellPrice ?? 0) * command.quantity : 0;
      if (tradePurchaseXpEligible(offer.kind, price, resaleCoins)) awardTradePurchaseXp(state, "plesk", now);
      return rod ? "Удочка добавлена в коллекцию" : hook ? "Крючок добавлен в коллекцию" : "Покупка у Плёски отправлена на склад";
    }
    case "equip_fishing_rod": {
      const current = fishingState(state);
      if (!economyCatalog.fishing?.rods.some(rod => rod.id === command.targetId) || !current.ownedRods.includes(command.targetId))
        return fail("ECONOMY_FISHING_ROD", "Сначала приобретите эту удочку");
      state.fishing = { ...current, equippedRodId: command.targetId,
        equippedBaitId: fishingBaitCompatible(command.targetId, current.equippedBaitId) ? current.equippedBaitId : null };
      return "Удочка выбрана для следующих вылазок";
    }
    case "equip_fishing_bait": {
      const baitId = command.targetId === "none" ? null : command.targetId;
      if (baitId && !economyCatalog.fishing?.baits.some(bait => bait.itemId === baitId))
        return fail("ECONOMY_FISHING_BAIT", "Наживка не найдена");
      if (!fishingBaitCompatible(fishingState(state).equippedRodId, baitId))
        return fail("ECONOMY_FISHING_BAIT", "Эта удочка не ловит рыбу для выбранной наживки");
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
      if (command.action === "sell_fish" && !fishClassForItem(command.targetId))
        return fail("ECONOMY_FISHING_ITEM", "Плёска принимает здесь только рыбу");
      const item = economyCatalog.items.find(item => item.id === fishingClassItemId(command.targetId) && item.tradable && item.category !== "special");
      if (!item) return fail("ECONOMY_ITEM", "Этот предмет нельзя продать");
      if ((state.inventory[item.id] ?? 0) < command.quantity) fail("ECONOMY_RESOURCES", "Не хватает предметов для продажи");
      const coins = command.action === "sell_fish" ? command.quantity * item.baseSellPrice
        : economyLocalSellPrice(item.baseSellPrice, command.quantity, economyCatalog.localBuyer, item.id);
      if (coins === 0) return fail("ECONOMY_SALE_QUANTITY", "Для продажи добавьте предметы в партию: выручка должна быть хотя бы одна монета");
      if (command.action === "sell" && coins < command.totalPrice)
        return fail("ECONOMY_SALE_PRICE_CHANGED", "Выручка изменилась. Проверьте цену продажи и подтвердите снова");
      if (state.wallet.coins + coins > ECONOMY_MAX_BALANCE) fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
      debit(state, { coins: 0, items: { [item.id]: command.quantity } }, command.fishSelection ?? undefined);
      state.wallet.coins += coins;
      return "Предметы проданы местному покупателю";
    }
  }
}
