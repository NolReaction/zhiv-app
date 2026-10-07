import { economyCatalog, economyResidentOrdersSchema, type EconomyCatalog, type EconomyFood, type EconomyResidentOrders, type EconomyState } from "./model";

type FoodSource = Pick<EconomyState, "food"> & { catalog?: EconomyCatalog };
type OrderSource = Pick<EconomyState, "residentOrders" | "buildings"> & { catalog?: EconomyCatalog };
type Recipe = EconomyCatalog["recipes"][number];
export type ResidentOrderOffer = {
  id: string; slot: number; templateId: string; residentId: "plesk" | "builder"; name: string; description?: string;
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
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isInteger(speedBps) || speedBps < 0 || speedBps > 10000)
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

type OrderTemplate = NonNullable<EconomyCatalog["food"]>["orders"]["templates"][number];
type OrderConfig = NonNullable<EconomyCatalog["food"]>["orders"];
const compareIds = (first: string, second: string) => first < second ? -1 : first > second ? 1 : 0;
const itemEntries = (items: Record<string, number>) => Object.entries(items).sort(([first], [second]) => compareIds(first, second));
const composition = (template: OrderTemplate) => JSON.stringify(itemEntries(template.items));
const acceptsResident = (slot: number, template: OrderTemplate) => slot === 0 ? template.residentId === "plesk" : slot === 1 ? template.residentId === "builder" : true;
const eligibleTemplates = (state: OrderSource, config: OrderConfig) => config.templates.filter(template => (state.buildings.home ?? 1) >= template.requiredHomeLevel
  && Object.entries(template.requiredBuildings).every(([id, level]) => (state.buildings[id] ?? 0) >= level)).sort((first, second) => compareIds(first.id, second.id));
const retire = (history: readonly string[], id: string | null | undefined, limit: number): string[] =>
  !id ? [...history] : limit === 0 ? [] : [...history.filter(previous => previous !== id), id].slice(-limit);
const cleanHistory = (history: readonly string[], limit: number) => history.reduce<string[]>((current, id) => retire(current, id, limit), []);

export const initialResidentOrders = (): EconomyResidentOrders => economyResidentOrdersSchema.parse(undefined);

/** Including the exact debit and payment prevents a stale catalogue card from
 * silently spending a changed ingredient set. JSON encoding is shared with Kotlin. */
export function residentOrderFingerprint(template: OrderTemplate): string {
  return String(hash(JSON.stringify([template.id, template.residentId, itemEntries(template.items), template.coins])));
}

function selectTemplate(eligible: OrderTemplate[], slots: EconomyResidentOrders["slots"], slot: number, cycle: number,
  history: readonly string[], outgoing?: string | null): OrderTemplate | null {
  const occupiedIds = new Set(slots.flatMap((value, index) => index !== slot && value.templateId ? [value.templateId] : []));
  const occupiedCompositions = new Set(eligible.filter(template => occupiedIds.has(template.id)).map(composition));
  let pool = eligible.filter(template => acceptsResident(slot, template) && !occupiedIds.has(template.id) && !occupiedCompositions.has(composition(template)));
  // Tiny/retired catalogues may have no alternative for a resident. Never copy
  // another active card, and never return the outgoing one while an alternative exists.
  if (pool.some(template => template.id !== outgoing)) pool = pool.filter(template => template.id !== outgoing);
  let excluded = [...history], choices = pool.filter(template => !excluded.includes(template.id));
  while (!choices.length && excluded.length) {
    excluded = excluded.slice(1);
    choices = pool.filter(template => !excluded.includes(template.id));
  }
  return choices.length ? choices[hash(`order2:${cycle}:${slot}:${slots[slot].sequence}`) % choices.length] : null;
}

/** Derivation only. Migration, calendar refresh and building unlocks never write
 * a profile on GET; all valid neighbouring cards retain their saved template. */
export function normalizedResidentOrders(state: OrderSource, now: number, catalog = state.catalog ?? economyCatalog): EconomyResidentOrders {
  const config = catalog.food?.orders, previous = state.residentOrders ?? initialResidentOrders();
  if (!config) return { ...initialResidentOrders(), completed: previous.completed, earnedCoins: previous.earnedCoins };
  const cycle = Math.floor(now / (config.refreshSeconds * 1000));
  const replacementCycle = Math.floor(now / (config.replacementWindowSeconds * 1000));
  const resetAt = new Date(cycle * config.refreshSeconds * 1000).toISOString();
  const eligible = eligibleTemplates(state, config);
  let recentTemplateIds = cleanHistory(previous.recentTemplateIds ?? [], config.recentLimit);
  const keep = previous.version === 2 && previous.cycle === cycle;
  if (previous.version === 2 && !keep) for (const slot of previous.slots) recentTemplateIds = retire(recentTemplateIds, slot.templateId, config.recentLimit);
  const usedIds = new Set<string>(), usedCompositions = new Set<string>();
  const slots = Array.from({ length: config.slots }, (_, index): EconomyResidentOrders["slots"][number] => {
    const saved = keep ? previous.slots[index] : undefined;
    const template = saved?.templateId ? eligible.find(template => template.id === saved.templateId) : undefined;
    const valid = template && acceptsResident(index, template) && !usedIds.has(template.id) && !usedCompositions.has(composition(template));
    if (valid) { usedIds.add(template.id); usedCompositions.add(composition(template)); }
    else if (saved?.templateId) recentTemplateIds = retire(recentTemplateIds, saved.templateId, config.recentLimit);
    return { sequence: saved?.sequence ?? 0, readyAt: resetAt, templateId: valid ? template.id : null };
  });
  for (let index = 0; index < slots.length; index++) {
    if (!slots[index].templateId) slots[index].templateId = selectTemplate(eligible, slots, index, cycle, recentTemplateIds)?.id ?? null;
  }
  return { version: 2, cycle, slots, completed: previous.completed, earnedCoins: previous.earnedCoins, recentTemplateIds, replacementCycle,
    freeReplacementsUsed: previous.replacementCycle === replacementCycle ? Math.max(0, Math.min(config.freeReplacements, previous.freeReplacementsUsed ?? 0)) : 0 };
}

/** Retires one card without debiting anything. The command validates the offer
 * and balances first, then commits this board with its payment/counter changes. */
export function advanceResidentOrder(state: OrderSource, slot: number, now: number, catalog = state.catalog ?? economyCatalog): EconomyResidentOrders {
  const config = catalog.food?.orders;
  if (!config) throw new RangeError("Orders are unavailable");
  const current = normalizedResidentOrders(state, now, catalog);
  const selected = current.slots[slot];
  if (!selected || !selected.templateId || selected.sequence >= Number.MAX_SAFE_INTEGER) throw new RangeError("Invalid order slot");
  const outgoing = selected.templateId;
  current.recentTemplateIds = retire(current.recentTemplateIds, outgoing, config.recentLimit);
  selected.sequence++;
  selected.templateId = null;
  selected.templateId = selectTemplate(eligibleTemplates(state, config), current.slots, slot, current.cycle, current.recentTemplateIds, outgoing)?.id ?? null;
  return current;
}

export function residentOrderBoard(state: OrderSource, now: number, catalog = state.catalog ?? economyCatalog): {
  refreshAt: string; offers: ResidentOrderOffer[]; completed: number; earnedCoins: number;
  freeReplacementsRemaining: number; replacementPricePearls: number; replacementsResetAt: string;
} {
  const config = catalog.food?.orders;
  const current = normalizedResidentOrders(state, now, catalog);
  if (!config) return { refreshAt: new Date(now).toISOString(), offers: [], completed: current.completed, earnedCoins: current.earnedCoins,
    freeReplacementsRemaining: 0, replacementPricePearls: 0, replacementsResetAt: new Date(now).toISOString() };
  const offers = current.slots.flatMap((slot, index): ResidentOrderOffer[] => {
    const template = config.templates.find(template => template.id === slot.templateId);
    return template ? [{ id: `order2_${current.cycle}_${index}_${slot.sequence}_${residentOrderFingerprint(template)}`, slot: index, templateId: template.id,
      residentId: template.residentId, name: template.name, ...(template.description ? { description: template.description } : {}),
      items: { ...template.items }, coins: template.coins, availableAt: slot.readyAt }] : [];
  });
  const freeReplacementsRemaining = Math.max(0, config.freeReplacements - current.freeReplacementsUsed);
  return { refreshAt: new Date((current.cycle + 1) * config.refreshSeconds * 1000).toISOString(), offers,
    completed: current.completed, earnedCoins: current.earnedCoins, freeReplacementsRemaining,
    replacementPricePearls: freeReplacementsRemaining > 0 ? 0 : config.replacementPricePearls,
    replacementsResetAt: new Date((current.replacementCycle + 1) * config.replacementWindowSeconds * 1000).toISOString() };
}
