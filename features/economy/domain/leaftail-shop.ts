import { economyCatalog, type EconomyCatalog, type EconomyLeaftailShop, type EconomyState } from "./model";
import { tradePurchaseUnitPrice } from "./trade-pricing";

type ShopState = Pick<EconomyState, "buildings" | "leaftailShop"> & Partial<Pick<EconomyState, "fishing" | "wardrobe" | "tradeRelations">> & { ownerPublicId?: string };

export const leaftailTravelMessage = (requiredHomeLevel: number) =>
  `Листохвост в путешествии. Вернётся, когда дом достигнет ${requiredHomeLevel}-го уровня.`;

/** Account stock uses the server day. Opening or reopening a window never rerolls it. */
export function leaftailShopStock(state: Pick<EconomyState, "leaftailShop">, now: number,
  catalog: EconomyCatalog = economyCatalog): EconomyLeaftailShop {
  const cycle = Math.floor(now / ((catalog.leaftailShop?.refreshSeconds ?? 86400) * 1000));
  const saved = state.leaftailShop;
  // A clock moving backwards must not reopen a consumed delivery.
  return saved && saved.cycle >= cycle ? { cycle: saved.cycle, purchased: { ...saved.purchased } } : { cycle, purchased: {} };
}

/** Public, deterministic stock selection; matching Kotlin uses the same unsigned
 * 32-bit arithmetic. The identity comes from the authenticated snapshot/command,
 * never from a refresh ticket, request ID or a client-selected random seed. */
function deliveryHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

export type LeaftailOffer = {
  id: string; itemId: string; kind: "item" | "wardrobe" | "rod" | "hook" | "bait";
  currency: "coins" | "pearls"; unitPrice: number; priceCoins: number; pricePearls: number;
  /** Actual inventory items per purchased unit. Only old catalogs retain bundles. */
  quantity: number; stock: number; requiredHomeLevel: number;
};
export const leaftailShopUsesUnits = (catalog: EconomyCatalog) =>
  Boolean(catalog.leaftailShop?.supplyOffers?.length || catalog.leaftailShop?.pearlOffers?.length);
export const leaftailOfferTarget = (catalog: EconomyCatalog, cycle: number, offerId: string) =>
  `${leaftailShopUsesUnits(catalog) ? "v2:" : ""}${cycle}:${offerId}`;

function requiredHome(catalog: EconomyCatalog, offer: Pick<LeaftailOffer, "kind" | "itemId" | "requiredHomeLevel">) {
  const gear = offer.kind === "rod" ? catalog.fishing?.rods.find(item => item.id === offer.itemId)
    : offer.kind === "hook" ? catalog.fishing?.hooks.find(item => item.id === offer.itemId)
      : offer.kind === "bait" ? catalog.fishing?.baits.find(item => item.itemId === offer.itemId) : undefined;
  return Math.max(catalog.leaftailShop?.requiredHomeLevel ?? 1, offer.requiredHomeLevel, gear?.requiredHomeLevel ?? 1);
}

/** Stock is a personal ring, shifted by its department size each day. Reopening,
 * buying and permanent ownership never reroll the remaining delivery. */
export function leaftailShopOffers(catalog: EconomyCatalog, cycle: number, ownerPublicId?: string, homeLevel = 5): LeaftailOffer[] {
  const spec = catalog.leaftailShop;
  if (!spec) return [];
  const unitSales = leaftailShopUsesUnits(catalog);
  const legacy = [...(spec.supplyOffers?.length ? [] : spec.offers), ...(spec.travelOffers ?? [])];
  const offers: LeaftailOffer[] = [
    ...legacy.map(offer => ({ ...offer, kind: offer.kind ?? "item", currency: "coins" as const,
      unitPrice: unitSales ? offer.priceCoins / (offer.quantity ?? 1) : offer.priceCoins,
      priceCoins: unitSales ? offer.priceCoins / (offer.quantity ?? 1) : offer.priceCoins, pricePearls: 0,
      quantity: unitSales ? 1 : (offer.quantity ?? 1), stock: unitSales ? offer.stock * (offer.quantity ?? 1) : offer.stock })),
    ...(spec.supplyOffers ?? []).map(offer => ({ ...offer, kind: "item" as const, currency: "coins" as const,
      unitPrice: offer.unitPriceCoins, priceCoins: offer.unitPriceCoins, pricePearls: 0, quantity: 1 })),
    ...(spec.pearlOffers ?? []).map(offer => ({ ...offer, kind: "item" as const, currency: "pearls" as const,
      unitPrice: offer.pricePearls, priceCoins: 0, quantity: 1 })),
  ];
  const specialItems = new Set(catalog.items.filter(item => item.category === "special").map(item => item.id));
  if (unitSales) {
    if (!ownerPublicId) return [];
    const eligible = offers.filter(offer => requiredHome(catalog, offer) <= homeLevel);
    const section = (offer: LeaftailOffer) => offer.kind !== "item" ? offer.kind : specialItems.has(offer.itemId) ? "finds" : "supplies";
    const counts = { wardrobe: 2, rod: 1, hook: 1, bait: 1, supplies: 3,
      finds: 1 + deliveryHash(`leaftail-stock-v2:${ownerPublicId}:${cycle}:finds-count`) % 2 };
    const selected = new Set<string>();
    for (const [group, amount] of Object.entries(counts)) {
      const key = `leaftail-stock-v2:${ownerPublicId}:${group}`;
      const ring = eligible.filter(offer => section(offer) === group)
        .map(offer => ({ id: offer.id, score: deliveryHash(`${key}:${offer.id}`) }))
        .sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (!ring.length) continue;
      const stride = group === "finds" ? 1 : amount;
      // Take the remainder first: even the largest valid saved cycle stays exact.
      const offset = (((cycle % ring.length) + ring.length) % ring.length * stride) % ring.length;
      for (let index = 0; index < Math.min(amount, ring.length); index++) selected.add(ring[(offset + index) % ring.length].id);
    }
    return eligible.filter(offer => selected.has(offer.id));
  }
  // Old cached snapshots keep their accepted whole-bundle quote and find hash.
  const finds = offers.filter(offer => (offer.kind ?? "item") === "item" && specialItems.has(offer.itemId));
  const key = `leaftail-find-v1:${ownerPublicId ?? ""}:${cycle}`;
  const chosen = new Set(ownerPublicId ? finds.map(offer => ({ id: offer.id, score: deliveryHash(`${key}:${offer.id}`) }))
    .sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 1 + deliveryHash(`${key}:count`) % 2).map(offer => offer.id) : []);
  return offers.filter(offer => (offer.kind ?? "item") !== "item" || !specialItems.has(offer.itemId) || chosen.has(offer.id));
}

export function leaftailShopView(state: ShopState, now: number, catalog: EconomyCatalog = economyCatalog) {
  const spec = catalog.leaftailShop;
  if (!spec) return null;
  const stock = leaftailShopStock(state, now, catalog);
  return { cycle: stock.cycle, refreshAt: (stock.cycle + 1) * spec.refreshSeconds * 1000,
    requiredHomeLevel: spec.requiredHomeLevel, unlocked: (state.buildings.home ?? 1) >= spec.requiredHomeLevel,
    offers: leaftailShopOffers(catalog, stock.cycle, state.ownerPublicId, state.buildings.home ?? 1).map(offer => {
      const kind = offer.kind ?? "item";
      const requiredHomeLevel = requiredHome(catalog, offer);
      const owned = kind === "wardrobe" ? Boolean(state.wardrobe?.includes(offer.itemId))
        : kind === "rod" ? Boolean(state.fishing?.ownedRods.includes(offer.itemId))
        : kind === "hook" ? Boolean(state.fishing?.ownedHooks.includes(offer.itemId)) : false;
      const unitPrice = tradePurchaseUnitPrice(state, "leaftail", kind, offer.unitPrice, offer.currency, catalog);
      return { ...offer, baseUnitPrice: offer.unitPrice, unitPrice,
        priceCoins: offer.currency === "coins" ? unitPrice : 0,
        pricePearls: offer.currency === "pearls" ? unitPrice : 0,
        kind, targetId: leaftailOfferTarget(catalog, stock.cycle, offer.id),
        requiredHomeLevel, unlocked: (state.buildings.home ?? 1) >= requiredHomeLevel, owned,
        section: kind === "wardrobe" ? "wardrobe" as const : kind !== "item" ? "tackle" as const
          : catalog.items.find(item => item.id === offer.itemId)?.category === "special" ? "finds" as const : "supplies" as const,
        remaining: Math.max(0, offer.stock - (stock.purchased[offer.id] ?? 0)) };
    }) };
}
