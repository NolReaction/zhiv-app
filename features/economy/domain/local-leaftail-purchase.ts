import { wardrobeItems } from "@/features/world/domain/wardrobe";
import type { EconomyCommand, EconomyResult, EconomyView } from "./model";
import { leaftailShopOffers } from "./leaftail-shop";

export type LocalLeaftailPurchase = Readonly<{
  id: string; ownerPublicId: string; revision: number; coins: number;
  kind: "item" | "wardrobe" | "rod" | "hook" | "bait";
  destination: "pantry" | "wardrobe" | "tackle";
  items: readonly Readonly<{ itemId: string; name: string; quantity: number }>[];
}>;

/** Freeze the accepted local quote and exact ownership/inventory change. Neither
 * a later GET nor a replay without its original before state proves a purchase. */
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
  const offer = leaftailShopOffers(before.catalog, stock.cycle, before.ownerPublicId).find(item => item.id === offerId);
  if (!offer || offer.priceCoins !== coins) return null;
  const { itemId } = offer, kind = offer.kind ?? "item", quantity = offer.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1) return null;
  let name: string | undefined;
  if (kind === "wardrobe") {
    if (quantity !== 1 || before.wardrobe?.includes(itemId) || !after.wardrobe?.includes(itemId)) return null;
    name = wardrobeItems.find(item => item.id === itemId)?.name;
  } else if (kind === "rod" || kind === "hook") {
    const previous = kind === "rod" ? before.fishing?.ownedRods : before.fishing?.ownedHooks;
    const owned = kind === "rod" ? after.fishing?.ownedRods : after.fishing?.ownedHooks;
    if (quantity !== 1 || previous?.includes(itemId) || !owned?.includes(itemId)) return null;
    name = (kind === "rod" ? after.catalog.fishing?.rods : after.catalog.fishing?.hooks)?.find(item => item.id === itemId)?.name;
  } else {
    const previous = before.inventory[itemId] ?? 0, current = after.inventory[itemId] ?? 0;
    if (![previous, current].every(value => Number.isSafeInteger(value) && value >= 0) || current - previous !== quantity) return null;
    name = after.catalog.items.find(item => item.id === itemId)?.name;
  }
  if (!name) return null;
  return Object.freeze({ id: command.requestId, ownerPublicId: after.ownerPublicId, revision: result.acceptedRevision,
    coins, kind, destination: kind === "wardrobe" ? "wardrobe" : kind === "rod" || kind === "hook" ? "tackle" : "pantry",
    items: Object.freeze([Object.freeze({ itemId, name, quantity })]) });
}
