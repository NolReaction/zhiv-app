import { ECONOMY_MAX_ITEMS, economyCatalog, economyFishingSchema, type EconomyCost, type EconomyFishing, type EconomyFishingCatalog } from "./model";

export type FishingClass = EconomyFishingCatalog["classes"][number];
/** Inventory is grouped by rarity; species ids remain the permanent catch book. */
export function fishClassForItem(itemId: string, catalog = economyCatalog.fishing!): FishingClass | undefined {
  return catalog.classes.find(group => group.itemId === itemId)
    ?? catalog.classes.find(group => group.rarity === catalog.fish.find(fish => fish.itemId === itemId)?.rarity);
}
export function fishingClassItemId(itemId: string, catalog = economyCatalog.fishing!): string {
  return fishClassForItem(itemId, catalog)?.itemId ?? itemId;
}
/** Also accepts old job deliveries, refunds and trade escrow without inventing catches. */
export function fishClassInventory(inventory: Record<string, number>, catalog = economyCatalog.fishing!): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [id, quantity] of Object.entries(inventory)) {
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError("Fish inventory requires nonnegative integer quantities");
    const itemId = fishingClassItemId(id, catalog), total = (result[itemId] ?? 0) + quantity;
    if (!Number.isSafeInteger(total) || total < 0 || total > ECONOMY_MAX_ITEMS) throw new RangeError("Fish inventory exceeds item capacity");
    result[itemId] = total;
  }
  return result;
}
export const normalizeFishingInventory = fishClassInventory;
/** Defaults keep existing persisted profiles and older snapshots readable. */
export function fishingState(state: { fishing?: EconomyFishing }): EconomyFishing {
  if (!state.fishing) return economyFishingSchema.parse(undefined);
  return { ...state.fishing, ownedHooks: state.fishing.ownedHooks ?? ["bare_hook"], equippedHookId: state.fishing.equippedHookId ?? "bare_hook" };
}
export function fishingTripCost(cost: EconomyCost, state: { fishing?: EconomyFishing }): EconomyCost {
  const baitId = fishingState(state).equippedBaitId;
  return { coins: cost.coins, items: { ...cost.items, ...(baitId ? { [baitId]: (cost.items[baitId] ?? 0) + 1 } : {}) } };
}
/** Every delivered fish gets a real class draw, then a collection species draw. */
export function fishingCollectionDraws(routeId: string, catalog = economyCatalog.fishing!): number {
  return catalog.collectionDrawsByRoute?.[routeId] ?? 1;
}
export function fishingIneligibility(fish: EconomyFishingCatalog["fish"][number], rodId: string, _hookId: string,
  catalog = economyCatalog.fishing!): "legendary_tackle" | "rod_class" | null {
  const rod = catalog.rods.find(rod => rod.id === rodId);
  if (fish.rarity === "legendary" && rod?.rarity !== "legendary") return "legendary_tackle";
  return rod?.classOddsBps?.[fish.rarity] === 0 ? "rod_class" : null;
}
/** Bait may improve an available class, but cannot unlock an impossible one. */
export function fishingBaitCompatible(rodId: string, baitId: string | null, catalog = economyCatalog.fishing!): boolean {
  if (baitId === null) return true;
  const rod = catalog.rods.find(item => item.id === rodId), bait = catalog.baits.find(item => item.itemId === baitId);
  if (!rod || !bait) return false;
  return fishingClassWeights(rodId, null, catalog).some(group => group.rarity === bait.rarity && group.weight > 0);
}
/** Rods set direct class odds. Hooks and bait multiply those tickets; zero stays
 * impossible. Species count and old species/hook metadata never change classes. */
export function fishingClassWeights(rodId: string, baitId: string | null, catalog = economyCatalog.fishing!, hookId = "bare_hook") {
  const rod = catalog.rods.find(rod => rod.id === rodId), hook = catalog.hooks.find(hook => hook.id === hookId),
    bait = catalog.baits.find(bait => bait.itemId === baitId);
  return catalog.classes.map(group => {
    const eligible = catalog.fish.some(fish => fish.rarity === group.rarity && !fishingIneligibility(fish, rodId, hookId, catalog));
    const multiplier = (hook?.rarityWeights?.[group.rarity] ?? 100) * (bait?.rarityWeights?.[group.rarity] ?? 100);
    const weight = rod?.classOddsBps
      ? Math.floor(rod.classOddsBps[group.rarity] * multiplier / 10_000)
      // Read older catalog snapshots without changing their authored rod weights.
      : Math.max(1, Math.floor(group.weight * (rod?.rarityWeights?.[group.rarity] ?? 100) * multiplier / 1_000_000));
    return { rarity: group.rarity, itemId: group.itemId, weight: eligible ? weight : 0 };
  });
}
/** Positive integer tickets are normalised only among species of the drawn class.
 * No bait/class multiplier enters this second draw; older gear remains uniform. */
export function fishingSpeciesWeights(rodId: string, rarity: FishingClass["rarity"], catalog = economyCatalog.fishing!, hookId = "bare_hook") {
  const rod = catalog.rods.find(item => item.id === rodId), hook = catalog.hooks.find(item => item.id === hookId);
  return catalog.fish.filter(fish => fish.rarity === rarity && !fishingIneligibility(fish, rodId, hookId, catalog))
    .map(fish => ({ itemId: fish.itemId, weight: (rod?.speciesWeights?.[fish.itemId] ?? 100) * (hook?.speciesWeights?.[fish.itemId] ?? 100) }));
}
/** Per-species display; class tickets remain exactly the economic draw above. */
export function fishingWeights(rodId: string, baitId: string | null, catalog = economyCatalog.fishing!, hookId = "bare_hook"): { itemId: string; weight: number }[] {
  const classes = fishingClassWeights(rodId, baitId, catalog, hookId);
  const weights = new Map(classes.map(group => [group.rarity, fishingSpeciesWeights(rodId, group.rarity, catalog, hookId)]));
  return catalog.fish.map(fish => {
    const species = weights.get(fish.rarity)!, total = species.reduce((sum, row) => sum + row.weight, 0);
    return { itemId: fish.itemId, weight: total ? (classes.find(group => group.rarity === fish.rarity)?.weight ?? 0)
      * (species.find(row => row.itemId === fish.itemId)?.weight ?? 0) / total : 0 };
  });
}
type FishingOverrides = { rodId?: string; hookId?: string; baitId?: string | null };
export function fishingClassOdds(state: { fishing?: EconomyFishing }, catalog = economyCatalog.fishing!, override: FishingOverrides = {}) {
  const current = fishingState(state);
  const weights = fishingClassWeights(override.rodId ?? current.equippedRodId,
    override.baitId === undefined ? current.equippedBaitId : override.baitId, catalog, override.hookId ?? current.equippedHookId);
  const total = weights.reduce((sum, group) => sum + group.weight, 0);
  return weights.map(group => ({ ...group, probability: total ? group.weight / total : 0 }));
}
export function fishingOdds(state: { fishing?: EconomyFishing }, catalog = economyCatalog.fishing!, override: FishingOverrides = {}) {
  const current = fishingState(state);
  const weights = fishingWeights(override.rodId ?? current.equippedRodId,
    override.baitId === undefined ? current.equippedBaitId : override.baitId, catalog, override.hookId ?? current.equippedHookId);
  const total = weights.reduce((sum, fish) => sum + fish.weight, 0);
  return weights.map(fish => ({ ...fish, probability: total ? fish.weight / total : 0 }));
}
function fishingDrawHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  hash = Math.imul(hash ^ hash >>> 16, 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ hash >>> 13, 0xc2b2ae35) >>> 0;
  return (hash ^ hash >>> 16) >>> 0;
}
/** Private seed survives cancellation. Class and species use independent hash domains,
 * so adding species never changes class draws or correlates a species with class odds. */
export function selectFishingCatch(serverSeed: string, rodId: string, baitId: string | null, catalog = economyCatalog.fishing!, hookId = "bare_hook", drawIndex = 0): string {
  const weights = fishingClassWeights(rodId, baitId, catalog, hookId);
  const total = weights.reduce((sum, group) => sum + group.weight, 0);
  if (!total) throw new RangeError("Fishing loadout has no eligible classes");
  let roll = Math.floor(fishingDrawHash(`${serverSeed}:${drawIndex}:class`) * total / 4294967296);
  for (const group of weights) {
    if (roll < group.weight) {
      const species = fishingSpeciesWeights(rodId, group.rarity, catalog, hookId);
      const speciesTotal = species.reduce((sum, fish) => sum + fish.weight, 0);
      // Exact for every schema-valid weight, including catalogs above JS's safe product range.
      let speciesRoll = Number(BigInt(fishingDrawHash(`${serverSeed}:${drawIndex}:species`)) * BigInt(speciesTotal) / BigInt(4294967296));
      for (const fish of species) {
        if (speciesRoll < fish.weight) return fish.itemId;
        speciesRoll -= fish.weight;
      }
      throw new RangeError("Invalid fishing species draw");
    }
    roll -= group.weight;
  }
  throw new RangeError("Invalid fishing class draw");
}
