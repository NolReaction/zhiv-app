import type { EconomyCost, EconomyView } from "./model";
import { worldMaterialSource, type WorldRecipe } from "./world-stations";

export type ConstructionGoal = { buildingId: string; targetLevel: number };
type GoalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function constructionGoalStorageKey(owner: string) {
  return `zhiv:construction-goal:v1:${owner}`;
}

/** A goal is one exact upcoming level, never an instruction to keep upgrading. */
function goalTarget(state: EconomyView, goal: ConstructionGoal | null) {
  if (!goal || goal.targetLevel !== (state.buildings[goal.buildingId] ?? 0) + 1) return null;
  if (state.jobs.some(job => job.kind === "construction" && job.targetId === goal.buildingId)) return null;
  const building = state.catalog.buildings.find(entry => entry.id === goal.buildingId);
  const level = building?.levels.find(entry => entry.level === goal.targetLevel);
  return building && level ? { building, level } : null;
}

/**
 * Reserve direct costs and inputs for missing crafted goods. Dependencies are
 * processed before their ingredients, so shared stock is allocated only once.
 * Prefer the same available recipe as source navigation, falling back to the
 * first catalog recipe when its station is not yet unlocked. Round whole output
 * batches up and conservatively ignore byproducts and unclaimed jobs. This is a local
 * selling aid, not a server reservation or a promise of an optimal craft plan.
 */
function constructionReserves(state: EconomyView, cost: EconomyCost) {
  const recipes = new Map<string, WorldRecipe>();
  const visiting = new Set<string>(), visited = new Set<string>(), order: string[] = [];
  let complete = true;
  function visit(itemId: string) {
    if (visiting.has(itemId) || visited.size + visiting.size > 1000) { complete = false; return; }
    if (visited.has(itemId)) return;
    visiting.add(itemId);
    const source = worldMaterialSource(state, itemId);
    const recipe = source?.kind === "production" ? state.catalog.recipes.find(entry => entry.id === source.targetId)
      : state.catalog.recipes.find(entry => (entry.rewards[itemId] ?? 0) > 0);
    if (recipe) {
      recipes.set(itemId, recipe);
      for (const [inputId, amount] of Object.entries(recipe.cost.items)) if (amount > 0) visit(inputId);
    }
    visiting.delete(itemId); visited.add(itemId); order.push(itemId);
  }
  for (const [itemId, amount] of Object.entries(cost.items)) if (amount > 0) visit(itemId);
  const keepItems: Record<string, number> = { ...cost.items };
  for (const itemId of order.reverse()) {
    if (!complete) break;
    const recipe = recipes.get(itemId);
    const missing = Math.max(0, (keepItems[itemId] ?? 0) - (state.inventory[itemId] ?? 0));
    if (!recipe || missing === 0) continue;
    const batches = Math.ceil(missing / recipe.rewards[itemId]);
    for (const [inputId, amount] of Object.entries(recipe.cost.items)) {
      const required = (keepItems[inputId] ?? 0) + amount * batches;
      if (!Number.isSafeInteger(required) || required < 0) { complete = false; break; }
      if (required > 0) keepItems[inputId] = required;
    }
  }
  // A future malformed/cyclic catalog must never label needed stock as excess.
  if (!complete) for (const [itemId, stock] of Object.entries(state.inventory)) keepItems[itemId] = Math.max(keepItems[itemId] ?? 0, stock);
  return { keepItems, reservesComplete: complete };
}

export function constructionGoalDetails(state: EconomyView, goal: ConstructionGoal | null) {
  const target = goalTarget(state, goal);
  if (!target || !goal) return null;
  const cost = target.level.cost;
  const missing: EconomyCost = {
    coins: Math.max(0, cost.coins - state.wallet.coins),
    items: Object.fromEntries(Object.entries(cost.items).map(([id, amount]): [string, number] => [id, Math.max(0, amount - (state.inventory[id] ?? 0))]).filter(([, amount]) => amount > 0)),
  };
  const { keepItems, reservesComplete } = constructionReserves(state, cost);
  const excessItems = Object.fromEntries(Object.entries(state.inventory).map(([id, amount]): [string, number] => [id, Math.max(0, amount - (keepItems[id] ?? 0))]));
  return { goal, name: target.building.name, cost, missing, keepItems, excessItems, reservesComplete };
}

function decodeGoal(raw: string | null, owner: string): ConstructionGoal | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const goal = value?.goal;
    if (value?.version !== 1 || value.ownerPublicId !== owner || !goal || typeof goal.buildingId !== "string"
      || !goal.buildingId.length || goal.buildingId.length > 80 || !Number.isSafeInteger(goal.targetLevel)
      || goal.targetLevel < 1 || goal.targetLevel > 100) return null;
    return { buildingId: goal.buildingId, targetLevel: goal.targetLevel };
  } catch { return null; }
}

function sameGoal(left: ConstructionGoal | null, right: ConstructionGoal | null) {
  return left?.buildingId === right?.buildingId && left?.targetLevel === right?.targetLevel;
}

/** Every mutation is bound to one owner; another account's snapshot is ignored. */
export function createConstructionGoalStore(owner: string | null, storage?: GoalStorage) {
  const storageKey = owner ? constructionGoalStorageKey(owner) : null;
  let goal: ConstructionGoal | null = null;
  const listeners = new Set<() => void>();
  function publish(next: ConstructionGoal | null) {
    if (sameGoal(goal, next)) return;
    goal = next; listeners.forEach(listener => listener());
  }
  function save(next: ConstructionGoal | null) {
    if (!owner || !storageKey) return;
    publish(next);
    try {
      if (next) storage?.setItem(storageKey, JSON.stringify({ version: 1, ownerPublicId: owner, goal: next }));
      else storage?.removeItem(storageKey);
    } catch { /* Keep the goal usable in memory if browser storage is blocked. */ }
  }
  return {
    storageKey,
    getSnapshot: () => goal,
    getServerSnapshot: (): ConstructionGoal | null => null,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restore() {
      if (!owner || !storageKey) return;
      try { if (storage) publish(decodeGoal(storage.getItem(storageKey), owner)); } catch { /* Preserve the in-memory goal. */ }
    },
    pin(state: EconomyView | null, buildingId: string) {
      if (!owner || state?.ownerPublicId !== owner) return;
      const next = { buildingId, targetLevel: (state.buildings[buildingId] ?? 0) + 1 };
      if (goalTarget(state, next)) save(next);
    },
    clear: () => save(null),
    reconcile(state: EconomyView | null) {
      if (!owner || state?.ownerPublicId !== owner || !goal) return;
      const currentGoal = goal;
      const targetExists = state.catalog.buildings.some(building => building.id === currentGoal.buildingId
        && building.levels.some(level => level.level === currentGoal.targetLevel));
      const fulfilled = (state.buildings[currentGoal.buildingId] ?? 0) >= currentGoal.targetLevel;
      const paid = state.jobs.some(job => job.kind === "construction" && job.targetId === currentGoal.buildingId
        && (job.targetLevel ?? 0) >= currentGoal.targetLevel);
      // Another tab may have pinned this goal after advancing beyond our older
      // snapshot. Hide it until polling catches up, but never erase it for that.
      if (!targetExists || fulfilled || paid) save(null);
    },
  };
}
