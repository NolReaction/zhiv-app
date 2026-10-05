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
/** Display odds and the server selector use exactly the same integer weights. */
export function fishingWeights(rodId: string, baitId: string | null, catalog = economyCatalog.fishing!, hookId = "bare_hook"): { itemId: string; weight: number }[] {
  const bonus = (catalog.rods.find(rod => rod.id === rodId)?.rareBonus ?? 0)
    + (catalog.hooks?.find(hook => hook.id === hookId)?.rareBonus ?? 0)
    + (catalog.baits.find(bait => bait.itemId === baitId)?.rareBonus ?? 0);
  return catalog.fish.map(fish => ({ itemId: fish.itemId, weight: fish.weight + fish.affinity * bonus }));
}
export function fishingOdds(state: { fishing?: EconomyFishing }, catalog = economyCatalog.fishing!,
  override: { rodId?: string; hookId?: string; baitId?: string | null } = {}) {
  const current = fishingState(state);
  const weights = fishingWeights(override.rodId ?? current.equippedRodId,
    override.baitId === undefined ? current.equippedBaitId : override.baitId, catalog, override.hookId ?? current.equippedHookId);
  const total = weights.reduce((sum, fish) => sum + fish.weight, 0);
  return weights.map(fish => ({ ...fish, probability: fish.weight / total }));
}
/** The input must be a SERVER-generated UUID, never the client request ID. FNV-1a matches Kotlin. */
export function selectFishingCatch(serverSeed: string, rodId: string, baitId: string | null, catalog?: EconomyFishingCatalog, hookId = "bare_hook"): string {
  const weights = fishingWeights(rodId, baitId, catalog, hookId);
  let hash = 2166136261;
  for (const character of serverSeed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  // A shared quantile makes stronger tackle monotonic; modulo would reroll on every equipment change.
  let roll = Math.floor(hash * weights.reduce((sum, fish) => sum + fish.weight, 0) / 4294967296);
  for (const fish of weights) { if (roll < fish.weight) return fish.itemId; roll -= fish.weight; }
  return weights[weights.length - 1].itemId;
}
