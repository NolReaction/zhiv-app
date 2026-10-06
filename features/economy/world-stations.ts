import type { MapObjectSelection, WorldPlace } from "@/features/world/map-engine";
import type { EconomyCatalog, EconomyCost, EconomyJob, EconomyView } from "./model";

export type WorldStationDefinition = { label: string; stationIds: readonly string[]; future?: string };
export const worldStations: Partial<Record<WorldPlace, WorldStationDefinition>> = {
  house: { label: "Дом", stationIds: ["home", "warehouse"] },
  garden: { label: "Ягодный куст", stationIds: ["garden"] },
  campfire: { label: "Костёр", stationIds: ["dryer"] },
  workshop: { label: "Мастерская", stationIds: ["workshop", "kiln"] },
  woodlot: { label: "Лесной участок", stationIds: ["woodlot"] },
  quarry: { label: "Шахта", stationIds: ["quarry"] },
  bridge: { label: "Мост", stationIds: [], future: "Восстановление моста и переход на другой берег готовятся. Сейчас материалы здесь не расходуются." },
  lighthouse: { label: "Маяк", stationIds: [], future: "Восстановление маяка и морские маршруты готовятся. Сейчас материалы здесь не расходуются." },
};
export function worldPlaceForStation(stationId: string): WorldPlace | null {
  const result = Object.entries(worldStations).find(([, value]) => value.stationIds.includes(stationId));
  return result ? result[0] as WorldPlace : null;
}
export type WorldMenuBounds = { top?: number; right?: number; bottom?: number; left?: number };
export function worldMenuDimensions(viewport: Pick<MapObjectSelection, "viewportWidth" | "viewportHeight">, bounds: WorldMenuBounds = {}) {
  const availableWidth = Math.max(1, viewport.viewportWidth - Math.max(8, bounds.left ?? 8) - Math.max(8, bounds.right ?? 8));
  const availableHeight = Math.max(1, viewport.viewportHeight - Math.max(8, bounds.top ?? 8) - Math.max(8, bounds.bottom ?? 8));
  return { width: Math.min(320, availableWidth), maxHeight: Math.min(380, Math.max(Math.min(280, availableHeight), availableHeight * .48)) };
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
// Production menus keep this frame while recipes, work and inventory change inside
// their scroll area. Content measurements must not choose a new side of the object.
export function worldStableMenuPosition(selection: Pick<MapObjectSelection, "x" | "y" | "viewportWidth" | "viewportHeight">, bounds: WorldMenuBounds = {}) {
  const { width, maxHeight } = worldMenuDimensions(selection, bounds);
  return worldMenuPosition(selection, { width, height: maxHeight }, bounds);
}
export type WorldRecipe = EconomyCatalog["recipes"][number];
export type WorldBuildingLevel = EconomyCatalog["buildings"][number]["levels"][number];
export function worldRequirements(value: { requiredHomeLevel: number; requiredBuildings: Record<string, number> }, recipe?: Pick<WorldRecipe, "buildingId" | "buildingLevel">) {
  const required: Record<string, number> = { ...value.requiredBuildings, home: Math.max(value.requiredHomeLevel, value.requiredBuildings.home ?? 0) };
  if (recipe) required[recipe.buildingId] = Math.max(required[recipe.buildingId] ?? 0, recipe.buildingLevel);
  return required;
}
export function worldMissingRequirements(state: EconomyView, required: Record<string, number>) {
  return Object.entries(required).filter(([id, level]) => (state.buildings[id] ?? 0) < level).map(([id, level]) => ({ id, level, current: state.buildings[id] ?? 0 }));
}
export function worldMaterialSource(state: EconomyView, itemId: string) {
  const recipe = state.catalog.recipes.find(entry => (entry.rewards[itemId] ?? 0) > 0 && !worldMissingRequirements(state, worldRequirements(entry, entry)).length);
  if (recipe) return { kind: "production" as const, stationId: recipe.buildingId, targetId: recipe.id };
  const exploration = state.catalog.explorations.find(entry => (entry.rewards[itemId] ?? 0) > 0 && !worldMissingRequirements(state, worldRequirements(entry)).length);
  return exploration ? { kind: "exploration" as const, targetId: exploration.id } : null;
}
export function worldCostShortfalls(state: EconomyView, cost: EconomyCost, quantity = 1) {
  return [
    ...(state.wallet.coins < cost.coins * quantity ? [{ id: "coins", required: cost.coins * quantity, available: state.wallet.coins }] : []),
    ...Object.entries(cost.items).filter(([id, amount]) => (state.inventory[id] ?? 0) < amount * quantity).map(([id, amount]) => ({ id, required: amount * quantity, available: state.inventory[id] ?? 0 })),
  ];
}
export function worldBatchLimit(state: EconomyView, recipe: WorldRecipe) {
  const output = Object.values(recipe.rewards).reduce((sum, amount) => sum + amount, 0);
  return Math.max(0, Math.min(recipe.maxBatch ?? state.catalog.maxBatch, state.catalog.maxBatch, Math.floor(state.storage.capacity / Math.max(1, output))));
}
export function worldProductionReason(state: EconomyView, recipe: WorldRecipe, quantity = 1) {
  const required = worldMissingRequirements(state, worldRequirements(recipe, recipe));
  if (required.length) return `${state.catalog.buildings.find(building => building.id === required[0].id)?.name ?? "Постройка"}: нужен уровень ${required[0].level}`;
  if (recipe.buildingId === "quarry") return "Добыча доступна в вылазках Мохлика";
  if (state.jobs.some(job => ["production", "construction"].includes(job.kind) && job.targetId === recipe.buildingId)) return "Место занято: сначала заберите результат";
  if (quantity > worldBatchLimit(state, recipe)) return "Уменьшите партию или расширьте кладовую";
  if (worldCostShortfalls(state, recipe.cost, quantity).length) return "Не хватает материалов или монет";
  return null;
}
export function worldConstructionReason(state: EconomyView, stationId: string, target: WorldBuildingLevel) {
  const required = worldMissingRequirements(state, worldRequirements(target));
  if (required.length) return `${state.catalog.buildings.find(building => building.id === required[0].id)?.name ?? "Постройка"}: нужен уровень ${required[0].level}`;
  if (target.level !== (state.buildings[stationId] ?? 0) + 1) return "Сначала завершите предыдущее улучшение";
  if (state.jobs.some(job => job.kind === "construction")) return "Сначала завершите текущую стройку";
  if (stationId === "quarry" && state.jobs.some(job => job.kind === "exploration" && state.catalog.explorations.some(route => route.id === job.targetId && route.requiredBuildings.quarry))) return "Сначала дождитесь Мохлика и заберите добычу";
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
