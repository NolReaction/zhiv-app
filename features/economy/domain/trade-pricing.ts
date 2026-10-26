import { economyCatalog, type EconomyCatalog, type EconomyState } from "./model";
import { tradeDiscountedPrice } from "./trade-relations";

/** Professional discounts cover equipment and clothes. Commodity supply, fish,
 * pearls and rerolls keep their original prices and order exchange value. */
export function tradePurchaseUnitPrice(state: Pick<EconomyState, "tradeRelations">,
  residentId: "plesk" | "leaftail", kind: string, basePrice: number,
  currency: "coins" | "pearls" = "coins", catalog: EconomyCatalog = economyCatalog, now?: number): number {
  if (currency !== "coins" || !["rod", "hook", "bait", "wardrobe"].includes(kind) || basePrice <= 0) return basePrice;
  return Math.max(1, tradeDiscountedPrice(state, residentId, basePrice, catalog, now));
}
