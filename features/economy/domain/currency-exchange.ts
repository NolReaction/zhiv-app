import { z } from "zod";
import catalogJson from "@/apps/api/src/main/resources/world/currency-exchange-catalog.json";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS, PEARL_DISPLAY_DIVISOR } from "./money";

/** One-way exchange. Versioned offer IDs freeze both the price and the payout. */
export const currencyExchangeCatalogSchema = z.object({
  version: z.literal(1),
  offers: z.array(z.object({
    id: z.string().regex(/^gold_[a-z]+_v[1-9][0-9]*$/).max(80), name: z.string().min(1).max(100),
    pearls: z.number().int().positive().safe().max(ECONOMY_MAX_PEARLS).refine(amount => amount % PEARL_DISPLAY_DIVISOR === 0),
    coins: z.number().int().positive().safe().max(ECONOMY_MAX_BALANCE),
    bonusPercent: z.number().int().min(0).max(20),
  }).strict()).min(1).max(10),
}).strict().refine(catalog => new Set(catalog.offers.map(offer => offer.id)).size === catalog.offers.length
  && catalog.offers.every(offer => offer.coins * 100 === offer.pearls * 25 * (100 + offer.bonusPercent)),
"Exchange offers require unique IDs and a bounded volume bonus");
export const currencyExchangeCatalog = currencyExchangeCatalogSchema.parse(catalogJson);
export type CurrencyExchangeOffer = typeof currencyExchangeCatalog.offers[number];
export const currencyExchangeOffer = (id: string): CurrencyExchangeOffer | undefined => currencyExchangeCatalog.offers.find(offer => offer.id === id);
