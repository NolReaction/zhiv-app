import { foodState } from "./food";
import { economyActorConflict } from "./actor-availability";
import type { ReadyEconomy } from "./world-economy-parts";

export type MealConsumer = "hero" | "builder";

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
