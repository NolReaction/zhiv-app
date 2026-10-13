import type { EconomyCatalog } from "@/features/economy/domain/model";

/** Recipes consume exact class stocks; collection species never need choosing. */
export function recipeFishGroupLabel(recipe: EconomyCatalog["recipes"][number], catalog: EconomyCatalog): string {
  const classes = catalog.fishing?.classes.filter(entry => (recipe.cost.items[entry.itemId] ?? 0) > 0) ?? [];
  return classes.map(entry => catalog.items.find(item => item.id === entry.itemId)?.name ?? entry.itemId).join(" + ");
}
