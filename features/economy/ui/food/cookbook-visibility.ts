import type { EconomyView } from "@/features/economy/domain/model";
import { familiarEconomyItems } from "@/features/economy/domain/familiar-items";
import { experimentCanPractice } from "@/features/economy/domain/craft-skill";
import { worldMissingRequirements, worldRequirements, type WorldRecipe } from "@/features/economy/ui/shared/world-stations";

const basicRecipes = new Set(["cook_grilled_fish", "cook_compote"]);
// Fuel and packaging affect the debit and its availability, not familiarity with a dish.
const supportingIngredients = new Set(["wood", "hardwood", "charcoal", "glass", "ceramic_jar", "glass_bottle", "trade_crate"]);

export function cookbookCoreIngredients(recipe: WorldRecipe): string[] {
  const ingredients = Object.entries(recipe.cost.items).filter(([, quantity]) => quantity > 0).map(([id]) => id);
  const core = ingredients.filter(id => !supportingIngredients.has(id));
  return core.length ? core : ingredients;
}

/** Visibility is discovery, not permission to spend ingredients or start a job. */
export function cookbookRecipeVisible(state: EconomyView, recipe: WorldRecipe, familiar: ReadonlySet<string> = new Set(familiarEconomyItems(state))): boolean {
  if (recipe.retired || recipe.buildingId !== "dryer") return false;
  // A learned page survives empty inventory and later changes to its requirements.
  if ((state.progression?.recipes?.[recipe.id] ?? 0) > 0) return true;
  if (worldMissingRequirements(state, worldRequirements(recipe, recipe)).length) return false;
  if (basicRecipes.has(recipe.id)) return true;
  if (!experimentCanPractice(state, recipe, state.catalog)) return false;
  return cookbookCoreIngredients(recipe).every(itemId => familiar.has(itemId));
}

export function cookbookVisibleRecipes(state: EconomyView, recipes: readonly WorldRecipe[]): WorldRecipe[] {
  const familiar = new Set(familiarEconomyItems(state));
  return recipes.filter(recipe => cookbookRecipeVisible(state, recipe, familiar));
}
