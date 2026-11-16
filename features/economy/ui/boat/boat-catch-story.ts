import type { EconomyView } from "@/features/economy/domain/model";
import type { BoatVoyage } from "@/features/economy/domain/boat-model";
import { boatState } from "@/features/economy/domain/boat-fishing";
import { boatCatchPresentation } from "./boat-catch-presentation";

/** Small facts about an already confirmed catch; no guessed fight stats or future draws. */
export function boatCatchStory(state: EconomyView, caught: BoatVoyage["catches"][number]) {
  const fish = state.catalog.fishing?.fish.find(item => item.itemId === caught.fishId);
  const description = fish?.description.trim() ?? "";
  const note = description.match(/^[^.!?]+[.!?]?/u)?.[0]?.trim() ?? "";
  const catches = boatState(state).voyage?.catches ?? [];
  const tripSpeciesCount = new Set(catches.filter(item => item.fishId === caught.fishId && item.castIndex <= caught.castIndex)
    .map(item => item.castIndex)).size;
  const presentation = boatCatchPresentation(state, caught);
  return { note, tripSpeciesCount,
    recordGainGrams: presentation.isRecord ? caught.weightGrams - presentation.previousBestGrams : 0 };
}
