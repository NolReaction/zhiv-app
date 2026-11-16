import { fishingClassItemId } from "./fishing";
import { normalizedFishStock } from "./fish-stock";
import { economyCatalog, type EconomyCatalog, type EconomyState } from "./model";

type FamiliarSource = Partial<Pick<EconomyState, "familiarItems" | "inventory" | "progression" | "fishing">> & { catalog?: EconomyCatalog };

/** Encountered goods, distinct from items whose source is merely available.
 * Project without mutating old saves; persist around accepted inventory changes. */
export function familiarEconomyItems(state: FamiliarSource, legacyHistory: readonly string[] = [], catalog = state.catalog ?? economyCatalog): string[] {
  const known = new Set(catalog.items.map(item => item.id));
  const familiar = new Set<string>();
  const add = (itemId: string) => {
    if (known.has(itemId)) familiar.add(itemId);
    const group = fishingClassItemId(itemId, catalog.fishing);
    if (known.has(group)) familiar.add(group);
  };
  const addPositive = (items: Record<string, number> | null | undefined) => {
    for (const [itemId, quantity] of Object.entries(items ?? {})) if (quantity > 0) add(itemId);
  };
  state.familiarItems?.forEach(add);
  addPositive(state.inventory);
  addPositive(normalizedFishStock({ inventory: state.inventory ?? {}, fishing: state.fishing, catalog }));
  addPositive(state.fishing?.catches);
  for (const items of Object.values(state.fishing?.escrow ?? {})) addPositive(items);
  if (state.familiarItems == null) {
    for (const [id, quantity] of Object.entries(state.progression?.recipes ?? {})) if (quantity > 0) {
      const recipe = catalog.recipes.find(recipe => recipe.id === id);
      if (recipe) { addPositive(recipe.cost.items); addPositive(recipe.rewards); }
    }
    for (const [id, quantity] of Object.entries(state.progression?.routes ?? {})) if (quantity > 0) {
      const route = catalog.explorations.find(route => route.id === id);
      if (route && !catalog.fishing?.routeIds.includes(id)) {
        addPositive(route.rewards);
        for (const reward of route.loot ?? []) if (reward.min > 0) add(reward.itemId);
      }
    }
    legacyHistory.forEach(add);
  }
  return [...familiar].sort();
}
