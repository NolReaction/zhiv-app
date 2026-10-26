import type { EconomyState } from "@/features/economy/domain/model";
import { economyCatalog } from "@/features/economy/domain/model";
import achievements from "@/apps/api/src/main/resources/world/achievements-catalog.json";
import { personallyFoundBookCollection } from "@/features/economy/domain/collection-progress";

export const GAME_ACHIEVEMENT_TARGETS = achievements.targets;
export const LEGACY_GAME_ACHIEVEMENT_TARGETS = achievements.legacyTargets;
// Paid production already issued before mining became an activity keeps its
// promised recipe progress. New mining claims only increment route counters.
const recognizedRecipes = new Set([...economyCatalog.recipes.map(recipe => recipe.id), ...achievements.legacyRecipeIds]);
export type AchievementProgressState = Pick<EconomyState, "completedExplorations" | "buildings" | "fishing" | "progression" | "residentOrders">;

/** Only completed-job counters and personal catches qualify; inventory purchases never do. */
export function economyAchievementProgress(state: AchievementProgressState | null, confirmedSales = 0, inheritedFinds: readonly string[] = []) {
  const progression = state?.progression;
  const routes = progression?.routes ?? {};
  const recipes = progression?.recipes ?? {};
  const completedRecipes = (building: string, limit: number) => economyCatalog.recipes.filter(recipe => recipe.buildingId === building)
    .reduce((total, recipe) => Math.min(limit, total + Math.min(limit, recipes[recipe.id] ?? 0)), 0);
  const foundPersonally = !!progression && personallyFoundBookCollection(progression.collections, inheritedFinds);
  return {
    first_path: state?.completedExplorations ?? 0,
    familiar_trails: economyCatalog.explorations.filter(route => (routes[route.id] ?? 0) > 0).length,
    explorer: state?.completedExplorations ?? 0,
    master_recipes: [...recognizedRecipes].filter(id => (progression?.recipes[id] ?? 0) > 0).length,
    home_builder: state?.buildings.home ?? 1,
    river_atlas: (economyCatalog.fishing?.fish ?? []).filter(fish => (state?.fishing.catches[fish.itemId] ?? 0) > 0).length,
    first_sale: confirmedSales,
    lucky_find: foundPersonally ? 1 : 0,
    patient_angler: (economyCatalog.fishing?.fish ?? []).reduce((total, fish) =>
      Math.min(1000, total + Math.min(1000, state?.fishing.catches[fish.itemId] ?? 0)), 0),
    campfire_cook: completedRecipes("dryer", 500),
    helpful_neighbor: state?.residentOrders?.completed ?? 0,
    generous_garden: completedRecipes("garden", 1000),
  };
}
