import { economyCatalog, type EconomyCatalog, type EconomyState } from "./model";

type ExchangeState = Pick<EconomyState, "buildings" | "inventory" | "wallet">;
/** Only actual rare-clock relics can be converted. Clothing, coins and future
 * unrelated special items must not silently become an exchange currency. */
export function leaftailRelicExchangeItems(catalog: EconomyCatalog = economyCatalog): string[] {
  return (catalog.rareDrops?.itemIds ?? []).filter(id => catalog.items.some(item => item.id === id && item.category === "special" && !item.tradable));
}

export function leaftailRelicExchangeOffer(state: ExchangeState, fromItemId: string, toItemId: string,
  catalog: EconomyCatalog = economyCatalog) {
  const shop = catalog.leaftailShop, config = shop?.relicExchange, items = leaftailRelicExchangeItems(catalog);
  if (!shop || !config || fromItemId === toItemId || !items.includes(fromItemId) || !items.includes(toItemId)) return null;
  const requiredHomeLevel = Math.max(shop.requiredHomeLevel, config.requiredHomeLevel);
  const availableQuantity = state.inventory[fromItemId] ?? 0;
  return { targetId: `${fromItemId}:${toItemId}`, fromItemId, toItemId, quantity: config.quantity,
    priceCoins: config.priceCoins, requiredHomeLevel, availableQuantity,
    unlocked: (state.buildings.home ?? 1) >= requiredHomeLevel,
    canAfford: availableQuantity >= config.quantity && state.wallet.coins >= config.priceCoins };
}
