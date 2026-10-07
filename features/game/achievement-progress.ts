import type { EconomyState } from "@/features/economy/model";
import { economyCatalog } from "@/features/economy/model";
import achievements from "@/apps/api/src/main/resources/world/achievements-catalog.json";
import { personallyFoundBookCollection } from "@/features/economy/collection-progress";

export const GAME_ACHIEVEMENT_TARGETS = achievements.targets;
// Paid production already issued before mining became an activity keeps its
// promised recipe progress. New mining claims only increment route counters.
const recognizedRecipes = new Set([...economyCatalog.recipes.map(recipe => recipe.id), ...achievements.legacyRecipeIds]);
export type AchievementProgressState = Pick<EconomyState, "completedExplorations" | "buildings" | "fishing" | "progression">;

/** Only completed-job counters and personal catches qualify; inventory purchases never do. */
export function economyAchievementProgress(state: AchievementProgressState | null, confirmedSales = 0, inheritedFinds: readonly string[] = []) {
  const progression = state?.progression;
  const routes = progression?.routes ?? {};
  const biomes = Object.values(achievements.biomes);
  const foundPersonally = !!progression && personallyFoundBookCollection(progression.collections, inheritedFinds);
  return {
    first_path: state?.completedExplorations ?? 0,
    familiar_trails: biomes.filter(ids => ids.some(id => (routes[id] ?? 0) > 0)).length,
    explorer: state?.completedExplorations ?? 0,
    master_recipes: [...recognizedRecipes].filter(id => (progression?.recipes[id] ?? 0) > 0).length,
    home_builder: state?.buildings.home ?? 1,
    river_atlas: (economyCatalog.fishing?.fish ?? []).filter(fish => (state?.fishing.catches[fish.itemId] ?? 0) > 0).length,
    first_sale: confirmedSales,
    lucky_find: foundPersonally ? 1 : 0,
  };
}
