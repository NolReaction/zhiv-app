import { wardrobeItems } from "@/features/world/domain/wardrobe";
import type { EconomyCommand, EconomyResult, EconomyView } from "./model";
import { leaftailOfferTarget, leaftailShopOffers, leaftailShopUsesUnits } from "./leaftail-shop";

export type LocalLeaftailPurchase = Readonly<{
  id: string; ownerPublicId: string; revision: number; coins: number; pearls: number;
  currency: "coins" | "pearls"; quantity: number;
  kind: "item" | "wardrobe" | "rod" | "hook" | "bait";
  destination: "pantry" | "wardrobe" | "tackle";
  items: readonly Readonly<{ itemId: string; name: string; quantity: number }>[];
}>;

/** Freeze the accepted local quote and exact ownership/inventory change. Neither
 * a later GET nor a replay without its original before state proves a purchase. */
export function localLeaftailPurchaseFromReceipt(before: EconomyView | null, result: EconomyResult,
  command: EconomyCommand): LocalLeaftailPurchase | null {
  const after = result.state;
  if (command.action !== "buy_leaftail_item" || !before || !Number.isSafeInteger(command.quantity) || command.quantity < 1
    || command.quantity > (leaftailShopUsesUnits(before.catalog) ? 20 : 1)
    || before.ownerPublicId !== after.ownerPublicId || command.ownerPublicId !== after.ownerPublicId
    || command.expectedRevision !== before.revision || result.acceptedRevision !== before.revision + 1
    || after.revision !== result.acceptedRevision) return null;
  const coins = before.wallet.coins - after.wallet.coins, pearls = before.wallet.pearls - after.wallet.pearls;
  if (![before.wallet.coins, after.wallet.coins, coins, before.wallet.pearls, after.wallet.pearls, pearls]
    .every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const stock = after.leaftailShop;
  if (!stock) return null;
  const offer = leaftailShopOffers(before.catalog, stock.cycle, before.ownerPublicId, before.buildings.home ?? 1)
    .find(item => command.targetId === leaftailOfferTarget(before.catalog, stock.cycle, item.id));
  if (!offer) return null;
  const previousPurchased = before.leaftailShop?.cycle === stock.cycle ? before.leaftailShop.purchased[offer.id] ?? 0 : 0;
  if (!Number.isSafeInteger(previousPurchased) || previousPurchased < 0
    || stock.purchased[offer.id] !== previousPurchased + command.quantity || stock.purchased[offer.id] > offer.stock) return null;
  const price = offer.unitPrice * command.quantity;
  if (price !== command.totalPrice || (offer.currency === "coins" ? coins !== price || pearls !== 0 : pearls !== price || coins !== 0)) return null;
  const { itemId } = offer, kind = offer.kind, quantity = offer.quantity * command.quantity;
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
    coins, pearls, currency: offer.currency, quantity: command.quantity, kind,
    destination: kind === "wardrobe" ? "wardrobe" : kind === "rod" || kind === "hook" ? "tackle" : "pantry",
    items: Object.freeze([Object.freeze({ itemId, name, quantity })]) });
}
