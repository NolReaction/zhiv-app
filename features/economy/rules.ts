import { ECONOMY_MAX_BALANCE, economyCatalog, type EconomyCommand, type EconomyCost, type EconomyJob, type EconomyState } from "./model";

export class EconomyRuleError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
const fail = (code: string, message: string): never => { throw new EconomyRuleError(code, message); };
export function canAffordEconomy(state: Pick<EconomyState, "wallet" | "inventory">, cost: EconomyCost, quantity = 1) {
  return state.wallet.coins >= cost.coins * quantity && Object.entries(cost.items).every(([item, amount]) => (state.inventory[item] ?? 0) >= amount * quantity);
}
export function scaledEconomyCost(cost: EconomyCost, quantity: number): EconomyCost {
  return { coins: cost.coins * quantity, items: Object.fromEntries(Object.entries(cost.items).map(([item, amount]) => [item, amount * quantity])) };
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
      : building.id === "garden" ? 1 : building.id === "workshop" ? Math.max(0, Math.min(3, legacy.workshopLevel)) : 0])),
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
/** Pure domain transition. The caller owns the clone, authentication, receipt and atomic commit. */
export function applyEconomyCommand(state: EconomyState, command: EconomyCommand, now: number, jobId: () => string): string {
  if (command.totalPrice !== 0) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Цена не используется в этом действии", 400);
  const createJob = (job: Pick<EconomyJob, "kind" | "targetId" | "recipeId" | "targetLevel" | "rewards">, seconds: number, cost: EconomyCost) => {
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
      if (state.jobs.some(job => job.targetId === recipe.buildingId && ["production", "construction"].includes(job.kind))) fail("ECONOMY_BUILDING_BUSY", "Здание уже занято. Заберите готовый результат");
      createJob({ kind: "production", targetId: recipe.buildingId, recipeId: recipe.id, targetLevel: null,
        rewards: Object.fromEntries(Object.entries(recipe.rewards).map(([item, amount]) => [item, amount * command.quantity])) },
      recipe.seconds * command.quantity, scaledEconomyCost(recipe.cost, command.quantity));
      return "Производство запущено";
    }
    case "start_exploration": {
      const route = economyCatalog.explorations.find(item => item.id === command.targetId);
      if (!route) return fail("ECONOMY_EXPLORATION", "Место исследования не найдено");
      requireHome(state, route.requiredHomeLevel);
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
      if (state.jobs.some(job => job.kind === "construction")) fail("ECONOMY_CONSTRUCTION_BUSY", "Сначала завершите текущую стройку");
      if (state.jobs.some(job => job.kind === "production" && job.targetId === building.id)) fail("ECONOMY_BUILDING_BUSY", "Перед улучшением заберите результат производства");
      createJob({ kind: "construction", targetId: building.id, recipeId: null, targetLevel: target.level, rewards: {} }, target.seconds, target.cost);
      return "Строительство началось";
    }
    case "claim_job": {
      const job = state.jobs.find(item => item.id === command.targetId);
      if (!job) return fail("ECONOMY_JOB_GONE", "Результат уже получен или задание не найдено");
      if (now < Date.parse(job.finishesAt)) fail("ECONOMY_JOB_NOT_READY", "Работа ещё не закончена");
      if (job.kind === "construction") state.buildings[job.targetId] = job.targetLevel!;
      else creditEconomyItems(state, job.rewards);
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
