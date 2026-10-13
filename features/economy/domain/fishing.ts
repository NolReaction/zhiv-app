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
export function fishingIneligibility(fish: EconomyFishingCatalog["fish"][number], rodId: string, hookId: string,
  catalog = economyCatalog.fishing!): "legendary_tackle" | "hook" | null {
  if (fish.rarity === "legendary" && (catalog.rods.find(rod => rod.id === rodId)?.rarity !== "legendary"
    || catalog.hooks.find(hook => hook.id === hookId)?.rarity !== "legendary")) return "legendary_tackle";
  return fish.requiredHookId && fish.requiredHookId !== hookId ? "hook" : null;
}
/** Integer class tickets are independent of how many species the book contains. */
export function fishingClassWeights(rodId: string, baitId: string | null, catalog = economyCatalog.fishing!, hookId = "bare_hook") {
  const rod = catalog.rods.find(rod => rod.id === rodId), hook = catalog.hooks.find(hook => hook.id === hookId),
    bait = catalog.baits.find(bait => bait.itemId === baitId);
  return catalog.classes.map(group => ({ rarity: group.rarity, itemId: group.itemId,
    weight: catalog.fish.some(fish => fish.rarity === group.rarity && !fishingIneligibility(fish, rodId, hookId, catalog))
      ? Math.max(1, Math.floor(group.weight * (rod?.rarityWeights?.[group.rarity] ?? 100)
        * (hook?.rarityWeights?.[group.rarity] ?? 100) * (bait?.rarityWeights?.[group.rarity] ?? 100) / 1_000_000)) : 0 }));
}
/** Per-species display only. Authoritative drawing always uses integer class tickets. */
export function fishingWeights(rodId: string, baitId: string | null, catalog = economyCatalog.fishing!, hookId = "bare_hook"): { itemId: string; weight: number }[] {
  const classes = fishingClassWeights(rodId, baitId, catalog, hookId);
  return catalog.fish.map(fish => ({ itemId: fish.itemId, weight: fishingIneligibility(fish, rodId, hookId, catalog) ? 0
    : (classes.find(group => group.rarity === fish.rarity)?.weight ?? 0) / catalog.fish.filter(species => species.rarity === fish.rarity
      && !fishingIneligibility(species, rodId, hookId, catalog)).length }));
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
      const species = catalog.fish.filter(fish => fish.rarity === group.rarity && !fishingIneligibility(fish, rodId, hookId, catalog));
      return species[Math.floor(fishingDrawHash(`${serverSeed}:${drawIndex}:species`) * species.length / 4294967296)].itemId;
    }
    roll -= group.weight;
  }
  throw new RangeError("Invalid fishing class draw");
}
