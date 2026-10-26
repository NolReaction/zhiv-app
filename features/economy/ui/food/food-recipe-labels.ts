import type { EconomyCatalog } from "@/features/economy/domain/model";

/** Special dishes require a named species; ordinary dishes accept a rarity class. */
export function recipeFishGroupLabel(recipe: EconomyCatalog["recipes"][number], catalog: EconomyCatalog): string {
  if (recipe.fishInput?.exactSpecies) return (catalog.fishing?.fish ?? []).filter(fish => (recipe.cost.items[fish.itemId] ?? 0) > 0)
    .map(fish => catalog.items.find(item => item.id === fish.itemId)?.name ?? fish.itemId).join(" + ");
  const classes = catalog.fishing?.classes.filter(entry => (recipe.cost.items[entry.itemId] ?? 0) > 0) ?? [];
  return classes.map(entry => catalog.items.find(item => item.id === entry.itemId)?.name ?? entry.itemId).join(" + ");
}
