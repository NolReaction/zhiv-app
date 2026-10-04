import { ECONOMY_MAX_BALANCE, economyCatalog, type EconomyCommand, type EconomyCost, type EconomyJob, type EconomyState, type EconomyStorage } from "./model";

export class EconomyRuleError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
/** A display quote only: the authoritative command recomputes this from its own clock. */
export function constructionSpeedupPrice(job: Pick<EconomyJob, "kind" | "finishesAt">, now: number,
  config = economyCatalog.constructionSpeedup): number {
  if (job.kind !== "construction") return 0;
  return Math.ceil(Math.max(0, Date.parse(job.finishesAt) - now) / (config.secondsPerPearl * 1000));
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
  if (Object.values(totals).some(quantity => quantity > ECONOMY_MAX_BALANCE)) fail("ECONOMY_CAPACITY", "Сначала освободите место для этого материала");
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
  return { version: 1 as const, coinsGranted: Math.min(500, Math.floor(2 * Math.sqrt(safe(resources.sparks)) + wood + stone)),
    woodGranted: Math.min(30, Math.floor(wood)), stoneGranted: Math.min(30, Math.floor(stone)) };
}
export function newEconomyState(legacy: { resources: { sparks: number; wood: number; stone: number }; houseLevel: number; workshopLevel: number }): EconomyState {
  const migration = convertLegacyEconomy(legacy.resources);
  return { wallet: { coins: migration.coinsGranted, pearls: 0 },
    inventory: { ...(migration.woodGranted ? { wood: migration.woodGranted } : {}), ...(migration.stoneGranted ? { stone: migration.stoneGranted } : {}) },
    buildings: Object.fromEntries(economyCatalog.buildings.map(building => [building.id, building.id === "home" ? Math.max(1, Math.min(5, legacy.houseLevel))
      : ["garden", "warehouse"].includes(building.id) ? 1 : building.id === "workshop" ? Math.max(0, Math.min(3, legacy.workshopLevel)) : 0])),
    jobs: [], migration, completedExplorations: 0 };
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
    if ((state.inventory[item] ?? 0) + amount > ECONOMY_MAX_BALANCE) fail("ECONOMY_CAPACITY", "Сначала освободите место для этого материала");
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
/** Pure domain transition. The caller owns the clone, authentication, receipt and atomic commit. */
export function applyEconomyCommand(state: EconomyState, command: EconomyCommand, now: number, jobId: () => string, reservedItems: Record<string, number> = {}): string {
  if (command.action !== "speedup_construction" && command.totalPrice !== 0) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Цена не используется в этом действии", 400);
  const createJob = (job: Pick<EconomyJob, "kind" | "targetId" | "recipeId" | "targetLevel" | "rewards" | "collection">, seconds: number, cost: EconomyCost) => {
    if (Object.values(job.rewards).reduce((total, quantity) => total + quantity, 0) > economyStorage(state).capacity)
      fail("ECONOMY_STORAGE_FULL", "Вся партия не поместится на складе. Уменьшите её или расширьте склад");
    debit(state, cost);
    state.jobs.push({ ...job, id: jobId(), startedAt: new Date(now).toISOString(), finishesAt: new Date(now + seconds * 1000).toISOString(), cost, catalogVersion: economyCatalog.version });
  };
  if (!["start_production", "sell"].includes(command.action) && command.quantity !== 1) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Для этого действия количество должно быть равно одному", 400);
  switch (command.action) {
    case "start_production": {
      if (command.quantity > economyCatalog.maxBatch) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Слишком большая партия", 400);
      const recipe = economyCatalog.recipes.find(item => item.id === command.targetId);
      if (!recipe) return fail("ECONOMY_RECIPE", "Рецепт не найден");
      if ((state.buildings[recipe.buildingId] ?? 0) < recipe.buildingLevel) fail("ECONOMY_BUILDING_REQUIRED", "Сначала постройте или улучшите нужное здание");
      requireHome(state, recipe.requiredHomeLevel);
      requireBuildings(state, recipe.requiredBuildings);
      if (state.jobs.some(job => job.targetId === recipe.buildingId && ["production", "construction"].includes(job.kind))) fail("ECONOMY_BUILDING_BUSY", "Здание уже занято. Заберите готовый результат");
      createJob({ kind: "production", targetId: recipe.buildingId, recipeId: recipe.id, targetLevel: null,
        ...(recipe.collection ? { collection: { ...recipe.collection, startedAt: null, finishesAt: null } } : {}),
        rewards: Object.fromEntries(Object.entries(recipe.rewards).map(([item, amount]) => [item, amount * command.quantity])) },
      recipe.seconds * command.quantity, scaledEconomyCost(recipe.cost, command.quantity));
      return "Производство запущено";
    }
    case "start_collection": {
      const job = state.jobs.find(item => item.id === command.targetId);
      if (!job) return fail("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено");
      const spec = job.collection ?? economyCatalog.recipes.find(recipe => recipe.id === job.recipeId)?.collection;
      if (job.kind !== "production" || job.targetId !== "garden" || !(job.rewards.berries > 0) || !spec)
        return fail("ECONOMY_COLLECTION_KIND", "Для этой работы сбор Мохликом не требуется");
      if (job.collection?.startedAt) return fail("ECONOMY_COLLECTION_STARTED", "Мохлик уже собирает этот урожай");
      if (now < Date.parse(job.finishesAt)) return fail("ECONOMY_JOB_NOT_READY", "Урожай ещё не созрел");
      if (state.jobs.some(item => item.kind === "exploration" && now < Date.parse(item.finishesAt)))
        return fail("ECONOMY_EXPLORER_BUSY", "Мохлик ещё в вылазке. Дождитесь его возвращения");
      if (state.jobs.some(item => item.collection?.startedAt))
        return fail("ECONOMY_COLLECTOR_BUSY", "Сначала завершите текущий сбор припасов");
      const inventory = { ...state.inventory };
      for (const [item, quantity] of Object.entries(job.rewards)) inventory[item] = (inventory[item] ?? 0) + quantity;
      assertEconomyStorageTransition(state, { ...state, inventory }, reservedItems);
      job.collection = { kind: spec.kind, seconds: spec.seconds,
        startedAt: new Date(now).toISOString(), finishesAt: new Date(now + spec.seconds * 1000).toISOString() };
      return "Мохлик отправился собирать урожай";
    }
    case "start_exploration": {
      const route = economyCatalog.explorations.find(item => item.id === command.targetId);
      if (!route) return fail("ECONOMY_EXPLORATION", "Место исследования не найдено");
      requireHome(state, route.requiredHomeLevel);
      requireBuildings(state, route.requiredBuildings);
      if (state.jobs.some(job => job.collection?.startedAt)) fail("ECONOMY_COLLECTOR_BUSY", "Сначала завершите сбор припасов");
      if (state.jobs.some(job => job.kind === "exploration")) fail("ECONOMY_EXPLORER_BUSY", "Мохлик уже исследует мир. Заберите его находки");
      createJob({ kind: "exploration", targetId: route.id, recipeId: null, targetLevel: null, rewards: { ...route.rewards } }, route.seconds, route.cost);
      return "Мохлик отправился исследовать мир";
    }
    case "start_construction": {
      const building = economyCatalog.buildings.find(item => item.id === command.targetId);
      if (!building) return fail("ECONOMY_BUILDING", "Постройка не найдена");
      const target = building.levels.find(level => level.level === (state.buildings[building.id] ?? 0) + 1);
      if (!target) return fail("ECONOMY_MAX_LEVEL", "Доступные улучшения уже завершены");
      requireHome(state, target.requiredHomeLevel);
      requireBuildings(state, target.requiredBuildings);
      if (state.jobs.some(job => job.kind === "construction")) fail("ECONOMY_CONSTRUCTION_BUSY", "Сначала завершите текущую стройку");
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
      if (job.kind === "exploration") state.completedExplorations = Math.min(ECONOMY_MAX_BALANCE, state.completedExplorations + 1);
      state.jobs = state.jobs.filter(item => item.id !== job.id);
      return job.kind === "construction" ? "Постройка готова" : "Результат получен";
    }
    case "sell": {
      const item = economyCatalog.items.find(item => item.id === command.targetId && item.tradable);
      if (!item) return fail("ECONOMY_ITEM", "Этот предмет нельзя продать");
      if ((state.inventory[item.id] ?? 0) < command.quantity) fail("ECONOMY_RESOURCES", "Не хватает предметов для продажи");
      const coins = command.quantity * item.baseSellPrice;
      if (state.wallet.coins + coins > ECONOMY_MAX_BALANCE) fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
      state.inventory[item.id] -= command.quantity; state.wallet.coins += coins;
      if (!state.inventory[item.id]) delete state.inventory[item.id];
      return "Предметы проданы местному покупателю";
    }
  }
}
