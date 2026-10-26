import type { MapObjectSelection, WorldPlace } from "@/features/world/scene/map-engine";
import { recipeBuildingLevel, type EconomyCatalog, type EconomyCost, type EconomyJob, type EconomyView } from "@/features/economy/domain/model";
import { fishClassForItem, fishClassInventory } from "@/features/economy/domain/fishing";
import { normalizedFishStock } from "@/features/economy/domain/fish-stock";
import { productionSlotCount } from "@/features/economy/domain/production-slots";
import { recipeResultName } from "@/features/economy/domain/recipe-prerequisites";
import { tutorialOrderProgress } from "@/features/economy/domain/tutorial-order";
import { stageCourseRequired, stageOrderProgress } from "@/features/economy/domain/stage-orders";
import { explorationActorId, isMinerJob } from "@/features/economy/domain/actor-availability";

export type WorldStationDefinition = { label: string; stationIds: readonly string[]; future?: string; status?: string };
export const worldStations: Partial<Record<WorldPlace, WorldStationDefinition>> = {
  house: { label: "Дом", stationIds: ["home", "warehouse"] },
  garden: { label: "Ягодный куст", stationIds: ["garden"] },
  campfire: { label: "Костёр", stationIds: ["dryer"] },
  workshop: { label: "Мастерская", stationIds: ["workshop", "kiln"] },
  woodlot: { label: "Лесной участок", stationIds: ["woodlot"] },
  quarry: { label: "Шахта", stationIds: ["quarry"] },
  bridge: { label: "Мост", stationIds: ["bridge"] },
  lighthouse: { label: "Маяк", stationIds: ["lighthouse"] },
  "leaftail-caravan": { label: "Лавка Листохвоста", stationIds: [], status: "Путник и торговец" },
  "lopukh-home": { label: "Дом Лопоуха", stationIds: ["woodlot"] },
};
export function worldPlaceForStation(stationId: string): WorldPlace | null {
  if (stationId === "woodlot") return "lopukh-home";
  const result = Object.entries(worldStations).find(([, value]) => value.stationIds.includes(stationId));
  return result ? result[0] as WorldPlace : null;
}
export type WorldMenuBounds = { top?: number; right?: number; bottom?: number; left?: number };
export function worldMenuDimensions(viewport: Pick<MapObjectSelection, "viewportWidth" | "viewportHeight">, bounds: WorldMenuBounds = {}) {
  const availableWidth = Math.max(1, viewport.viewportWidth - Math.max(8, bounds.left ?? 8) - Math.max(8, bounds.right ?? 8));
  const availableHeight = Math.max(1, viewport.viewportHeight - Math.max(8, bounds.top ?? 8) - Math.max(8, bounds.bottom ?? 8));
  const phone = viewport.viewportWidth <= 600;
  return { width: Math.min(phone ? 400 : 360, availableWidth), maxHeight: Math.min(phone ? 520 : 480, availableHeight) };
}
export function worldMenuPosition(selection: Pick<MapObjectSelection, "x" | "y" | "viewportWidth" | "viewportHeight">, size: { width: number; height: number }, bounds: WorldMenuBounds = {}) {
  const left = Math.max(8, bounds.left ?? 8), top = Math.max(8, bounds.top ?? 8);
  const right = Math.max(left + 1, selection.viewportWidth - Math.max(8, bounds.right ?? 8));
  const bottom = Math.max(top + 1, selection.viewportHeight - Math.max(8, bounds.bottom ?? 8));
  const width = Math.max(1, Math.min(size.width, right - left));
  const height = Math.max(1, Math.min(size.height, bottom - top));
  const gap = 18;
  const anchor = { x: Math.max(left, Math.min(right, selection.x)), y: Math.max(top, Math.min(bottom, selection.y)) };
  const candidates = [
    { side: "above", x: anchor.x - width / 2, y: anchor.y - height - gap },
    { side: "below", x: anchor.x - width / 2, y: anchor.y + gap },
    { side: "right", x: anchor.x + gap, y: anchor.y - height / 2 },
    { side: "left", x: anchor.x - width - gap, y: anchor.y - height / 2 },
  ];
  const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
  const options = candidates.map((candidate, index) => {
    const x = clamp(candidate.x, left, right - width), y = clamp(candidate.y, top, bottom - height);
    const coversAnchor = anchor.x >= x - 8 && anchor.x <= x + width + 8 && anchor.y >= y - 8 && anchor.y <= y + height + 8;
    return { ...candidate, x, y, score: (coversAnchor ? 10_000 : 0) + Math.abs(candidate.x - x) + Math.abs(candidate.y - y) + index };
  }).sort((a, b) => a.score - b.score);
  return { ...options[0], width, height, anchorX: clamp(anchor.x - options[0].x, 20, Math.max(20, width - 20)), anchorY: clamp(anchor.y - options[0].y, 20, Math.max(20, height - 20)) };
}
// Keep a stable frame across catalogue and preparation. On phones it sits above
// the dock, using the available height instead of following a cramped map anchor.
export function worldStableMenuPosition(selection: Pick<MapObjectSelection, "x" | "y" | "viewportWidth" | "viewportHeight">, bounds: WorldMenuBounds = {}) {
  const { width, maxHeight } = worldMenuDimensions(selection, bounds);
  if (selection.viewportWidth <= 600) {
    const left = Math.max(8, bounds.left ?? 8), right = Math.max(8, bounds.right ?? 8);
    const bottom = Math.max(8, bounds.bottom ?? 8);
    return { side: "sheet", x: left + Math.max(0, selection.viewportWidth - left - right - width) / 2,
      y: Math.max(Math.max(8, bounds.top ?? 8), selection.viewportHeight - bottom - maxHeight),
      width, height: maxHeight, anchorX: width / 2, anchorY: 0 };
  }
  return worldMenuPosition(selection, { width, height: maxHeight }, bounds);
}
export type WorldRecipe = EconomyCatalog["recipes"][number];
export type WorldBuildingLevel = EconomyCatalog["buildings"][number]["levels"][number];
export function worldRequirements(value: { requiredHomeLevel: number; requiredBuildings: Record<string, number> }, recipe?: Parameters<typeof recipeBuildingLevel>[0]) {
  const required: Record<string, number> = { ...value.requiredBuildings, home: Math.max(value.requiredHomeLevel, value.requiredBuildings.home ?? 0) };
  if (recipe) required[recipe.buildingId] = Math.max(required[recipe.buildingId] ?? 0, recipeBuildingLevel(recipe));
  return required;
}
export function worldMissingRequirements(state: EconomyView, required: Record<string, number>) {
  return Object.entries(required).filter(([id, level]) => (state.buildings[id] ?? 0) < level).map(([id, level]) => ({ id, level, current: state.buildings[id] ?? 0 }));
}
export function worldMaterialSource(state: EconomyView, itemId: string) {
  const recipes = state.catalog.recipes.filter(entry => !entry.retired && (entry.rewards[itemId] ?? 0) > 0);
  const recipe = recipes.find(entry => !worldMissingRequirements(state, worldRequirements(entry, entry)).length && !worldRecipeUnlockReason(state, entry));
  if (recipe) return { kind: "production" as const, stationId: recipe.buildingId, targetId: recipe.id };
  const fish = state.catalog.fishing && fishClassForItem(itemId, state.catalog.fishing);
  const explorations = state.catalog.explorations.filter(entry => !entry.retired && ((entry.rewards[itemId] ?? 0) > 0 || fish && state.catalog.fishing?.routeIds.includes(entry.id)) && !worldMissingRequirements(state, worldRequirements(entry)).length);
  const exploration = explorations.find(entry => explorationActorId(entry) === "miner")
    ?? state.catalog.explorations.find(entry => !entry.retired && (entry.rewards[itemId] ?? 0) > 0 && explorationActorId(entry) === "miner"
      && entry.requiredHomeLevel <= (state.buildings.home ?? 1)
      && worldMissingRequirements(state, worldRequirements(entry)).every(requirement => requirement.id === "quarry"))
    ?? explorations[0];
  if (exploration) return { kind: "exploration" as const, targetId: exploration.id };
  // A known but locked product still has a destination: explain its real unlock
  // there instead of dropping a source link or silently opening an empty menu.
  const future = recipes.find(entry => entry.requiredHomeLevel <= (state.buildings.home ?? 1)
    && worldMissingRequirements(state, worldRequirements(entry, entry)).every(required => required.id === entry.buildingId))
    ?? [...recipes].sort((left, right) => left.requiredHomeLevel - right.requiredHomeLevel
    || recipeBuildingLevel(left) - recipeBuildingLevel(right) || left.seconds - right.seconds)[0];
  return future ? { kind: "production" as const, stationId: future.buildingId, targetId: future.id } : null;
}
/** Species ownership comes from today's stock ledger, never the lifetime catch book. */
export function worldItemAvailable(state: EconomyView, itemId: string) {
  return state.catalog.fishing?.fish.some(fish => fish.itemId === itemId)
    ? normalizedFishStock(state)[itemId] ?? 0 : state.inventory[itemId] ?? 0;
}
export function worldRecipeCost(state: EconomyView, recipe: WorldRecipe): EconomyCost {
  return recipe.fishInput?.exactSpecies ? recipe.cost
    : { ...recipe.cost, items: fishClassInventory(recipe.cost.items, state.catalog.fishing) };
}
export function worldCostShortfalls(state: EconomyView, cost: EconomyCost, quantity = 1) {
  return [
    ...(state.wallet.coins < cost.coins * quantity ? [{ id: "coins", required: cost.coins * quantity, available: state.wallet.coins }] : []),
    ...Object.entries(cost.items).filter(([id, amount]) => worldItemAvailable(state, id) < amount * quantity).map(([id, amount]) => ({ id, required: amount * quantity, available: worldItemAvailable(state, id) })),
  ];
}
export function worldBatchLimit(state: EconomyView, recipe: WorldRecipe) {
  const output = Object.values(recipe.rewards).reduce((sum, amount) => sum + amount, 0);
  return Math.max(0, Math.min(recipe.maxBatch ?? state.catalog.maxBatch, state.catalog.maxBatch, Math.floor(state.storage.capacity / Math.max(1, output))));
}
export function worldMissingRecipeRequirements(state: EconomyView, recipe: WorldRecipe) {
  return Object.entries(recipe.requiredRecipes ?? {}).filter(([id, count]) => (state.progression?.recipes?.[id] ?? 0) < count)
    .map(([id, count]) => ({ id, count, current: state.progression?.recipes?.[id] ?? 0,
      recipe: state.catalog.recipes.find(entry => entry.id === id) }));
}
export function worldRecipeUnlockReason(state: EconomyView, recipe: WorldRecipe) {
  const first = worldMissingRecipeRequirements(state, recipe)[0];
  if (!first) return null;
  const action = first.recipe?.buildingId === "dryer" ? "Приготовьте" : "Произведите";
  return `${action} и заберите: ${recipeResultName(first.id, state.catalog)} (${first.current} / ${first.count})`;
}
/** Explain permanent access separately from temporary stock, queues and wallet limits. */
export function worldRecipeAccessReason(state: EconomyView, recipe: WorldRecipe) {
  if (recipe.retired) return "Этот способ больше недоступен. Выберите действующий рецепт";
  const required = worldMissingRequirements(state, worldRequirements(recipe, recipe));
  const names: Record<string, string> = { home: "дома", dryer: "костра", garden: "ягодного куста", workshop: "мастерской",
    kiln: "печи", warehouse: "кладовой", woodlot: "лесного участка", quarry: "шахты", bridge: "моста", lighthouse: "маяка" };
  if (required.length) return required.map(({ id, level }) => `Доступно с ${level} уровня ${names[id]
    ?? `постройки «${state.catalog.buildings.find(building => building.id === id)?.name ?? id}»`}`).join(". ");
  return worldRecipeUnlockReason(state, recipe);
}
export function worldMaterialAccessReason(state: EconomyView, itemId: string) {
  const source = worldMaterialSource(state, itemId);
  const recipe = source?.kind === "production" ? state.catalog.recipes.find(entry => entry.id === source.targetId) : undefined;
  return recipe ? worldRecipeAccessReason(state, recipe) : null;
}
export function worldProductionReason(state: EconomyView, recipe: WorldRecipe, quantity = 1) {
  const unlockReason = worldRecipeAccessReason(state, recipe);
  if (unlockReason) return unlockReason;
  if (recipe.buildingId === "quarry") return "Добыча доступна в вылазках Мохлика";
  if (state.jobs.some(job => job.kind === "construction" && job.targetId === recipe.buildingId)) return "Сначала завершите улучшение";
  if (state.jobs.filter(job => job.kind === "production" && job.targetId === recipe.buildingId).length >= productionSlotCount(state, recipe.buildingId)) return "Все места заняты: сначала заберите результат";
  if (quantity > worldBatchLimit(state, recipe)) return "Уменьшите партию или расширьте кладовую";
  if (worldCostShortfalls(state, worldRecipeCost(state, recipe), quantity).length) return "Не хватает материалов или монет";
  return null;
}
export function worldConstructionReason(state: EconomyView, stationId: string, target: WorldBuildingLevel) {
  const required = worldMissingRequirements(state, worldRequirements(target));
  if (required.length) return `${state.catalog.buildings.find(building => building.id === required[0].id)?.name ?? "Постройка"}: нужен уровень ${required[0].level}`;
  const tutorial = tutorialOrderProgress(state);
  if (stationId === "home" && target.level === 2 && tutorial.version !== 1 && !tutorial.completed)
    return "Выполните первый учебный заказ: 1 малина";
  if (stationId === "home" && stageCourseRequired(state, target.level)) {
    const home = state.buildings.home ?? 1;
    const count = state.catalog.stageOrders?.find(course => course.homeLevel === home)?.orders.length ?? 0;
    return `Выполните заказы для дома ${target.level}: ${stageOrderProgress(state, home).step} / ${count}`;
  }
  if (target.level !== (state.buildings[stationId] ?? 0) + 1) return "Сначала завершите предыдущее улучшение";
  if (state.jobs.some(job => job.kind === "construction")) return "Строитель занят. Сначала завершите текущую стройку";
  if (stationId === "quarry" && state.jobs.some(job => isMinerJob(job)
    || job.kind === "exploration" && state.catalog.explorations.some(route => route.id === job.targetId && route.requiredBuildings.quarry)))
    return state.jobs.some(isMinerJob) ? "Сначала завершите добычу и заберите результат" : "Сначала дождитесь Мохлика и заберите добычу";
  if (state.jobs.some(job => job.kind === "production" && job.targetId === stationId)) return "Сначала заберите результат производства";
  if (worldCostShortfalls(state, target.cost).length) return "Не хватает материалов или монет";
  return null;
}
export function worldJobProgress(state: EconomyView, job: EconomyJob, now: number) {
  const end = Date.parse(job.finishesAt), start = Date.parse(job.startedAt);
  const count = Object.values(job.rewards).reduce((sum, amount) => sum + amount, 0);
  return { ready: now >= end, progress: Math.max(0, Math.min(1, (now - start) / Math.max(1, end - start))), seconds: Math.max(0, Math.ceil((end - now) / 1000)), storageShortfall: job.kind === "construction" ? 0 : Math.max(0, count - state.storage.available) };
}
export function worldDuration(seconds: number) {
  if (seconds <= 0) return "Сразу";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`;
  return `${Math.floor(minutes / 1440)} д${minutes % 1440 ? ` ${Math.floor(minutes % 1440 / 60)} ч` : ""}`;
}

/** Live jobs keep seconds visible; catalogue durations use worldDuration. */
export function worldCountdown(seconds: number) {
  const remaining = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;
  const minutes = Math.floor(remaining / 60), secondsPart = String(remaining % 60).padStart(2, "0");
  return minutes < 60 ? `${minutes}:${secondsPart}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${secondsPart}`;
}
