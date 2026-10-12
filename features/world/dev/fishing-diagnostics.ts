import { fishingCollectionDraws, fishingIneligibility, fishingWeights } from "@/features/economy/domain/fishing";
import { economyCatalog, type EconomyView } from "@/features/economy/domain/model";

export type FishingDiagnosticSelection = { rodId: string; hookId: string; baitId: string | null; routeId: string };

/** Read-only view of the real rules, including ordinary fish outside collection draws. */
export function fishingDiagnostics(selection: FishingDiagnosticSelection, catalog: EconomyView["catalog"] = economyCatalog) {
  const spec = catalog.fishing;
  if (!spec) return null;
  const route = catalog.explorations.find(route => route.id === selection.routeId && spec.routeIds.includes(route.id));
  const rod = spec.rods.find(gear => gear.id === selection.rodId), hook = spec.hooks.find(gear => gear.id === selection.hookId);
  const bait = spec.baits.find(gear => gear.itemId === selection.baitId);
  if (!route || !rod || !hook || selection.baitId !== null && !bait) return null;
  const draws = fishingCollectionDraws(route.id, spec), totalFish = route.rewards.fish ?? 0;
  if (draws <= 0 || draws > totalFish) return null;
  const weights = fishingWeights(rod.id, selection.baitId, spec, hook.id), totalWeight = weights.reduce((sum, row) => sum + row.weight, 0);
  if (!totalWeight) return null;
  const specialized = [...spec.rods, ...spec.hooks, ...spec.baits].some(gear => gear.rarityWeights);
  const rows = spec.fish.map((fish, index) => {
    const weight = weights[index].weight, probability = weight / totalWeight;
    const guaranteed = fish.itemId === "fish" ? totalFish - draws : 0;
    return { ...fish, weight, baseWeight: fish.weight, totalWeight, probability, guaranteed,
      name: catalog.items.find(item => item.id === fish.itemId)?.name ?? fish.itemId,
      rodFactor: rod.rarityWeights?.[fish.rarity] ?? 100, hookFactor: hook.rarityWeights?.[fish.rarity] ?? 100,
      baitFactor: bait?.rarityWeights?.[fish.rarity] ?? 100,
      legacyBonus: (rod.rareBonus ?? 0) + (hook.rareBonus ?? 0) + (bait?.rareBonus ?? 0),
      reason: fishingIneligibility(fish, rod.id, hook.id, spec),
      expectedCount: guaranteed + draws * probability,
      // Bernoulli model of the separately seeded draws; not a guarantee of a drop.
      atLeastOne: guaranteed > 0 ? 1 : -Math.expm1(draws * Math.log1p(-probability)),
    };
  });
  return { route, rod, hook, bait, draws, totalFish, totalWeight, specialized, rows };
}
