import { ECONOMY_MAX_ITEMS, economyCatalog, type EconomyCatalog, type EconomyState } from "./model";

type UnlockSource = Partial<Pick<EconomyState, "progression" | "fishing">> & { catalog?: EconomyCatalog };
type UnlockRecipe = Pick<EconomyCatalog["recipes"][number], "requiredRecipes" | "requiredExplorations" | "requiredFishCaught">;
export type RecipeUnlockRequirement = { kind: "recipe" | "exploration" | "fishing"; id: string;
  current: number; required: number; completed: boolean };

/** Lifetime species catches are credited by successful delivery, never by stock or purchases. */
export function personallyCaughtFish(state: UnlockSource, catalog = state.catalog ?? economyCatalog): number {
  return (catalog.fishing?.fish ?? []).reduce((sum, fish) =>
    Math.min(ECONOMY_MAX_ITEMS, sum + (state.fishing?.catches?.[fish.itemId] ?? 0)), 0);
}

/** All conditions are cumulative AND conditions; earlier confirmed work remains useful. */
export function recipeUnlockRequirements(state: UnlockSource, recipe: UnlockRecipe,
  catalog = state.catalog ?? economyCatalog): RecipeUnlockRequirement[] {
  const result: RecipeUnlockRequirement[] = [];
  const add = (kind: RecipeUnlockRequirement["kind"], id: string, current: number, required: number) => {
    if (required > 0) result.push({ kind, id, current, required, completed: current >= required });
  };
  for (const [id, required] of Object.entries(recipe.requiredRecipes ?? {}))
    add("recipe", id, state.progression?.recipes?.[id] ?? 0, required);
  for (const [id, required] of Object.entries(recipe.requiredExplorations ?? {}))
    add("exploration", id, state.progression?.routes?.[id] ?? 0, required);
  if (recipe.requiredFishCaught) add("fishing", "fish", personallyCaughtFish(state, catalog), recipe.requiredFishCaught);
  return result;
}

export function recipeUnlocksMet(state: UnlockSource, recipe: UnlockRecipe, catalog = state.catalog ?? economyCatalog): boolean {
  return recipeUnlockRequirements(state, recipe, catalog).every(requirement => requirement.completed);
}
