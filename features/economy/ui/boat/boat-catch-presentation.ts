import type { EconomyView } from "@/features/economy/domain/model";
import type { BoatVoyage } from "@/features/economy/domain/boat-model";
import { boatState } from "@/features/economy/domain/boat-fishing";
import { itemName } from "@/features/economy/ui/shared/world-economy-parts";

type Catch = BoatVoyage["catches"][number];
type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export const boatRarityLabels: Record<Rarity, string> = {
  common: "Обычная", uncommon: "Необычная", rare: "Редкая", epic: "Эпическая", legendary: "Легендарная",
};

/** Weight tiers are cosmetic and use each species' real configured range. */
export function boatCatchSize(weightGrams: number, range?: { minGrams: number; maxGrams: number }) {
  if (!range || range.maxGrams <= range.minGrams || !Number.isFinite(weightGrams))
    return { sizeLabel: "Обычного размера", sizeScale: 1, tier: "normal" as const };
  const ratio = Math.max(0, Math.min(1, (weightGrams - range.minGrams) / (range.maxGrams - range.minGrams)));
  const tier = ratio < .25 ? "small" : ratio < .7 ? "normal" : ratio < .9 ? "large" : "trophy";
  const labels = { small: "Небольшая", normal: "Обычного размера", large: "Крупная", trophy: "Трофейная" };
  return { sizeLabel: labels[tier], sizeScale: .78 + ratio * .52, tier };
}

/** Only confirmed server catches participate. No inventory purchases or hidden voyage slots. */
export function boatCatchPresentation(state: EconomyView, caught: Catch) {
  const boat = boatState(state), fish = state.catalog.fishing?.fish.find(item => item.itemId === caught.fishId);
  const rarity: Rarity = fish?.rarity ?? "common";
  const earlier = (boat.voyage?.catches ?? []).filter(item => item.castIndex < caught.castIndex && item.fishId === caught.fishId);
  const deliveredBest = boat.records[caught.fishId]?.weightGrams ?? 0;
  const previousBestGrams = Math.max(deliveredBest, ...earlier.map(item => item.weightGrams));
  const isNewSpecies = (state.fishing.catches[caught.fishId] ?? 0) === 0 && !deliveredBest && earlier.length === 0;
  const isRecord = previousBestGrams > 0 && caught.weightGrams > previousBestGrams;
  const size = boatCatchSize(caught.weightGrams, state.catalog.boat?.weights[caught.fishId]);
  const revealMs = isRecord || size.tier === "trophy" ? 6000 : isNewSpecies || rarity === "legendary" || rarity === "epic" ? 5000 : 3500;
  return { rarity, rarityLabel: boatRarityLabels[rarity], ...size, isNewSpecies, isRecord, previousBestGrams, revealMs };
}

/** The permanent species ledger survives sale/cooking; onboard catches are explicitly provisional. */
export function boatAlbumEntries(state: EconomyView) {
  const boat = boatState(state), catches = boat.voyage?.catches ?? [];
  return (state.catalog.fishing?.fish ?? []).map(fish => {
    const onboard = catches.filter(caught => caught.fishId === fish.itemId);
    const record = boat.records[fish.itemId]?.weightGrams ?? 0;
    const lifetime = state.fishing.catches[fish.itemId] ?? 0;
    const bestWeightGrams = Math.max(record, ...onboard.map(caught => caught.weightGrams));
    return { fishId: fish.itemId, name: itemName(state, fish.itemId), rarity: fish.rarity, description: fish.description,
      discovered: lifetime > 0 || record > 0 || onboard.length > 0,
      count: Math.max(lifetime + onboard.length, record ? 1 : 0), bestWeightGrams, onBoardCount: onboard.length,
      provisional: onboard.length > 0 && bestWeightGrams > record };
  });
}
