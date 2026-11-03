import type { EconomyView } from "@/features/economy/domain/model";
import type { BoatVoyage } from "@/features/economy/domain/boat-model";
import { boatState } from "@/features/economy/domain/boat-fishing";
import { itemName } from "@/features/economy/ui/shared/world-economy-parts";
import { boatCatchPresentation } from "./boat-catch-presentation";

export type BoatTripCatch = Readonly<{
  castIndex: number; fishId: string; name: string; weightGrams: number;
  rarity: ReturnType<typeof boatCatchPresentation>["rarity"]; rarityLabel: string; sizeLabel: string;
  isNewSpecies: boolean; isRecord: boolean; previousBestGrams: number;
}>;
export type BoatTripReceipt = Readonly<{
  voyageId: string; routeName: string; catches: readonly BoatTripCatch[];
  count: number; castsUsed: number; totalWeightGrams: number; largest: BoatTripCatch | null;
  newSpeciesCount: number; recordSpeciesCount: number;
}>;

/** A detached display receipt. Only confirmed catches enter it; it never credits inventory. */
export function createBoatTripReceipt(state: EconomyView, voyage: BoatVoyage): BoatTripReceipt {
  const displayState = { ...state, boat: { ...boatState(state), voyage } };
  const catches = voyage.catches.map(caught => {
    const details = boatCatchPresentation(displayState, caught);
    return Object.freeze({ castIndex: caught.castIndex, fishId: caught.fishId, name: itemName(state, caught.fishId),
      weightGrams: caught.weightGrams, rarity: details.rarity, rarityLabel: details.rarityLabel,
      sizeLabel: details.sizeLabel, isNewSpecies: details.isNewSpecies, isRecord: details.isRecord,
      previousBestGrams: details.previousBestGrams });
  });
  const largest = catches.reduce<BoatTripCatch | null>((best, caught) => !best || caught.weightGrams > best.weightGrams ? caught : best, null);
  return Object.freeze({ voyageId: voyage.id, routeName: state.catalog.boat?.name ?? "Речной плёс",
    catches: Object.freeze(catches), count: catches.length, castsUsed: voyage.castsUsed,
    totalWeightGrams: catches.reduce((total, caught) => total + caught.weightGrams, 0), largest,
    newSpeciesCount: new Set(catches.filter(caught => caught.isNewSpecies).map(caught => caught.fishId)).size,
    recordSpeciesCount: new Set(catches.filter(caught => caught.isRecord).map(caught => caught.fishId)).size });
}
