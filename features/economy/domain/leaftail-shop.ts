import { economyCatalog, type EconomyCatalog, type EconomyLeaftailShop, type EconomyState } from "./model";

type ShopState = Pick<EconomyState, "buildings" | "leaftailShop">;

/** Account stock uses the server day. Opening or reopening a window never rerolls it. */
export function leaftailShopStock(state: Pick<EconomyState, "leaftailShop">, now: number,
  catalog: EconomyCatalog = economyCatalog): EconomyLeaftailShop {
  const cycle = Math.floor(now / ((catalog.leaftailShop?.refreshSeconds ?? 86400) * 1000));
  const saved = state.leaftailShop;
  // A clock moving backwards must not reopen a consumed delivery.
  return saved && saved.cycle >= cycle ? { cycle: saved.cycle, purchased: { ...saved.purchased } } : { cycle, purchased: {} };
}

export function leaftailShopView(state: ShopState, now: number, catalog: EconomyCatalog = economyCatalog) {
  const spec = catalog.leaftailShop;
  if (!spec) return null;
  const stock = leaftailShopStock(state, now, catalog);
  return { cycle: stock.cycle, refreshAt: (stock.cycle + 1) * spec.refreshSeconds * 1000,
    requiredHomeLevel: spec.requiredHomeLevel, unlocked: (state.buildings.home ?? 1) >= spec.requiredHomeLevel,
    offers: spec.offers.map(offer => ({ ...offer, targetId: `${stock.cycle}:${offer.id}`,
      quantity: offer.quantity ?? 1,
      section: catalog.items.find(item => item.id === offer.itemId)?.category === "special" ? "finds" as const : "supplies" as const,
      remaining: Math.max(0, offer.stock - (stock.purchased[offer.id] ?? 0)) })) };
}
