import { ECONOMY_MAX_BALANCE, economyCatalog, economyResidentOrdersSchema, type EconomyCatalog, type EconomyFood, type EconomyResidentOrders, type EconomyState, type TradeResidentId } from "./model";

import { fishClassInventory, fishClassForItem } from "./fishing";
import { normalizedFishStock } from "./fish-stock";
import { obtainableResidentOrderItems } from "./order-effort";
import { tradeOrderFingerprint, tradeResidentAvailable, TRADE_RESIDENT_IDS } from "./trade-relations";
export { obtainableResidentOrderItems } from "./order-effort";

type FoodSource = Pick<EconomyState, "food"> & { catalog?: EconomyCatalog };
type OrderSource = Pick<EconomyState, "residentOrders" | "buildings"> & Partial<Pick<EconomyState, "fishing" | "progression">> & { catalog?: EconomyCatalog };
type Recipe = EconomyCatalog["recipes"][number];
export type ResidentOrderOffer = {
  id: string; slot: number; templateId: string; residentId: TradeResidentId; name: string; description?: string;
  items: Record<string, number>; coins: number; availableAt: string;
  pearls?: number; reputationXp?: number; effortSeconds?: number; manufacturingSeconds?: number; fishingUncertain?: boolean;
  requiredBuildings?: Record<string, number> | null; weekly?: boolean; stage?: number; stages?: number; expiresAt?: string;
};

/** Pending meals have no offline decay; this also accepts snapshots from older servers. */
export function foodState(state: FoodSource): EconomyFood {
  return { heroMeal: state.food?.heroMeal ?? null, builderMeal: state.food?.builderMeal ?? null,
    ...(state.food?.heroMealEffect ? { heroMealEffect: { ...state.food.heroMealEffect } } : {}),
    ...(state.food?.builderMealSpeedBps != null ? { builderMealSpeedBps: state.food.builderMealSpeedBps } : {}) };
}

export function pendingMeal(state: FoodSource, consumer: "hero" | "builder", catalog = state.catalog ?? economyCatalog) {
  const itemId = foodState(state)[consumer === "hero" ? "heroMeal" : "builderMeal"];
  const meal = catalog.food?.meals.find(meal => meal.itemId === itemId);
  if (!meal) return null;
  const legacy = LEGACY_MEAL_SPEEDS[meal.itemId];
  return { ...meal, heroSpeedBps: state.food?.heroMealEffect?.speedBps ?? legacy?.[0] ?? meal.heroSpeedBps,
    builderSpeedBps: state.food?.builderMealSpeedBps ?? legacy?.[1] ?? meal.builderSpeedBps };
}

/** Prepared v13 servings retain their paid effect after catalog rebalancing. */
const LEGACY_MEAL_SPEEDS: Record<string, readonly [number, number]> = {
  grilled_fish: [1000, 1000], fish_soup: [2500, 2500], berry_fish: [4000, 3500], hearty_fish: [6000, 5000],
  epic_fish: [8000, 7000], legendary_fish: [10000, 9000], strawberry_compote: [800, 1200],
  blueberry_compote: [1200, 800], currant_jelly: [2000, 3000], blackberry_preserve: [4500, 3000], cranberry_glaze: [7500, 5500],
};

export function pendingHeroMealEffect(state: FoodSource) {
  return state.food?.heroMeal ? state.food.heroMealEffect ?? null : null;
}
export function heroMealWorkUsed(state: FoodSource, seconds: number): number {
  const effect = pendingHeroMealEffect(state);
  return effect ? Math.min(seconds, effect.remainingWorkSeconds) : 0;
}
/** Budget is measured in baseline active work, never idle time or the number of trips. */
export function heroMealWorkDuration(state: FoodSource, seconds: number): number {
  const meal = pendingMeal(state, "hero");
  if (!meal) return seconds;
  const effect = pendingHeroMealEffect(state);
  if (!effect) return mealDuration(seconds, meal.heroSpeedBps);
  const used = heroMealWorkUsed(state, seconds);
  return mealWorkDuration(seconds, effect.speedBps, used);
}
/** Preview the same bounded work boost before selecting a serving. */
export function mealWorkDuration(seconds: number, speedBps: number, remainingWorkSeconds: number): number {
  if (!Number.isSafeInteger(remainingWorkSeconds) || remainingWorkSeconds < 0) throw new RangeError("Invalid meal work budget");
  const used = Math.min(seconds, remainingWorkSeconds);
  return seconds - used + mealDuration(used, speedBps);
}
/** Call only after accepting the paid job. Returning early cannot recover work. */
export function spendHeroMealWork(state: EconomyState, seconds: number) {
  const food = foodState(state), effect = pendingHeroMealEffect(state);
  if (!food.heroMeal) return;
  const remaining = effect ? effect.remainingWorkSeconds - Math.min(seconds, effect.remainingWorkSeconds) : 0;
  if (effect && remaining > 0) state.food = { ...food, heroMealEffect: { ...effect, remainingWorkSeconds: remaining } };
  else { delete food.heroMealEffect; state.food = { ...food, heroMeal: null }; }
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

export function recipeFishOptions(state: Pick<EconomyState, "inventory"> & Partial<Pick<EconomyState, "fishing">> & { catalog?: EconomyCatalog }, recipe: Recipe,
  catalog = state.catalog ?? economyCatalog) {
  return (recipe.fishInput?.itemIds ?? []).map(itemId => ({ itemId,
    name: catalog.items.find(item => item.id === itemId)?.name ?? itemId,
    quantity: recipe.fishInput?.exactSpecies ? normalizedFishStock(state)[itemId] ?? 0 : state.inventory[itemId] ?? 0,
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
const compareIds = (first: string, second: string) => first < second ? -1 : first > second ? 1 : 0;
const itemEntries = (items: Record<string, number>) => Object.entries(items).sort(([first], [second]) => compareIds(first, second));
const composition = (template: Pick<OrderTemplate, "items">) => JSON.stringify(itemEntries(template.items));
const acceptsResident = (slot: number, template: Pick<OrderTemplate, "residentId">, residentId?: TradeResidentId) => residentId
  ? template.residentId === residentId : slot === 0 ? template.residentId === "plesk" : slot === 1 ? template.residentId === "builder" : true;
type OrderTerms = NonNullable<EconomyResidentOrders["slots"][number]["terms"]>;
const terms = (template: OrderTerms): OrderTerms => ({ id: template.id, residentId: template.residentId, name: template.name,
  ...(template.description ? { description: template.description } : {}), items: fishClassInventory(template.items), coins: template.coins,
  ...(template.reputationXp != null ? { reputationXp: template.reputationXp } : {}),
  ...(template.effortSeconds != null ? { effortSeconds: template.effortSeconds } : {}),
  ...(template.manufacturingSeconds != null ? { manufacturingSeconds: template.manufacturingSeconds } : {}),
  ...(template.fishingUncertain != null ? { fishingUncertain: template.fishingUncertain } : {}) });

/** Payout retains the template's premium over ingredient value. Complex goods
 * grow gently; a higher home never turns one legendary meal into a large batch. */
export function progressedResidentOrderTemplate(template: OrderTemplate, homeLevel: number, catalog = economyCatalog): OrderTemplate {
  const progression = catalog.food?.orders.progression;
  if (!progression) return template;
  const level = Math.max(0, Math.min(4, homeLevel - 1));
  const items = Object.fromEntries(Object.entries(template.items).map(([id, count]) => {
    const spec = catalog.items.find(item => item.id === id);
    const bps = catalog.fishing && fishClassForItem(id, catalog.fishing) ? progression.fishBpsByHome[level]
      : spec?.category === "crafted" || spec?.category === "provisions" ? progression.craftedBpsByHome[level] : progression.rawBpsByHome[level];
    return [id, Math.max(count, Math.floor(count * bps / 10000))];
  }));
  const value = (goods: Record<string, number>) => Object.entries(goods).reduce((sum, [id, count]) =>
    sum + BigInt(count) * BigInt(catalog.items.find(item => item.id === id)?.baseSellPrice ?? 0), BigInt(0));
  const originalValue = value(template.items), nextValue = value(items);
  const quantum = BigInt(catalog.version >= 13 ? 1 : 10);
  const payment = originalValue ? (BigInt(template.coins) * nextValue + originalValue * quantum - BigInt(1)) / (originalValue * quantum) * quantum : BigInt(template.coins);
  if (payment > BigInt(ECONOMY_MAX_BALANCE)) throw new RangeError("Order payout exceeds wallet capacity");
  const coins = Number(payment);
  return { ...template, items, coins };
}

export const eligibleResidentOrderTemplates = (state: OrderSource, catalog = state.catalog ?? economyCatalog): OrderTemplate[] => {
  const reachable = obtainableResidentOrderItems(state, catalog);
  return (catalog.food?.orders.templates ?? []).filter(template => (!catalog.tradeRelations || tradeResidentAvailable(state, template.residentId, catalog))
    && (state.buildings.home ?? 1) >= template.requiredHomeLevel
    && Object.entries(template.requiredBuildings).every(([id, level]) => (state.buildings[id] ?? 0) >= level)
    && Object.keys(template.items).every(id => reachable.has(id)))
    .map(template => progressedResidentOrderTemplate(template, state.buildings.home ?? 1, catalog))
    .sort((first, second) => compareIds(first.id, second.id));
};
const retire = (history: readonly string[], id: string | null | undefined, limit: number): string[] =>
  !id ? [...history] : limit === 0 ? [] : [...history.filter(previous => previous !== id), id].slice(-limit);
const cleanHistory = (history: readonly string[], limit: number) => history.reduce<string[]>((current, id) => retire(current, id, limit), []);

export const initialResidentOrders = (): EconomyResidentOrders => economyResidentOrdersSchema.parse(undefined);

/** Including the exact debit and payment prevents a stale catalogue card from
 * silently spending a changed ingredient set. JSON encoding is shared with Kotlin. */
export function residentOrderFingerprint(template: OrderTerms): string {
  return tradeOrderFingerprint(template);
}

function selectTemplate(eligible: OrderTemplate[], slots: EconomyResidentOrders["slots"], slot: number, cycle: number,
  history: readonly string[], outgoing?: string | null): OrderTemplate | null {
  const occupiedIds = new Set(slots.flatMap((value, index) => index !== slot && value.templateId ? [value.templateId] : []));
  const occupiedCompositions = new Set(slots.flatMap((value, index) => index !== slot && value.terms ? [composition(value.terms)] : []));
  let pool = eligible.filter(template => acceptsResident(slot, template, slots[slot]?.residentId ?? undefined) && !occupiedIds.has(template.id) && !occupiedCompositions.has(composition(template)));
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
  const relations = Boolean(catalog.tradeRelations) && config.slots === 5;
  const cycle = Math.floor(now / (config.refreshSeconds * 1000));
  const replacementCycle = Math.floor(now / (config.replacementWindowSeconds * 1000));
  const resetAt = new Date(cycle * config.refreshSeconds * 1000).toISOString();
  const eligible = eligibleResidentOrderTemplates(state, catalog), reachable = obtainableResidentOrderItems(state, catalog);
  const knownItems = new Set(catalog.items.map(item => item.id));
  let recentTemplateIds = cleanHistory(previous.recentTemplateIds ?? [], config.recentLimit);
  const keep = previous.version >= 2 && previous.cycle === cycle;
  if (previous.version >= 2 && !keep) for (const slot of previous.slots) recentTemplateIds = retire(recentTemplateIds, slot.templateId, config.recentLimit);
  const usedIds = new Set<string>(), usedCompositions = new Set<string>();
  const length = keep && previous.slots.length ? previous.slots.length : config.slots;
  const slots = Array.from({ length }, (_, index): EconomyResidentOrders["slots"][number] => {
    const saved = keep ? previous.slots[index] : undefined;
    const savedTemplate = saved?.templateId ? saved.terms ?? config.templates.find(template => template.id === saved.templateId) : undefined;
    let template = savedTemplate ? terms(savedTemplate) : undefined;
    // A pre-update v2 card without serialized terms never promised reputation.
    if (template && saved && previous.version === 2 && !saved.terms) {
      template = { id: template.id, residentId: template.residentId, name: template.name,
        ...(template.description ? { description: template.description } : {}), items: template.items, coins: template.coins };
    }
    const residentId = relations ? saved?.residentId ?? template?.residentId ?? TRADE_RESIDENT_IDS[index] : undefined;
    // Serialized terms are an existing promise. A catalogue update may retire
    // their source or raise its unlock gate; owned goods can still fulfil them.
    const promised = Boolean(saved?.terms);
    const valid = !saved?.retired && template && template.id === saved?.templateId
      && acceptsResident(index, template, residentId) && (promised || !relations || tradeResidentAvailable(state, template.residentId, catalog))
      && Object.keys(template.items).every(id => promised ? knownItems.has(id) : reachable.has(id))
      && !usedIds.has(template.id) && !usedCompositions.has(composition(template));
    if (valid && template) { usedIds.add(template.id); usedCompositions.add(composition(template)); }
    else if (saved?.templateId) recentTemplateIds = retire(recentTemplateIds, saved.templateId, config.recentLimit);
    return { sequence: saved?.sequence ?? 0, readyAt: valid ? saved!.readyAt : resetAt,
      templateId: valid && template ? template.id : null, ...(valid && template ? { terms: terms(template) } : {}),
      ...(residentId ? { residentId } : {}), ...(saved?.retired ? { retired: true } : {}) };
  });
  if (relations) for (const residentId of TRADE_RESIDENT_IDS) {
    if (tradeResidentAvailable(state, residentId, catalog) && !slots.some(slot => !slot.retired && slot.residentId === residentId))
      slots.push({ sequence: 0, readyAt: resetAt, templateId: null, residentId });
  }
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (!slot.templateId && !slot.retired && (!relations || slot.residentId && tradeResidentAvailable(state, slot.residentId, catalog))) {
      const next = selectTemplate(eligible, slots, index, cycle, recentTemplateIds);
      slot.templateId = next?.id ?? null;
      if (next) slot.terms = terms(next);
    }
  }
  return { version: relations ? 3 : 2, cycle, slots, completed: previous.completed, earnedCoins: previous.earnedCoins, recentTemplateIds, replacementCycle,
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
  delete selected.terms;
  if (current.version === 3 && selected.residentId && current.slots.some((entry, index) => index !== slot && !entry.retired
    && entry.residentId === selected.residentId && entry.templateId)) {
    selected.retired = true;
    return current;
  }
  const next = selectTemplate(eligibleResidentOrderTemplates(state, catalog), current.slots, slot, current.cycle, current.recentTemplateIds, outgoing);
  selected.templateId = next?.id ?? null;
  if (next) selected.terms = terms(next);
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
    const template = slot.terms;
    return template ? [{ id: `order2_${current.cycle}_${index}_${slot.sequence}_${residentOrderFingerprint(template)}`, slot: index, templateId: template.id,
      residentId: template.residentId, name: template.name, ...(template.description ? { description: template.description } : {}),
      items: fishClassInventory(template.items), coins: template.coins, availableAt: slot.readyAt,
      ...(template.reputationXp != null ? { reputationXp: template.reputationXp } : {}),
      ...(template.effortSeconds != null ? { effortSeconds: template.effortSeconds } : {}),
      ...(template.manufacturingSeconds != null ? { manufacturingSeconds: template.manufacturingSeconds } : {}),
      ...(template.fishingUncertain != null ? { fishingUncertain: template.fishingUncertain } : {}) }] : [];
  });
  const freeReplacementsRemaining = Math.max(0, config.freeReplacements - current.freeReplacementsUsed);
  return { refreshAt: new Date((current.cycle + 1) * config.refreshSeconds * 1000).toISOString(), offers,
    completed: current.completed, earnedCoins: current.earnedCoins, freeReplacementsRemaining,
    replacementPricePearls: freeReplacementsRemaining > 0 ? 0 : config.replacementPricePearls,
    replacementsResetAt: new Date((current.replacementCycle + 1) * config.replacementWindowSeconds * 1000).toISOString() };
}
