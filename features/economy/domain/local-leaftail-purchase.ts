import type { EconomyCommand, EconomyResult, EconomyView } from "./model";

export type LocalLeaftailPurchase = Readonly<{
  id: string; ownerPublicId: string; revision: number; coins: number;
  items: readonly Readonly<{ itemId: string; name: string; quantity: number }>[];
}>;

/** Freeze the exact local purchase, rather than rebuilding its receipt from a
 * later delivery, catalog or wallet. A replay needs the original before state. */
export function localLeaftailPurchaseFromReceipt(before: EconomyView | null, result: EconomyResult,
  command: EconomyCommand): LocalLeaftailPurchase | null {
  const after = result.state;
  if (command.action !== "buy_leaftail_item" || command.quantity !== 1 || !before
    || before.ownerPublicId !== after.ownerPublicId || command.ownerPublicId !== after.ownerPublicId
    || command.expectedRevision !== before.revision || result.acceptedRevision !== before.revision + 1
    || after.revision !== result.acceptedRevision) return null;
  const coins = before.wallet.coins - after.wallet.coins;
  if (![before.wallet.coins, after.wallet.coins, coins].every(value => Number.isSafeInteger(value) && value >= 0)
    || coins <= 0 || coins !== command.totalPrice) return null;
  const stock = after.leaftailShop;
  const offerId = stock && command.targetId.startsWith(`${stock.cycle}:`) ? command.targetId.slice(`${stock.cycle}:`.length) : null;
  const previousPurchased = before.leaftailShop?.cycle === stock?.cycle ? before.leaftailShop.purchased[offerId ?? ""] ?? 0 : 0;
  if (!offerId || !Number.isSafeInteger(previousPurchased) || previousPurchased < 0
    || stock.purchased[offerId] !== previousPurchased + 1) return null;
  const items = Object.entries(after.inventory).flatMap(([itemId, quantity]) => {
    const previous = before.inventory[itemId] ?? 0;
    if (![previous, quantity].every(value => Number.isSafeInteger(value) && value >= 0) || quantity <= previous) return [];
    const item = after.catalog.items.find(item => item.id === itemId);
    return item ? [Object.freeze({ itemId, name: item.name, quantity: quantity - previous })] : [];
  });
  if (!items.length) return null;
  return Object.freeze({ id: command.requestId, ownerPublicId: after.ownerPublicId, revision: result.acceptedRevision,
    coins, items: Object.freeze(items) });
}
