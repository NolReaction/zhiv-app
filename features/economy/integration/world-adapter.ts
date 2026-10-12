import type { EconomyView } from "@/features/economy/domain/model";
import type { WorldState } from "@/features/world/domain/model";
import type { EconomySceneActivity, EconomySceneJourney } from "@/features/world/state/economy/economy-scene-state";
import type { EconomySceneProduction } from "@/features/world/state/economy/economy-production-state";
import type { EconomySceneConstruction } from "@/features/world/state/economy/economy-construction-state";

/** A scene click selects existing economy UI; it never upgrades a local site. */
export function economyBuildingDestination(buildingId: string, economy: EconomyView | null | undefined): { tab: "buildings" | "production"; focusId: string } {
  const producing = (economy?.buildings[buildingId] ?? 0) > 0
    && economy?.catalog.recipes.some(recipe => recipe.buildingId === buildingId)
    && !economy.jobs.some(job => job.kind === "construction" && job.targetId === buildingId);
  return { tab: producing ? "production" : "buildings", focusId: buildingId };
}

/** Keep wardrobe/collections in their original profile, while buildings use authoritative economy levels. */
export function economyWorldState(state: WorldState | undefined, economy: EconomyView | null | undefined): WorldState | undefined {
  if (!state || !economy) return state;
  const houseLevel = economy.buildings.home ?? state.houseLevel;
  const workshopLevel = economy.buildings.workshop ?? 0;
  if (houseLevel === state.houseLevel && workshopLevel === (state.workshopLevel ?? (state.workshop ? 1 : 0))) return state;
  return { ...state, houseLevel, workshop: workshopLevel > 0, workshopLevel };
}

export function economySceneJourney(economy: EconomyView | null | undefined): EconomySceneJourney | null {
  const job = economy?.jobs.find(job => job.kind === "exploration");
  return job ? { id: job.id, startedAt: job.startedAt, finishesAt: job.finishesAt, routeId: job.targetId,
    rewards: { ...job.rewards },
    ...(job.fishing ? { fishing: { rodId: job.fishing.rodId, fishId: job.fishing.fishId } } : {}),
    label: economy?.catalog.explorations.find(route => route.id === job.targetId)?.name ?? "Исследование" } : null;
}

/** A bounded visual projection of confirmed production, including unclaimed ready jobs. */
export function economySceneProduction(economy: EconomyView | null | undefined): EconomySceneProduction | null {
  if (!economy) return null;
  return { ownerPublicId: economy.ownerPublicId, revision: economy.revision, jobs: economy.jobs.flatMap(job => {
    if (job.kind !== "production") return [];
    // Retired mine jobs keep their saved walk/work animation until claimed.
    // Their recipes are intentionally absent from the current production catalog.
    if (job.targetId === "quarry") return [{ id: job.id, stationId: "quarry", stationLevel: economy.buildings.quarry ?? 0,
      recipeId: job.recipeId ?? "quarry_legacy", startedAt: job.startedAt, finishesAt: job.finishesAt }];
    const recipe = economy.catalog.recipes.find(recipe => recipe.id === job.recipeId && recipe.buildingId === job.targetId);
    return recipe ? [{ id: job.id, stationId: recipe.buildingId, stationLevel: economy.buildings[recipe.buildingId] ?? 0,
      recipeId: recipe.id, startedAt: job.startedAt, finishesAt: job.finishesAt }] : [];
  }) };
}

/** Only confirmed construction reaches the builder; a completed timer still reserves him until claim. */
export function economySceneConstruction(economy: EconomyView | null | undefined): EconomySceneConstruction | null {
  if (!economy) return null;
  return { ownerPublicId: economy.ownerPublicId, revision: economy.revision, jobs: economy.jobs.flatMap(job =>
    job.kind === "construction" && Number.isInteger(job.targetLevel) && job.targetLevel! > 0
      ? [{ id: job.id, stationId: job.targetId, targetLevel: job.targetLevel!, startedAt: job.startedAt, finishesAt: job.finishesAt }]
      : []) };
}

/** Keep a returned exploration visible until claimed; otherwise show the first work to finish. */
export function economySceneActivity(economy: EconomyView | null | undefined): EconomySceneActivity | null {
  const journey = economySceneJourney(economy);
  if (journey) return { ...journey, kind: "exploration" };
  const job = economy?.jobs.filter(entry => entry.kind === "production")
    .sort((left, right) => Date.parse(left.finishesAt) - Date.parse(right.finishesAt))[0];
  if (!job) return null;
  return { id: job.id, kind: "production", startedAt: job.startedAt, finishesAt: job.finishesAt,
    label: economy?.catalog.recipes.find(recipe => recipe.id === job.recipeId)?.name ?? (job.targetId === "quarry" ? "Работа в шахте" : "Работа в мастерской"),
    itemId: Object.keys(job.rewards)[0], collection: job.collection };
}
