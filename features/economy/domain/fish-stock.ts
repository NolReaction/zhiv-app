import { ECONOMY_MAX_ITEMS, economyCatalog, type EconomyFishing, type EconomyFishingCatalog, type EconomyState } from "./model";
import { fishClassForItem, fishClassInventory, fishingState } from "./fishing";

type FishStockSource = Pick<EconomyState, "inventory"> & { fishing?: EconomyFishing; catalog?: { fishing?: EconomyFishingCatalog } };
export type FishStockEntry = { itemId: string; classId: string; quantity: number };
export type FishSelection = Record<string, number>;
const catalogFor = (state: FishStockSource) => state.catalog?.fishing ?? economyCatalog.fishing!;
const positiveCount = (quantity: number | undefined) => Number.isSafeInteger(quantity) && quantity! > 0 && quantity! <= ECONOMY_MAX_ITEMS ? quantity! : 0;

/** The catch book is a lifetime collection, never evidence of fish still owned. */
export function normalizedFishStock(state: FishStockSource): FishSelection {
  const catalog = catalogFor(state), inventory = fishClassInventory(state.inventory, catalog), stock = state.fishing?.stock ?? {};
  const result: FishSelection = {}, remaining = { ...inventory };
  for (const fish of catalog.fish) {
    const classId = fishClassForItem(fish.itemId, catalog)!.itemId;
    const quantity = Math.min(positiveCount(stock[fish.itemId]), remaining[classId] ?? 0);
    if (quantity > 0) { result[fish.itemId] = quantity; remaining[classId] -= quantity; }
  }
  return result;
}

/** Read-only picker entries. Class ids describe the unidentified remainder only. */
export function fishStockEntries(state: FishStockSource, classId: string): FishStockEntry[] {
  const catalog = catalogFor(state), group = fishClassForItem(classId, catalog);
  if (!group) return [];
  const stock = normalizedFishStock(state), inventory = fishClassInventory(state.inventory, catalog);
  const entries = catalog.fish.filter(fish => fish.rarity === group.rarity && stock[fish.itemId] > 0)
    .map(fish => ({ itemId: fish.itemId, classId: group.itemId, quantity: stock[fish.itemId] }));
  const unknown = (inventory[group.itemId] ?? 0) - entries.reduce((total, entry) => total + entry.quantity, 0);
  return unknown > 0 ? [...entries, { itemId: group.itemId, classId: group.itemId, quantity: unknown }] : entries;
}

export function fishStockRequirements(requiredItems: FishSelection, catalog = economyCatalog.fishing!): FishSelection {
  const required: FishSelection = {};
  for (const [itemId, quantity] of Object.entries(requiredItems)) {
    const group = fishClassForItem(itemId, catalog);
    if (group && quantity > 0) required[group.itemId] = (required[group.itemId] ?? 0) + quantity;
  }
  return required;
}

/** Spend unidentified fish first, then the most abundant species, with stable ties. */
export function autoFillFishSelection(state: FishStockSource, requiredItems: FishSelection): FishSelection {
  const selected: FishSelection = {}, required = fishStockRequirements(requiredItems, catalogFor(state));
  for (const [classId, amount] of Object.entries(required)) {
    const entries = fishStockEntries(state, classId).sort((first, second) => first.itemId === classId ? -1
      : second.itemId === classId ? 1 : second.quantity - first.quantity);
    let remaining = amount;
    for (const entry of entries) {
      const quantity = Math.min(remaining, entry.quantity);
      if (quantity > 0) selected[entry.itemId] = quantity;
      remaining -= quantity;
    }
  }
  return selected;
}

/** Exact class totals and exact owned species counts protect against stale picks. */
export function fishSelectionMatches(state: FishStockSource, requiredItems: FishSelection, selection: FishSelection): boolean {
  const catalog = catalogFor(state), required = fishStockRequirements(requiredItems, catalog), totals: FishSelection = {};
  for (const [itemId, quantity] of Object.entries(selection)) {
    const group = fishClassForItem(itemId, catalog);
    if (!group || !required[group.itemId] || !positiveCount(quantity) || positiveCount(quantity) !== quantity) return false;
    const owned = fishStockEntries(state, group.itemId).find(entry => entry.itemId === itemId)?.quantity ?? 0;
    if (quantity > owned) return false;
    totals[group.itemId] = (totals[group.itemId] ?? 0) + quantity;
  }
  return Object.entries(required).every(([classId, quantity]) => totals[classId] === quantity);
}

function setFishStock(state: EconomyState, stock: FishSelection) {
  const current = fishingState(state);
  // Keep an absent ledger absent for old, class-only profiles and receipts.
  if (current.stock != null || Object.keys(stock).length) state.fishing = { ...current, stock };
}

export function reconcileFishStock(state: EconomyState) {
  setFishStock(state, normalizedFishStock(state));
}

/** Saved proof can identify only fish covered by its actual economic transfer. */
export function fishStockWithinItems(stock: FishSelection, inventory: FishSelection): FishSelection {
  return normalizedFishStock({ inventory, fishing: { ...fishingState({}), stock } });
}

/** A legacy species inventory is ownership proof; capture it only before folding. */
export function normalizeFishStockInventory(state: EconomyState) {
  const species = Object.fromEntries(economyCatalog.fishing!.fish
    .filter(fish => (state.inventory[fish.itemId] ?? 0) > 0)
    .map(fish => [fish.itemId, state.inventory[fish.itemId]]));
  state.inventory = fishClassInventory(state.inventory);
  if (Object.keys(species).length) creditFishStock(state, species);
  else reconcileFishStock(state);
}

export class FishSelectionChangedError extends Error {
  constructor() { super("Состав рыбы изменился. Выберите рыбу ещё раз"); }
}

/** Called before economic inventory is debited. Returns only known consumed fish. */
export function debitFishStock(state: EconomyState, requiredItems: FishSelection, selection?: FishSelection): FishSelection {
  const selected = selection ?? autoFillFishSelection(state, requiredItems);
  if (!fishSelectionMatches(state, requiredItems, selected)) throw new FishSelectionChangedError();
  const stock = normalizedFishStock(state), consumed: FishSelection = {}, catalog = catalogFor(state);
  for (const [itemId, quantity] of Object.entries(selected)) {
    if (!catalog.fish.some(fish => fish.itemId === itemId)) continue;
    consumed[itemId] = quantity;
    stock[itemId] -= quantity;
    if (!stock[itemId]) delete stock[itemId];
  }
  setFishStock(state, stock);
  return consumed;
}

/** Only a revealed delivery or a saved production refund supplies species proof. */
export function creditFishStock(state: EconomyState, species: FishSelection) {
  const stock = normalizedFishStock(state), catalog = catalogFor(state);
  for (const fish of catalog.fish) {
    const quantity = positiveCount(species[fish.itemId]);
    if (quantity) stock[fish.itemId] = Math.min(ECONOMY_MAX_ITEMS, (stock[fish.itemId] ?? 0) + quantity);
  }
  setFishStock(state, normalizedFishStock({ ...state, fishing: { ...fishingState(state), stock } }));
}
