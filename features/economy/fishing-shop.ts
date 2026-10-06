import { economyCatalog, type EconomyFishingShop, type EconomyState } from "./model";
import { fishingState } from "./fishing";
import { secureRareInteger, type RareRandomInteger } from "./rare-drops";

// Keep selection and replacement eligibility identical to EconomyFishingShop.kt.
// Stock is drawn only on the authenticated server and then persisted with its receipt.
const rarityWeight: Record<string, number> = { common: 100, uncommon: 60, rare: 25, epic: 10, legendary: 4 };
type ShopState = Pick<EconomyState, "buildings" | "fishing" | "fishingShop">;
type Candidate = Omit<EconomyFishingShop["offers"][number], "id"> & { weight: number };
function candidates(state: ShopState): Candidate[] {
  const catalog = economyCatalog.fishing!;
  const home = state.buildings.home ?? 1, current = fishingState(state);
  return [
    ...catalog.rods.filter(item => item.price > 0 && item.requiredHomeLevel <= home && !current.ownedRods.includes(item.id))
      .map(item => ({ kind: "rod" as const, itemId: item.id, unitPrice: item.price, remaining: 1, weight: rarityWeight[item.rarity] })),
    ...catalog.hooks.filter(item => item.price > 0 && item.requiredHomeLevel <= home && !current.ownedHooks.includes(item.id))
      .map(item => ({ kind: "hook" as const, itemId: item.id, unitPrice: item.price, remaining: 1, weight: rarityWeight[item.rarity] })),
    ...catalog.baits.filter(item => item.requiredHomeLevel <= home)
      .map(item => ({ kind: "bait" as const, itemId: item.itemId, unitPrice: item.price, remaining: catalog.shop.baitStock, weight: rarityWeight[item.rarity] })),
  ];
}
function take(pool: Candidate[], chosen: Candidate[], random: RareRandomInteger) {
  if (!pool.length) return;
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  let draw = random(total);
  if (!Number.isInteger(draw) || draw < 0 || draw >= total) throw new Error("Invalid trusted shop draw");
  for (let index = 0; index < pool.length; index++) {
    draw -= pool[index].weight;
    if (draw < 0) { chosen.push(...pool.splice(index, 1)); return; }
  }
}
function stock(chosen: Candidate[], now: number, shopId: string): EconomyFishingShop {
  const config = economyCatalog.fishing!.shop;
  return { id: shopId, openedAt: new Date(now).toISOString(), refreshAt: new Date(now + config.refreshSeconds * 1000).toISOString(),
    refreshPricePearls: config.refreshPricePearls,
    offers: chosen.map(item => ({ id: `${shopId}:${item.itemId}`, kind: item.kind, itemId: item.itemId, unitPrice: item.unitPrice, remaining: item.remaining })) };
}
export function createFishingShop(state: ShopState, now: number,
  random: RareRandomInteger = secureRareInteger, shopId = crypto.randomUUID()): EconomyFishingShop {
  const pool = candidates(state), config = economyCatalog.fishing!.shop;
  const rods = pool.filter(item => item.kind === "rod"), hooks = pool.filter(item => item.kind === "hook"), baits = pool.filter(item => item.kind === "bait");
  const chosen: Candidate[] = [];
  take(rods, chosen, random); take(hooks, chosen, random); take(baits, chosen, random); take(baits, chosen, random);
  // Owning all permanent tackle frees its slots for the remaining bait varieties.
  while (chosen.length < config.slots && baits.length) take(baits, chosen, random);
  return stock(chosen, now, shopId);
}
function replacementPool(state: ShopState) {
  const previous = new Set(state.fishingShop?.offers.map(offer => offer.itemId));
  // Sold-out entries count too: paying cannot merely restock the same item.
  return candidates(state).filter(item => !previous.has(item.itemId));
}
function replacementSize(state: ShopState): number {
  return Math.min(state.fishingShop?.offers.length ?? 0, economyCatalog.fishing!.shop.slots);
}
export function canRefreshFishingShop(state: ShopState): boolean {
  const size = replacementSize(state);
  // Keep a genuine weighted choice, rather than selling the entire residual pool
  // (which would guarantee its rarest tackle regardless of its rarity weight).
  // There must also be a possible counter with no legendary item at all.
  const pool = replacementPool(state);
  return size > 0 && pool.length > size && pool.filter(item => item.weight !== rarityWeight.legendary).length >= size;
}
export function refreshFishingShop(state: ShopState, now: number,
  random: RareRandomInteger = secureRareInteger, shopId = crypto.randomUUID()): EconomyFishingShop | null {
  const pool = replacementPool(state), size = replacementSize(state);
  if (size === 0 || pool.length <= size || pool.filter(item => item.weight !== rarityWeight.legendary).length < size) return null;
  const chosen: Candidate[] = [];
  // A paid replacement has no compulsory rod/hook slot: otherwise excluding
  // yesterday's rod could guarantee the sole remaining legendary rod.
  while (chosen.length < size) take(pool, chosen, random);
  return stock(chosen, now, shopId);
}
export function fishingShopExpired(shop: EconomyFishingShop | null | undefined, now: number): boolean {
  return !shop || now >= Date.parse(shop.refreshAt);
}
