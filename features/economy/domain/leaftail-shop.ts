import { economyCatalog, type EconomyCatalog, type EconomyLeaftailShop, type EconomyState } from "./model";

type ShopState = Pick<EconomyState, "buildings" | "leaftailShop"> & Partial<Pick<EconomyState, "fishing" | "wardrobe">> & { ownerPublicId?: string };

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

/** One or two personal finds accompany each delivery. Other departments keep
 * their ordinary assortment. Without a confirmed owner no finding is quoted. */
export function leaftailShopOffers(catalog: EconomyCatalog, cycle: number, ownerPublicId?: string) {
  const spec = catalog.leaftailShop;
  const offers = [...(spec?.offers ?? []), ...(spec?.travelOffers ?? [])];
  const specialItems = new Set(catalog.items.filter(item => item.category === "special").map(item => item.id));
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
    offers: leaftailShopOffers(catalog, stock.cycle, state.ownerPublicId).map(offer => {
      const kind = offer.kind ?? "item";
      const gear = kind === "rod" ? catalog.fishing?.rods.find(item => item.id === offer.itemId)
        : kind === "hook" ? catalog.fishing?.hooks.find(item => item.id === offer.itemId)
        : kind === "bait" ? catalog.fishing?.baits.find(item => item.itemId === offer.itemId) : undefined;
      const requiredHomeLevel = Math.max(spec.requiredHomeLevel, offer.requiredHomeLevel ?? 1, gear?.requiredHomeLevel ?? 1);
      const owned = kind === "wardrobe" ? Boolean(state.wardrobe?.includes(offer.itemId))
        : kind === "rod" ? Boolean(state.fishing?.ownedRods.includes(offer.itemId))
        : kind === "hook" ? Boolean(state.fishing?.ownedHooks.includes(offer.itemId)) : false;
      return { ...offer, kind, targetId: `${stock.cycle}:${offer.id}`, quantity: offer.quantity ?? 1,
        requiredHomeLevel, unlocked: (state.buildings.home ?? 1) >= requiredHomeLevel, owned,
        section: kind === "wardrobe" ? "wardrobe" as const : kind !== "item" ? "tackle" as const
          : catalog.items.find(item => item.id === offer.itemId)?.category === "special" ? "finds" as const : "supplies" as const,
        remaining: Math.max(0, offer.stock - (stock.purchased[offer.id] ?? 0)) };
    }) };
}
