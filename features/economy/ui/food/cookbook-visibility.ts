import type { EconomyView } from "@/features/economy/domain/model";
import { familiarEconomyItems } from "@/features/economy/domain/familiar-items";
import { campfireRecipeSection } from "./campfire-recipe-groups";
import { cookbookFishRarity } from "./cookbook-recipes";
import { experimentCanPractice } from "@/features/economy/domain/craft-skill";
import { worldMissingRequirements, worldRequirements, worldRecipeCost, type WorldRecipe } from "@/features/economy/ui/shared/world-stations";

const basicRecipes = new Set(["cook_grilled_fish", "cook_compote"]);
// Fuel and packaging affect the debit and its availability, not familiarity with a dish.
const supportingIngredients = new Set(["wood", "hardwood", "charcoal", "glass", "ceramic_jar", "glass_bottle", "trade_crate"]);

export function cookbookCoreIngredients(recipe: WorldRecipe): string[] {
  const ingredients = Object.entries(recipe.cost.items).filter(([, quantity]) => quantity > 0).map(([id]) => id);
  const core = ingredients.filter(id => !supportingIngredients.has(id));
  return core.length ? core : ingredients;
}

/** Visibility is discovery, not permission to spend ingredients or start a job. */
export function cookbookRecipeVisibility(state: EconomyView, recipe: WorldRecipe, familiar: ReadonlySet<string>): "known" | "masked" | "future" {
  if (recipe.retired || recipe.buildingId !== "dryer") return "future";
  // A learned page survives empty inventory and later changes to its requirements.
  if ((state.progression?.recipes?.[recipe.id] ?? 0) > 0) return "known";
  if (worldMissingRequirements(state, worldRequirements(recipe, recipe)).length) return "future";
  if (basicRecipes.has(recipe.id)) return "known";
  return experimentCanPractice(state, recipe, state.catalog) && cookbookCoreIngredients(recipe).every(id => familiar.has(id))
    ? "known" : "masked";
}

export function cookbookRecipeVisible(state: EconomyView, recipe: WorldRecipe, familiar: ReadonlySet<string> = new Set(familiarEconomyItems(state))) {
  return cookbookRecipeVisibility(state, recipe, familiar) === "known";
}

/** A locked page exposes ingredient clues, never the output, recipe title or result artwork. */
export function cookbookPages(state: EconomyView, recipes: readonly WorldRecipe[]) {
  const familiar = new Set(familiarEconomyItems(state));
  const known: WorldRecipe[] = [];
  const masked = [];
  for (const recipe of recipes) {
    const visibility = cookbookRecipeVisibility(state, recipe, familiar);
    if (visibility === "known") known.push(recipe);
    if (visibility === "masked") {
      const category = recipe.experiment ? "discoveries" : campfireRecipeSection(recipe)?.id ?? "provisions";
      const cost = worldRecipeCost(state, recipe);
      masked.push({
        key: recipe.id, category, rarity: cookbookFishRarity(state, recipe), cost,
        unfamiliar: cookbookCoreIngredients(recipe).filter(id => !familiar.has(id)),
        requiredSkill: experimentCanPractice(state, recipe, state.catalog) ? null : recipe.experiment!.requiredCookingLevel,
      });
    }
  }
  return { known, masked, maskedTotal: masked.length };
}
