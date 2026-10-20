import { foodState } from "@/features/economy/domain/food";
import { economyActorConflict } from "@/features/economy/domain/actor-availability";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import type { EconomyView } from "@/features/economy/domain/model";
import { worldMissingRequirements, worldRecipeUnlockReason, worldRequirements } from "@/features/economy/ui/shared/world-stations";

export type MealConsumer = "hero" | "builder";

export function availableMealRecipe(state: EconomyView, itemId: string) {
  return state.catalog.recipes.find(recipe => (recipe.rewards[itemId] ?? 0) > 0
    && !worldMissingRequirements(state, worldRequirements(recipe, recipe)).length
    && !worldRecipeUnlockReason(state, recipe));
}

/** Owned meals remain usable even when their recipe has not been unlocked. */
export function visibleMeals(state: EconomyView) {
  return state.catalog.food?.meals.filter(meal => (state.inventory[meal.itemId] ?? 0) > 0 || availableMealRecipe(state, meal.itemId)) ?? [];
}

/** Feeding describes one explicit meal debit; local mood is not hunger. */
export function mealBlockedReason(economy: ReadyEconomy, consumer: MealConsumer) {
  const state = economy.snapshot, food = foodState(state);
  if (consumer === "hero") {
    if (food.heroMeal) return "Мохлик уже сыт: обед поможет в следующей вылазке.";
    return economyActorConflict(state.jobs, "departure", economy.now)?.message ?? null;
  }
  const construction = state.jobs.find(job => job.kind === "construction");
  if (construction) {
    if (Date.parse(construction.finishesAt) <= economy.now) return "Сначала завершите готовую стройку.";
    if (construction.meal) return "Шишколап уже сыт: текущая стройка ускорена.";
  }
  return food.builderMeal ? "Обед Шишколапа сохранён для следующей стройки." : null;
}
