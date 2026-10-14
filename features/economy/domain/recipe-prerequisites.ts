import type { EconomyCatalog } from "./model";

/** Name the claimed result instead of repeating a recipe's action verb. */
export function recipeResultName(recipeId: string, catalog: Pick<EconomyCatalog, "recipes" | "items">) {
  const recipe = catalog.recipes.find(entry => entry.id === recipeId);
  if (!recipe) return recipeId;
  const names = Object.entries(recipe.rewards).filter(([, count]) => count > 0)
    .map(([itemId]) => catalog.items.find(item => item.id === itemId)?.name ?? itemId);
  return names.join(", ") || recipe.name;
}
