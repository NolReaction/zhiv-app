import type { EconomyView } from "./model";
import type { WorldState } from "@/features/world/model";
import type { EconomySceneJourney } from "@/features/world/economy-scene-state";

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
  return job ? { id: job.id, startedAt: job.startedAt, finishesAt: job.finishesAt,
    label: economy?.catalog.explorations.find(route => route.id === job.targetId)?.name ?? "Исследование" } : null;
}
