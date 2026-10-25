import { economyCatalog, type EconomyCatalog } from "@/features/economy/domain/model";
import { productionSources, sortItemSources, sourceAvailable, type ProductionAccess, type ProductionSource } from "./economy-sources";

export { buildingsAtHomeLevel } from "./economy-sources";
export const MAX_PLAN_OPERATIONS = 5000;
export type ProductionPlanOptions = ProductionAccess & {
  targets: Record<string, number>; inventory?: Record<string, number>; slots?: Record<string, number>;
  sourceByItem?: Record<string, string>; speedBps?: Record<string, number>;
};
export type ProductionOperation = {
  id: string; sourceId: string; name: string; stationId: string; seconds: number; collectionSeconds: number;
  inputs: Record<string, number>; outputs: Record<string, number>; dependencies: string[];
  blocked: boolean; startSeconds: number | null; endSeconds: number | null; slot: number | null;
};
export type ProductionPlan = {
  complete: boolean; targets: Record<string, number>; inventoryUsed: Record<string, number>; leftovers: Record<string, number>;
  missingItems: Record<string, number>; rawInputs: Record<string, number>; operations: ProductionOperation[];
  queues: { stationId: string; workSeconds: number; launches: number; slots: number }[];
  workSeconds: number; collectionSeconds: number; elapsedSeconds: number | null; launches: number; coins: number; warnings: string[];
};

type Lot = { quantity: number; producerId?: string; fromInventory: boolean };
const add = (target: Record<string, number>, id: string, quantity: number) => { target[id] = (target[id] ?? 0) + quantity; };
function quantities(values: Record<string, number>, label: string, maximumKeys: number) {
  if (Object.keys(values).length > maximumKeys) throw new RangeError(`${label}: too many item types`);
  for (const [id, quantity] of Object.entries(values)) if (!/^[a-z][a-z0-9_]*$/.test(id)
    || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 9999) throw new RangeError(`${label}: invalid quantity for ${id}`);
}

/** Shared-stock, whole-run production plan. No purchases or random catches are
 * invented. The schedule assumes immediate collection/restart and is feasible,
 * not a global optimum or a prediction of a player's calendar progress. */
export function planEconomyProduction(options: ProductionPlanOptions, catalog: EconomyCatalog = economyCatalog): ProductionPlan {
  quantities(options.targets, "Targets", 30); quantities(options.inventory ?? {}, "Inventory", 1000);
  const knownItems = new Set(catalog.items.map(item => item.id));
  for (const id of [...Object.keys(options.targets), ...Object.keys(options.inventory ?? {})])
    if (!knownItems.has(id)) throw new RangeError(`Unknown item: ${id}`);
  for (const value of Object.values(options.buildings ?? {})) if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw new RangeError("Invalid building level");
  for (const value of Object.values(options.completedRecipes ?? {})) if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid recipe completion count");
  for (const value of Object.values(options.slots ?? {})) if (!Number.isSafeInteger(value) || value < 1 || value > 3) throw new RangeError("Slots must be 1–3");
  for (const value of Object.values(options.speedBps ?? {})) if (!Number.isSafeInteger(value) || value < 0 || value > 10000) throw new RangeError("Speed bonus must be 0–100%");
  const sources = productionSources(catalog), sourceById = new Map(sources.map(source => [source.id, source]));
  const names = new Map(catalog.items.map(item => [item.id, item.name]));
  const inventoryUsed: Record<string, number> = {}, missingItems: Record<string, number> = {}, rawInputs: Record<string, number> = {};
  const lots = new Map<string, Lot[]>(), operations: ProductionOperation[] = [], operationById = new Map<string, ProductionOperation>();
  const warnings = new Set<string>();
  let coins = 0, exhausted = false;
  for (const [id, quantity] of Object.entries(options.inventory ?? {})) if (quantity > 0) lots.set(id, [{ quantity, fromInventory: true }]);
  const targets = Object.fromEntries(Object.entries(options.targets).filter(([, quantity]) => quantity > 0));
  const candidates = new Map<string, ProductionSource[]>();
  function selectedSource(itemId: string) {
    const explicit = options.sourceByItem?.[itemId];
    if (explicit) {
      const chosen = sourceById.get(explicit);
      return chosen && (chosen.rewards[itemId] ?? 0) > 0 && sourceAvailable(chosen, options) ? chosen : undefined;
    }
    if (!candidates.has(itemId)) candidates.set(itemId, sortItemSources(itemId, sources, catalog).filter(source => sourceAvailable(source, options)));
    return candidates.get(itemId)![0];
  }
  function missing(itemId: string, count: number, reason: string) {
    add(missingItems, itemId, count); add(rawInputs, itemId, count); warnings.add(reason);
  }
  function consume(itemId: string, count: number, dependencies: Set<string>): number {
    let remaining = count;
    for (const lot of lots.get(itemId) ?? []) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, lot.quantity);
      if (take <= 0) continue;
      lot.quantity -= take; remaining -= take;
      if (lot.fromInventory) add(inventoryUsed, itemId, take);
      if (lot.producerId) dependencies.add(lot.producerId);
    }
    return remaining;
  }
  function obtain(itemId: string, count: number, path: string[]): { dependencies: Set<string>; blocked: boolean } {
    const dependencies = new Set<string>();
    const remaining = consume(itemId, count, dependencies);
    if (remaining <= 0) return { dependencies, blocked: [...dependencies].some(id => operationById.get(id)?.blocked) };
    if (path.includes(itemId)) {
      missing(itemId, remaining, `Цикл производства: ${[...path, itemId].map(id => names.get(id) ?? id).join(" → ")}.`);
      return { dependencies, blocked: true };
    }
    const source = selectedSource(itemId);
    if (!source) {
      missing(itemId, remaining, `${names.get(itemId) ?? itemId}: нет выбранного доступного гарантированного производства. Улов, покупки и разовые подарки автоматически не предполагаются.`);
      return { dependencies, blocked: true };
    }
    const countRuns = Math.ceil(remaining / source.rewards[itemId]);
    if (exhausted || operations.length + countRuns > MAX_PLAN_OPERATIONS || path.length > 50) {
      exhausted = true;
      missing(itemId, remaining, `План превышает ${MAX_PLAN_OPERATIONS} запусков. Уменьшите количество целей; показан только рассчитанный участок.`);
      return { dependencies, blocked: true };
    }
    for (let run = 0; run < countRuns; run++) {
      const inputDependencies = new Set<string>();
      let blocked = false;
      for (const [input, quantity] of Object.entries(source.cost.items)) {
        const result = obtain(input, quantity, [...path, itemId]);
        blocked ||= result.blocked;
        for (const dependency of result.dependencies) inputDependencies.add(dependency);
      }
      if (operations.length >= MAX_PLAN_OPERATIONS) {
        exhausted = true; break;
      }
      const id = `operation:${operations.length + 1}`;
      const operation: ProductionOperation = { id, sourceId: source.id, name: source.name, stationId: source.stationId,
        seconds: Math.ceil(source.seconds * 10000 / (10000 + (options.speedBps?.[source.stationId] ?? 0))),
        collectionSeconds: source.collectionSeconds, inputs: { ...source.cost.items }, outputs: { ...source.rewards },
        dependencies: [...inputDependencies], blocked, startSeconds: null, endSeconds: null, slot: null };
      operations.push(operation); operationById.set(id, operation); coins += source.cost.coins;
      for (const [output, quantity] of Object.entries(source.rewards)) {
        const list = lots.get(output) ?? [];
        list.push({ quantity, producerId: id, fromInventory: false }); lots.set(output, list);
        if (!Object.keys(source.cost.items).length) add(rawInputs, output, quantity);
      }
    }
    const stillMissing = consume(itemId, remaining, dependencies);
    if (stillMissing > 0) missing(itemId, stillMissing, `Расчёт остановлен на ограничении ${MAX_PLAN_OPERATIONS} запусков.`);
    return { dependencies, blocked: stillMissing > 0 || [...dependencies].some(id => operationById.get(id)?.blocked) };
  }
  for (const [id, count] of Object.entries(targets).sort(([a], [b]) => a.localeCompare(b))) obtain(id, count, []);

  const slotCount = (stationId: string) => stationId === "hero" || stationId === "quarry" ? 1 : options.slots?.[stationId] ?? 1;
  const availability = new Map<string, number[]>();
  const slots = (id: string) => {
    if (!availability.has(id)) availability.set(id, Array.from({ length: slotCount(id) }, () => 0));
    return availability.get(id)!;
  };
  const pending = new Set(operations.filter(operation => !operation.blocked).map(operation => operation.id));
  while (pending.size) {
    let selected: ProductionOperation | undefined, selectedStart = Infinity, selectedSlot = 0;
    for (const id of pending) {
      const operation = operationById.get(id)!;
      if (operation.dependencies.some(dependency => operationById.get(dependency)?.endSeconds === null)) continue;
      const ready = Math.max(0, ...operation.dependencies.map(dependency => operationById.get(dependency)?.endSeconds ?? 0));
      const stationSlots = slots(operation.stationId);
      const slot = stationSlots.indexOf(Math.min(...stationSlots));
      const start = Math.max(ready, stationSlots[slot]);
      if (start < selectedStart) { selected = operation; selectedStart = start; selectedSlot = slot; }
    }
    if (!selected) { warnings.add("Не удалось построить последовательность зависимостей."); break; }
    selected.startSeconds = selectedStart; selected.slot = selectedSlot + 1;
    let end = selectedStart + selected.seconds;
    if (selected.collectionSeconds > 0) {
      const hero = slots("hero");
      end = Math.max(end, hero[0]) + selected.collectionSeconds;
      hero[0] = end;
    }
    selected.endSeconds = end; slots(selected.stationId)[selectedSlot] = end; pending.delete(selected.id);
  }
  const queueMap = new Map<string, { stationId: string; workSeconds: number; launches: number; slots: number }>();
  function queue(id: string) {
    if (!queueMap.has(id)) queueMap.set(id, { stationId: id, workSeconds: 0, launches: 0, slots: slotCount(id) });
    return queueMap.get(id)!;
  }
  let workSeconds = 0, collectionSeconds = 0;
  for (const operation of operations) {
    queue(operation.stationId).workSeconds += operation.seconds; queue(operation.stationId).launches += 1;
    workSeconds += operation.seconds; collectionSeconds += operation.collectionSeconds;
    if (operation.collectionSeconds > 0) queue("hero").workSeconds += operation.collectionSeconds;
  }
  const complete = !Object.keys(missingItems).length && operations.every(operation => operation.endSeconds !== null);
  const leftovers = Object.fromEntries([...lots].map(([id, entries]) => [id, entries.reduce((sum, lot) => sum + (lot.producerId && operationById.get(lot.producerId)?.blocked ? 0 : lot.quantity), 0)] as const).filter(([, count]) => count > 0));
  warnings.add("Расписание предполагает немедленный сбор и новый запуск. Это выполнимый план очередей, а не прогноз срока прохождения и не доказанный оптимум.");
  warnings.add("Запасы расходуются совместно всеми целями. Стройка, открытие рецептов, покупка ингредиентов и вместимость склада не включены в расписание.");
  if (!options.buildings) warnings.add("Выбраны все открытые технологии. Реальные уровни зданий и освоение рецептов не ограничивают этот расчёт.");
  return { complete, targets, inventoryUsed, leftovers, missingItems, rawInputs, operations, queues: [...queueMap.values()],
    workSeconds: workSeconds + collectionSeconds, collectionSeconds,
    elapsedSeconds: complete ? Math.max(0, ...operations.map(operation => operation.endSeconds ?? 0)) : null,
    launches: operations.length, coins, warnings: [...warnings] };
}
