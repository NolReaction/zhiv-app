import type { ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { ForestVillagerId } from "@/features/world/characters/forest-villager-types";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import { approachVillagerDoor } from "./villager-doorway";
import { forestVillagerPlaces, type VillagerPlaces } from "./villager-navigation";
import { villagerShelterWeather, type ForestVillagerEnvironment, type ForestVillagerMind, type ForestVillagersState } from "./villager-state";

/** An explicit rehearsal uses the same real approach and private threshold as
 * a natural home break. It never clears a job, carried log or social promise. */
export function requestForestVillagerHome(state: ForestVillagersState, scene: FixedWorldScene, id: ForestVillagerId,
  occupants?: readonly ResidentOccupant[]): boolean {
  const mind = state.residents[id];
  if (state.scene !== scene || !mind.available || mind.job || mind.socialVisit || mind.noticePending
    || mind.doorPhase !== "outside" || mind.woodwork && mind.woodwork.phase !== "idle"
    || id === "kamneshmyg" && state.arrivalPhase !== "complete") return false;
  const places = forestVillagerPlaces(scene, id);
  return !!places && approachVillagerDoor(mind, places, occupants);
}

/** A promised guest, loaded log or confirmed shift owns the resident before a
 * voluntary home break. Home clocks run only with the shared active scene. */
export function tryVillagerHome(mind: ForestVillagerMind, places: VillagerPlaces,
  env: ForestVillagerEnvironment, occupants: readonly ResidentOccupant[]): boolean {
  if (!places.door || mind.job || mind.doorPhase !== "outside" || mind.socialVisit || mind.noticePending
    || env.socialHolds?.includes(mind.id) || env.wildlifeHolds?.includes(mind.id)
    || mind.intent === "yield" && mind.route || mind.woodwork && mind.woodwork.phase !== "idle"
    || mind.elapsed < mind.retryAt) return false;
  if (!villagerShelterWeather(env) && mind.elapsed < mind.outdoorUntil && mind.fatigue < .7) return false;
  if ((mind.goal?.intent === "wander" || mind.habit || mind.route && mind.intent === "wander")
    && !villagerShelterWeather(env) && mind.fatigue < .7) return false;
  mind.retryAt = mind.elapsed + 6;
  return approachVillagerDoor(mind, places, occupants);
}
