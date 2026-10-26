import { economyCatalog, type EconomyCatalog } from "@/features/economy/domain/model";
import { neighborDefaultSettings, type NeighborView } from "@/features/economy/domain/neighbor-model";
import { neighborBuyPriceCeiling } from "@/features/economy/domain/neighbor-rules";
import { marketMinimumPrice } from "@/features/economy/domain/market-rules";

/** The default composer uses a valid lot size even for one-coin bait. */
export function suggestedMarketListing(itemId: string, available: number, catalog: EconomyCatalog = economyCatalog) {
  const item = catalog.items.find(entry => entry.id === itemId), quantum = catalog.currencyScale;
  if (!item || item.baseSellPrice <= 0) return { quantity: 1, price: 0, minimumQuantity: 1 };
  const first = Math.max(1, Math.ceil(quantum / (item.baseSellPrice * catalog.market.maxPriceMultiplier)));
  const cap = (quantity: number) => neighborBuyPriceCeiling(itemId, quantity, neighborDefaultSettings, catalog);
  let minimumQuantity = first;
  if (neighborDefaultSettings.allowedItemIds.includes(itemId)) {
    for (let quantity = first; quantity <= catalog.market.maxLotQuantity; quantity++) {
      if (cap(quantity) >= Math.ceil(marketMinimumPrice(itemId, quantity, catalog) / quantum) * quantum) {
        minimumQuantity = quantity; break;
      }
    }
  }
  const quantity = Math.max(1, Math.min(minimumQuantity, available));
  const maximum = Math.floor(item.baseSellPrice * quantity * catalog.market.maxPriceMultiplier / quantum) * quantum;
  const preferred = Math.min(Math.ceil(item.baseSellPrice * quantity * 2 / quantum) * quantum, maximum);
  const minimum = Math.ceil(marketMinimumPrice(itemId, quantity, catalog) / quantum) * quantum;
  const neighborPrice = Math.min(preferred, cap(quantity));
  return { quantity, minimumQuantity, price: neighborDefaultSettings.allowedItemIds.includes(itemId) && neighborPrice >= minimum ? neighborPrice : preferred };
}

/** Display only authenticated, unexpired per-player terms; this is never a purchase promise. */
export function neighborListingGuidance(neighbor: NeighborView | null | undefined, ownerPublicId: string,
  itemId: string, quantity: number | null, totalPrice: number | null, now: number, catalog: EconomyCatalog = economyCatalog) {
  if (!neighbor || neighbor.ownerPublicId !== ownerPublicId || !quantity || !totalPrice) return null;
  const buying = neighbor.buying;
  if (buying.buyPriceBps == null || !buying.allowedItemIds || !buying.boughtItemIds || buying.firstSale == null
    || buying.globalRemainingCoins == null) return null;
  const name = neighbor.character.name;
  const remaining = Math.max(0, Math.min(buying.dailyBudgetCoins - buying.spentCoins, buying.globalRemainingCoins));
  const marketMaximum = marketMinimumPrice(itemId, quantity, catalog) * catalog.market.maxPriceMultiplier;
  const ceiling = Math.floor(Math.min(neighborBuyPriceCeiling(itemId, quantity, { buyPriceBps: buying.buyPriceBps }, catalog),
    buying.maxLotCoins, remaining, marketMaximum) / catalog.currencyScale) * catalog.currencyScale;
  let reason: string | null = null;
  if (now >= Date.parse(neighbor.shop.refreshAt)) reason = "Обновите условия соседа: начался новый день.";
  else if (!buying.enabled) reason = `${name} сейчас не выкупает лоты.`;
  else if (!buying.allowedItemIds.includes(itemId)) reason = `${name} не покупает этот товар.`;
  else if (buying.boughtItemIds.includes(itemId)) reason = "Этот товар сегодня куплен у соседа — обратный выкуп сегодня недоступен.";
  else if (buying.usedLots >= buying.maxLotsPerDay) reason = `${name} уже купил ваши ${buying.maxLotsPerDay} лота за сегодня.`;
  else if (remaining <= 0) reason = "Бюджет выкупа на сегодня закончился.";
  else if (ceiling < Math.ceil(marketMinimumPrice(itemId, quantity, catalog) / catalog.currencyScale) * catalog.currencyScale)
    reason = "Эта партия не подходит соседу по размеру или оставшемуся бюджету. Её могут купить игроки.";
  else if (totalPrice > ceiling) reason = `Для выкупа соседом снизьте цену до ${ceiling.toLocaleString("ru-RU")} монет или уменьшите партию.`;
  const seconds = buying.firstSale ? buying.firstDelaySeconds : buying.staleAfterSeconds;
  return { name, reason, ceiling, remaining, firstSale: buying.firstSale, seconds,
    eligible: reason === null, canAdjustPrice: reason !== null && totalPrice > ceiling
      && ceiling >= Math.ceil(marketMinimumPrice(itemId, quantity, catalog) / catalog.currencyScale) * catalog.currencyScale
      && buying.enabled && buying.allowedItemIds.includes(itemId) && !buying.boughtItemIds.includes(itemId)
      && buying.usedLots < buying.maxLotsPerDay && now < Date.parse(neighbor.shop.refreshAt) };
}
