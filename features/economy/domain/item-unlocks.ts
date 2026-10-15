import { obtainableResidentOrderItems } from "./food";
import { fishingClassItemId } from "./fishing";
import { economyCatalog, type EconomyCatalog, type EconomyState } from "./model";

export type ItemUnlockSource = Pick<EconomyState, "buildings"> & Partial<Pick<EconomyState,
  "unlockedItems" | "itemUnlockVersion" | "inventory" | "progression" | "fishing" | "residentOrders">> & { catalog?: EconomyCatalog };

/** Sources and confirmed work open items permanently; imported legacy stock is a one-time seed. */
export function unlockedEconomyItems(state: ItemUnlockSource, legacyHistory: readonly string[] = [], catalog = state.catalog ?? economyCatalog): string[] {
  const known = new Set(catalog.items.map(item => item.id));
  const result = new Set<string>();
  const add = (itemId: string) => { const id = fishingClassItemId(itemId, catalog.fishing); if (known.has(id)) result.add(id); };
  state.unlockedItems?.forEach(add);
  obtainableResidentOrderItems(state, catalog).forEach(add);
  for (const [id, count] of Object.entries(state.progression?.recipes ?? {})) if (count > 0)
    Object.entries(catalog.recipes.find(recipe => recipe.id === id)?.rewards ?? {}).forEach(([item, quantity]) => { if (quantity > 0) add(item); });
  for (const [id, count] of Object.entries(state.progression?.routes ?? {})) if (count > 0) {
    const route = catalog.explorations.find(route => route.id === id);
    if (route) Object.entries(route.rewards).forEach(([item, quantity]) => { if (quantity > 0) add(item); });
  }
  for (const [id, count] of Object.entries(state.fishing?.catches ?? {})) if (count > 0) add(id);
  // Public views carry the server's projection and omit the private migration marker.
  if ((state.itemUnlockVersion ?? (state.catalog ? 1 : 0)) === 0) {
    for (const [id, count] of Object.entries(state.inventory ?? {})) if (count > 0) add(id);
    legacyHistory.forEach(add);
  }
  return [...result].sort();
}

/** Call only after accepting a mutation; callers seal old stock before accepting new gifts or purchases. */
export function persistEconomyItemUnlocks(state: ItemUnlockSource, confirmedRewards: readonly string[] = [], legacyHistory: readonly string[] = []): void {
  state.unlockedItems = unlockedEconomyItems({ ...state, unlockedItems: [...(state.unlockedItems ?? []), ...confirmedRewards] }, legacyHistory);
  state.itemUnlockVersion = 1;
}

export function mergeEconomyItemUnlocks(first: ItemUnlockSource, second: ItemUnlockSource): string[] {
  return [...new Set([...unlockedEconomyItems(first), ...unlockedEconomyItems(second)])].sort();
}
