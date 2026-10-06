import { economyCatalog, type EconomyFishingShop, type EconomyState } from "./model";
import { fishingState } from "./fishing";
import { secureRareInteger, type RareRandomInteger } from "./rare-drops";

// Keep integer selection and replacement eligibility identical to EconomyFishingShop.kt.
// Draws happen only on the authenticated server; a persisted receipt owns the result.
const rarities = ["common", "uncommon", "rare", "epic", "legendary"] as const;
type Rarity = typeof rarities[number];
const rarityWeight: Record<Rarity, number> = { common: 100, uncommon: 60, rare: 25, epic: 10, legendary: 4 };
type ShopState = Pick<EconomyState, "buildings" | "fishing" | "fishingShop">;
type Candidate = Omit<EconomyFishingShop["offers"][number], "id"> & { rarity: Rarity; weight: number };
type Kind = Candidate["kind"];
const categories: Kind[] = ["rod", "hook", "bait", "fish"];
function candidates(state: ShopState): Candidate[] {
  const catalog = economyCatalog.fishing!;
  const home = state.buildings.home ?? 1, current = fishingState(state);
  return [
    ...catalog.rods.filter(item => item.price > 0 && item.requiredHomeLevel <= home && !current.ownedRods.includes(item.id))
      .map(item => ({ kind: "rod" as const, itemId: item.id, unitPrice: item.price, remaining: 1, rarity: item.rarity, weight: 1 })),
    ...catalog.hooks.filter(item => item.price > 0 && item.requiredHomeLevel <= home && !current.ownedHooks.includes(item.id))
      .map(item => ({ kind: "hook" as const, itemId: item.id, unitPrice: item.price, remaining: 1, rarity: item.rarity, weight: 1 })),
    ...catalog.baits.filter(item => item.requiredHomeLevel <= home)
      .map(item => ({ kind: "bait" as const, itemId: item.itemId, unitPrice: item.price, remaining: catalog.shop.baitStock,
        rarity: item.rarity, weight: rarityWeight[item.rarity] })),
    // Only common species are sold here. Recipes consume the river fish ID;
    // purchases of any species never unlock personal catches in the book.
    ...catalog.fish.filter(item => item.rarity === "common")
      .map(item => ({ kind: "fish" as const, itemId: item.itemId,
        unitPrice: Math.ceil(item.buyPrice * catalog.shop.fishPriceBps / 10000), remaining: catalog.shop.fishStock,
        rarity: item.rarity, weight: 1 })),
  ];
}
function trustedDraw(random: RareRandomInteger, total: number): number {
  const draw = random(total);
  if (!Number.isInteger(draw) || draw < 0 || draw >= total) throw new Error("Invalid trusted shop draw");
  return draw;
}
function take(pool: Candidate[], random: RareRandomInteger): Candidate | undefined {
  if (!pool.length) return undefined;
  let draw = trustedDraw(random, pool.reduce((sum, item) => sum + item.weight, 0));
  for (const item of pool) { draw -= item.weight; if (draw < 0) return item; }
}
function levelOdds(state: ShopState) {
  return economyCatalog.fishing!.shop.gearRarityBpsByHome[Math.max(0, Math.min(4, (state.buildings.home ?? 1) - 1))];
}
function takeGear(pool: Candidate[], state: ShopState, random: RareRandomInteger): Candidate | undefined {
  if (!pool.length) return undefined;
  const odds = levelOdds(state);
  let draw = trustedDraw(random, 10000), tier = 0;
  for (; tier < rarities.length - 1; tier++) {
    draw -= odds[rarities[tier]];
    if (draw < 0) break;
  }
  // Missing, owned and excluded models may downgrade the roll, NEVER upgrade it.
  // A sole remaining legendary still needs its own 20/50 tickets out of 10000.
  for (; tier >= 0; tier--) {
    const choices = pool.filter(item => item.rarity === rarities[tier]);
    if (choices.length) return take(choices, random);
  }
}
function stock(pool: Candidate[], state: ShopState, now: number, random: RareRandomInteger, shopId: string): EconomyFishingShop {
  const config = economyCatalog.fishing!.shop;
  const chosen = categories.flatMap(kind => {
    const options = pool.filter(item => item.kind === kind);
    const selected = kind === "rod" || kind === "hook" ? takeGear(options, state, random) : take(options, random);
    return selected ? [selected] : [];
  });
  return { id: shopId, openedAt: new Date(now).toISOString(), refreshAt: new Date(now + config.refreshSeconds * 1000).toISOString(),
    refreshPricePearls: config.refreshPricePearls,
    offers: chosen.map(item => ({ id: `${shopId}:${item.itemId}`, kind: item.kind, itemId: item.itemId, unitPrice: item.unitPrice, remaining: item.remaining })) };
}
export function createFishingShop(state: ShopState, now: number,
  random: RareRandomInteger = secureRareInteger, shopId = crypto.randomUUID()): EconomyFishingShop {
  return stock(candidates(state), state, now, random, shopId);
}
function replacementPool(state: ShopState) {
  const previous = new Set(state.fishingShop?.offers.map(offer => offer.itemId));
  // Sold-out entries count too: paying cannot merely restock the same item.
  return candidates(state).filter(item => !previous.has(item.itemId));
}
export function canRefreshFishingShop(state: ShopState): boolean {
  const previous = state.fishingShop?.offers;
  if (!previous?.length) return false;
  const pool = replacementPool(state), odds = levelOdds(state);
  const lowestTier = rarities.findIndex(rarity => odds[rarity] > 0);
  // Before charging, guarantee a different item for every previous category.
  // A small catalogue can legitimately disable refresh; it cannot inflate rare odds
  // or charge the player for losing a gear slot. Natural restock remains free.
  return categories.filter(kind => kind === "bait" || kind === "fish" || previous.some(item => item.kind === kind))
    .every(kind => pool.some(item => item.kind === kind
      && (kind !== "rod" && kind !== "hook" || rarities.indexOf(item.rarity) <= lowestTier)));
}
export function refreshFishingShop(state: ShopState, now: number,
  random: RareRandomInteger = secureRareInteger, shopId = crypto.randomUUID()): EconomyFishingShop | null {
  if (!canRefreshFishingShop(state)) return null;
  return stock(replacementPool(state), state, now, random, shopId);
}
export function fishingShopExpired(shop: EconomyFishingShop | null | undefined, now: number): boolean {
  return !shop || now >= Date.parse(shop.refreshAt);
}
