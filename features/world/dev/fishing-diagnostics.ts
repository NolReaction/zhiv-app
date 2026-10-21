import { fishingClassWeights, fishingCollectionDraws, fishingIneligibility, fishingSpeciesWeights } from "@/features/economy/domain/fishing";
import { economyCatalog, type EconomyView } from "@/features/economy/domain/model";

export type FishingDiagnosticSelection = { rodId: string; hookId: string; baitId: string | null; routeId: string };

/** Read-only view of the same class draw used by the server for every fish. */
export function fishingDiagnostics(selection: FishingDiagnosticSelection, catalog: EconomyView["catalog"] = economyCatalog) {
  const spec = catalog.fishing;
  if (!spec) return null;
  const route = catalog.explorations.find(route => route.id === selection.routeId && spec.routeIds.includes(route.id));
  const rod = spec.rods.find(gear => gear.id === selection.rodId), hook = spec.hooks.find(gear => gear.id === selection.hookId);
  const bait = spec.baits.find(gear => gear.itemId === selection.baitId);
  if (!route || !rod || !hook || selection.baitId !== null && !bait) return null;
  const draws = fishingCollectionDraws(route.id, spec), totalFish = route.rewards.fish ?? 0;
  if (draws <= 0 || draws !== totalFish) return null;
  const weights = fishingClassWeights(rod.id, selection.baitId, spec, hook.id), totalWeight = weights.reduce((sum, row) => sum + row.weight, 0);
  if (!totalWeight) return null;
  const classes = spec.classes.map(group => {
    const weight = weights.find(row => row.itemId === group.itemId)!.weight, probability = weight / totalWeight;
    const eligibleSpecies = spec.fish.filter(fish => fish.rarity === group.rarity && !fishingIneligibility(fish, rod.id, hook.id, spec)).length;
    return { ...group, rodBasisPoints: rod.classOddsBps?.[group.rarity] ?? group.weight, weight, probability, totalWeight, eligibleSpecies,
      hookFactor: hook.rarityWeights?.[group.rarity] ?? 100,
      baitFactor: bait?.rarityWeights?.[group.rarity] ?? 100, expectedCount: draws * probability,
      atLeastOne: -Math.expm1(draws * Math.log1p(-probability)) };
  });
  const rows = spec.fish.map(fish => {
    const group = classes.find(group => group.rarity === fish.rarity)!;
    const reason = fishingIneligibility(fish, rod.id, hook.id, spec);
    const tickets = fishingSpeciesWeights(rod.id, fish.rarity, spec, hook.id), speciesTotal = tickets.reduce((sum, row) => sum + row.weight, 0);
    const speciesWeight = tickets.find(row => row.itemId === fish.itemId)?.weight ?? 0;
    const probability = !reason && speciesTotal ? group.probability * speciesWeight / speciesTotal : 0;
    return { ...fish, probability, eligibleSpecies: group.eligibleSpecies, speciesWeight, speciesTotal,
      name: catalog.items.find(item => item.id === fish.itemId)?.name ?? fish.itemId,
      reason, expectedCount: draws * probability,
      // Bernoulli model of the separately seeded draws; not a guarantee of a drop.
      atLeastOne: -Math.expm1(draws * Math.log1p(-probability)),
    };
  });
  return { route, rod, hook, bait, draws, totalFish, totalWeight, classes, rows };
}
