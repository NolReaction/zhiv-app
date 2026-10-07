import { economyCatalog, type EconomyCatalog, type EconomyFood, type EconomyResidentOrders, type EconomyState } from "./model";

type FoodSource = Pick<EconomyState, "food"> & { catalog?: EconomyCatalog };
type OrderSource = Pick<EconomyState, "residentOrders" | "buildings"> & { catalog?: EconomyCatalog };
type Recipe = EconomyCatalog["recipes"][number];
export type ResidentOrderOffer = {
  id: string; slot: number; templateId: string; residentId: "plesk" | "builder"; name: string;
  items: Record<string, number>; coins: number; availableAt: string;
};

/** Pending meals have no offline decay; this also accepts snapshots from older servers. */
export function foodState(state: FoodSource): EconomyFood {
  return { heroMeal: state.food?.heroMeal ?? null, builderMeal: state.food?.builderMeal ?? null };
}

export function pendingMeal(state: FoodSource, consumer: "hero" | "builder", catalog = state.catalog ?? economyCatalog) {
  const itemId = foodState(state)[consumer === "hero" ? "heroMeal" : "builderMeal"];
  return catalog.food?.meals.find(meal => meal.itemId === itemId) ?? null;
}

/** Speed is extra work per second: +10% speed divides the time by 1.1. */
export function mealDuration(seconds: number, speedBps: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isInteger(speedBps) || speedBps < 0 || speedBps > 2500)
    throw new RangeError("Invalid meal duration");
  const divisor = 10_000 + speedBps;
  return Math.floor(seconds / divisor) * 10_000 + Math.ceil(seconds % divisor * 10_000 / divisor);
}

export function recipeWithFish(recipe: Recipe, fishItemId?: string): Recipe {
  if (!fishItemId) return recipe;
  const candidates = recipe.fishInput?.itemIds;
  if (!candidates?.includes(fishItemId)) throw new RangeError("Эта рыба не подходит для рецепта");
  const placeholders = candidates.filter(itemId => (recipe.cost.items[itemId] ?? 0) > 0);
  if (placeholders.length !== 1) throw new RangeError("В рецепте не определён рыбный ингредиент");
  const placeholder = placeholders[0];
  const items = { ...recipe.cost.items };
  const quantity = items[placeholder];
  delete items[placeholder];
  items[fishItemId] = (items[fishItemId] ?? 0) + quantity;
  return { ...recipe, cost: { ...recipe.cost, items } };
}

export function recipeFishOptions(state: Pick<EconomyState, "inventory"> & { catalog?: EconomyCatalog }, recipe: Recipe,
  catalog = state.catalog ?? economyCatalog) {
  return (recipe.fishInput?.itemIds ?? []).map(itemId => ({ itemId,
    name: catalog.items.find(item => item.id === itemId)?.name ?? itemId,
    quantity: state.inventory[itemId] ?? 0,
    rarity: catalog.fishing?.fish.find(fish => fish.itemId === itemId)?.rarity,
  }));
}

/** FNV-1a, unsigned 32-bit; kept byte-for-byte compatible with the Kotlin board. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 0x01000193);
  return result >>> 0;
}

/** Derivation only: reading or reaching a new cycle never changes the stored revision. */
export function normalizedResidentOrders(state: OrderSource, now: number, catalog = state.catalog ?? economyCatalog): EconomyResidentOrders {
  const config = catalog.food?.orders;
  const previous = state.residentOrders;
  if (!config) return { cycle: -1, slots: [], completed: previous?.completed ?? 0, earnedCoins: previous?.earnedCoins ?? 0 };
  const cycle = Math.floor(now / (config.refreshSeconds * 1000));
  const resetAt = new Date(cycle * config.refreshSeconds * 1000).toISOString();
  return { cycle, completed: previous?.completed ?? 0, earnedCoins: previous?.earnedCoins ?? 0,
    slots: Array.from({ length: config.slots }, (_, slot) => previous?.cycle === cycle && previous.slots[slot]
      ? { ...previous.slots[slot] } : { sequence: 0, readyAt: resetAt }),
  };
}

export function residentOrderBoard(state: OrderSource, now: number, catalog = state.catalog ?? economyCatalog): {
  refreshAt: string; offers: ResidentOrderOffer[]; completed: number; earnedCoins: number;
} {
  const config = catalog.food?.orders;
  const current = normalizedResidentOrders(state, now, catalog);
  if (!config) return { refreshAt: new Date(now).toISOString(), offers: [], completed: current.completed, earnedCoins: current.earnedCoins };
  const eligible = config.templates.filter(template => (state.buildings.home ?? 1) >= template.requiredHomeLevel
    && Object.entries(template.requiredBuildings).every(([id, level]) => (state.buildings[id] ?? 0) >= level))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const offers = current.slots.flatMap((slot, index): ResidentOrderOffer[] => {
    if (!eligible.length) return [];
    // A modular step guarantees every replacement differs when two offers qualify.
    const template = eligible[(hash(`${current.cycle}:${index}`) % eligible.length + slot.sequence % eligible.length) % eligible.length];
    return [{ id: `order_${current.cycle}_${index}_${slot.sequence}_${template.id}`, slot: index, templateId: template.id,
      residentId: template.residentId, name: template.name, items: { ...template.items }, coins: template.coins, availableAt: slot.readyAt }];
  });
  return { refreshAt: new Date((current.cycle + 1) * config.refreshSeconds * 1000).toISOString(), offers,
    completed: current.completed, earnedCoins: current.earnedCoins };
}
