import { economyCatalog, type EconomyCatalog } from "@/features/economy/domain/model";
import { fishClassForItem, fishingBaitCompatible, fishingClassOdds, fishingCollectionDraws, fishingOdds } from "@/features/economy/domain/fishing";
import { economyLocalSellPrice } from "@/features/economy/domain/local-sale";
import { expeditionGuaranteedRewards } from "./economy-sources";

const price = (catalog: EconomyCatalog, id: string) => {
  const item = catalog.items.find(item => item.id === id);
  return item?.tradable ? economyLocalSellPrice(item.baseSellPrice, 1, catalog.localBuyer, id) : 0;
};
const value = (catalog: EconomyCatalog, items: Record<string, number>) => Object.entries(items).reduce((sum, [id, quantity]) => sum + price(catalog, id) * quantity, 0);
export type FishingReturnOptions = { routeId: string; rodId: string; hookId: string; baitId: string | null };

/** The private completed-work clock has no fixed probability for one departure. */
export function expeditionRelicRules(catalog: EconomyCatalog = economyCatalog) {
  const spec = catalog.rareDrops;
  return spec?.itemIds.length ? { requiredHomeLevel: spec.requiredHomeLevel, minimumSeconds: spec.minSeconds, maximumSeconds: spec.maxSeconds,
    items: spec.itemIds.map(itemId => ({ itemId, conditionalProbability: 1 / spec.itemIds.length })) } : null;
}

/** Expected values describe many independent draws, never a deadline for a species. */
export function fishingExpectedReturn(options: FishingReturnOptions, catalog: EconomyCatalog = economyCatalog) {
  const fishing = catalog.fishing, route = catalog.explorations.find(route => route.id === options.routeId && !route.retired);
  if (!fishing || !route || !fishing.routeIds.includes(route.id) || !fishing.rods.some(rod => rod.id === options.rodId)
    || !fishing.hooks.some(hook => hook.id === options.hookId) || !fishingBaitCompatible(options.rodId, options.baitId, fishing)) return null;
  const draws = fishingCollectionDraws(route.id, fishing), classes = fishingClassOdds({}, fishing, options);
  const bait = fishing.baits.find(bait => bait.itemId === options.baitId);
  const guaranteed = Object.fromEntries(Object.entries(route.rewards).filter(([id]) => !fishClassForItem(id, fishing)));
  const expectedFishCoins = classes.reduce((sum, group) => sum + group.probability * price(catalog, group.itemId) * draws, 0);
  const costCoins = route.cost.coins + value(catalog, route.cost.items) + (bait?.price ?? 0);
  const expectedGrossCoins = expectedFishCoins + value(catalog, guaranteed), expectedNetCoins = expectedGrossCoins - costCoins;
  return { routeId: route.id, seconds: route.seconds, draws, guaranteed, costCoins, expectedGrossCoins, expectedNetCoins, relics: expeditionRelicRules(catalog),
    expectedNetCoinsPerMinute: expectedNetCoins * 60 / route.seconds,
    capitalCoins: (fishing.rods.find(rod => rod.id === options.rodId)?.price ?? 0) + (fishing.hooks.find(hook => hook.id === options.hookId)?.price ?? 0),
    species: fishingOdds({}, fishing, options).map(fish => ({ itemId: fish.itemId, probability: fish.probability,
      expectedQuantity: fish.probability * draws, atLeastOneProbability: 1 - (1 - fish.probability) ** draws })),
  };
}

export function expeditionExpectedReturns(catalog: EconomyCatalog = economyCatalog) {
  return catalog.explorations.filter(route => !route.retired && !catalog.fishing?.routeIds.includes(route.id)).map(route => {
    const totalWeight = (route.finds?.emptyWeight ?? 0) + (route.finds?.entries.reduce((sum, entry) => sum + entry.weight, 0) ?? 0);
    const finds = (route.finds?.entries ?? []).map(entry => ({ ...entry, probability: totalWeight ? entry.weight / totalWeight : 0 }));
    const guaranteed = expeditionGuaranteedRewards(route);
    const loot = (route.loot ?? []).map(entry => ({ itemId: entry.itemId,
      minimum: guaranteed[entry.itemId] ?? 0, maximum: (route.rewards[entry.itemId] ?? 0) + entry.max,
      expectedQuantity: (route.rewards[entry.itemId] ?? 0) + (entry.min + entry.max) / 2,
      probability: (guaranteed[entry.itemId] ?? 0) > 0 ? 1 : entry.max / (entry.max - entry.min + 1) }));
    const guaranteedCoins = value(catalog, guaranteed), costCoins = route.cost.coins + value(catalog, route.cost.items);
    const expectedVariableCoins = loot.reduce((sum, entry) => sum + (entry.expectedQuantity - entry.minimum) * price(catalog, entry.itemId), 0);
    const expectedBonusCoins = finds.reduce((sum, entry) => sum + entry.probability * entry.quantity * price(catalog, entry.itemId), 0);
    const expectedNetCoins = guaranteedCoins + expectedVariableCoins + expectedBonusCoins - costCoins;
    return { id: route.id, name: route.name, homeLevel: route.requiredHomeLevel, seconds: route.seconds, actor: route.activity === "mining" ? "miner" : "hero",
      guaranteed, guaranteedCoins, costCoins, loot, finds, emptyProbability: totalWeight ? (route.finds?.emptyWeight ?? 0) / totalWeight : 1,
      relics: expeditionRelicRules(catalog),
      expectedVariableCoins, expectedBonusCoins, expectedNetCoins,
      expectedNetCoinsPerMinute: expectedNetCoins * 60 / route.seconds };
  });
}
