import { economyCatalog, economyFishingSchema, type EconomyCost, type EconomyFishing, type EconomyFishingCatalog } from "./model";

/** Defaults keep existing persisted profiles and older snapshots readable. */
export function fishingState(state: { fishing?: EconomyFishing }): EconomyFishing {
  if (!state.fishing) return economyFishingSchema.parse(undefined);
  return { ...state.fishing, ownedHooks: state.fishing.ownedHooks ?? ["bare_hook"], equippedHookId: state.fishing.equippedHookId ?? "bare_hook" };
}
export function fishingTripCost(cost: EconomyCost, state: { fishing?: EconomyFishing }): EconomyCost {
  const baitId = fishingState(state).equippedBaitId;
  return { coins: cost.coins, items: { ...cost.items, ...(baitId ? { [baitId]: (cost.items[baitId] ?? 0) + 1 } : {}) } };
}
/** Collection draws replace ordinary fish, never add hidden warehouse demand. */
export function fishingCollectionDraws(routeId: string, catalog = economyCatalog.fishing!): number {
  return catalog.collectionDrawsByRoute?.[routeId] ?? 1;
}
/** Display odds and both servers use the same bounded integer weights. */
export function fishingWeights(rodId: string, baitId: string | null, catalog = economyCatalog.fishing!, hookId = "bare_hook"): { itemId: string; weight: number }[] {
  const rod = catalog.rods.find(rod => rod.id === rodId), hook = catalog.hooks?.find(hook => hook.id === hookId),
    bait = catalog.baits.find(bait => bait.itemId === baitId);
  const specialized = catalog.rods.some(gear => gear.rarityWeights) || catalog.hooks?.some(gear => gear.rarityWeights)
    || catalog.baits.some(gear => gear.rarityWeights);
  const legacyBonus = (rod?.rareBonus ?? 0) + (hook?.rareBonus ?? 0) + (bait?.rareBonus ?? 0);
  return catalog.fish.map(fish => ({ itemId: fish.itemId,
    weight: fish.requiredHookId && fish.requiredHookId !== hookId ? 0 : specialized
      ? Math.max(1, Math.floor(fish.weight * (rod?.rarityWeights?.[fish.rarity] ?? 100)
        * (hook?.rarityWeights?.[fish.rarity] ?? 100) * (bait?.rarityWeights?.[fish.rarity] ?? 100) / 1_000_000))
      : fish.weight + fish.affinity * legacyBonus }));
}
export function fishingOdds(state: { fishing?: EconomyFishing }, catalog = economyCatalog.fishing!,
  override: { rodId?: string; hookId?: string; baitId?: string | null } = {}) {
  const current = fishingState(state);
  const weights = fishingWeights(override.rodId ?? current.equippedRodId,
    override.baitId === undefined ? current.equippedBaitId : override.baitId, catalog, override.hookId ?? current.equippedHookId);
  const total = weights.reduce((sum, fish) => sum + fish.weight, 0);
  return weights.map(fish => ({ ...fish, probability: fish.weight / total }));
}
/** Server-private seed only. Draw indices share a stable stream across routes/cancellation.
 * The avalanche prevents adjacent draw indices from producing correlated fish.
 * Pending species must stay private until claim: specialized gear has no linear rank.
 */
export function selectFishingCatch(serverSeed: string, rodId: string, baitId: string | null, catalog?: EconomyFishingCatalog, hookId = "bare_hook", drawIndex = 0): string {
  const weights = fishingWeights(rodId, baitId, catalog, hookId);
  let hash = 2166136261;
  for (const character of `${serverSeed}:${drawIndex}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  hash = Math.imul(hash ^ hash >>> 16, 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ hash >>> 13, 0xc2b2ae35) >>> 0;
  hash = (hash ^ hash >>> 16) >>> 0;
  let roll = Math.floor(hash * weights.reduce((sum, fish) => sum + fish.weight, 0) / 4294967296);
  for (const fish of weights) { if (roll < fish.weight) return fish.itemId; roll -= fish.weight; }
  return weights[weights.length - 1].itemId;
}
