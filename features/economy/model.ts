import { z } from "zod";
import catalogJson from "@/apps/api/src/main/resources/world/economy-catalog.json";

export const ECONOMY_MAX_BALANCE = 1_000_000_000;
const count = z.number().int().nonnegative().safe();
const balance = count.max(ECONOMY_MAX_BALANCE);
const id = z.string().min(1).max(80);
const quantities = z.record(id, balance);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const economyCostSchema = z.object({ coins: balance, items: quantities });
export const economyCatalogSchema = z.object({
  version: z.literal(1), maxBatch: z.number().int().min(1).max(100),
  market: z.object({ requiredHomeLevel: count.positive(), requiredExplorations: count, maxListings: count.positive(), maxLotQuantity: count.positive(), maxPriceMultiplier: count.positive(), feeBps: count.max(10000) }),
  items: z.array(z.object({ id, name: z.string(), category: z.string(), baseSellPrice: balance.positive(), tradable: z.boolean() })).max(1000),
  buildings: z.array(z.object({ id, name: z.string(), description: z.string(), levels: z.array(z.object({
    level: z.number().int().min(1).max(100), seconds: count, cost: economyCostSchema, requiredHomeLevel: z.number().int().min(1).max(5),
  })).max(100) })).max(100),
  recipes: z.array(z.object({ id, name: z.string(), buildingId: id, buildingLevel: count.positive(), requiredHomeLevel: count.positive(),
    seconds: count.positive(), cost: economyCostSchema, rewards: quantities })).max(1000),
  explorations: z.array(z.object({ id, name: z.string(), description: z.string(), requiredHomeLevel: count.positive(),
    seconds: count.positive(), cost: economyCostSchema, rewards: quantities })).max(1000),
});
export const economyCatalog = economyCatalogSchema.parse(catalogJson);
export const economyMigrationSchema = z.object({ version: z.literal(1), coinsGranted: count.max(500), woodGranted: count.max(30), stoneGranted: count.max(30) });
export const economyJobSchema = z.object({
  id: uuid, kind: z.enum(["production", "exploration", "construction"]), targetId: id,
  recipeId: id.nullable(), targetLevel: count.nullable(), startedAt: z.string().datetime(), finishesAt: z.string().datetime(),
  rewards: quantities, cost: economyCostSchema, catalogVersion: z.literal(1),
});
export const economyViewSchema = z.object({
  ownerPublicId: z.string().min(1).max(40), revision: count, serverTime: z.string().datetime(),
  wallet: z.object({ coins: balance, pearls: balance }), inventory: quantities, buildings: z.record(id, count.max(100)),
  jobs: z.array(economyJobSchema).max(100), migration: economyMigrationSchema, catalog: economyCatalogSchema,
  completedExplorations: count,
});
const commandBase = {
  requestId: uuid, ownerPublicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/), expectedRevision: count.max(Number.MAX_SAFE_INTEGER - 1), targetId: id,
  quantity: z.number().int().min(1).max(10_000).default(1), totalPrice: balance.default(0),
};
export const economyCommandSchema = z.object({ ...commandBase,
  action: z.enum(["start_production", "start_exploration", "start_construction", "claim_job", "sell"]),
}).strict();
export const marketCommandSchema = z.object({ ...commandBase,
  action: z.enum(["create_listing", "buy_listing", "cancel_listing"]),
}).strict();
export const economyMarketListingSchema = z.object({
  id: uuid, sellerPublicId: z.string().min(1), sellerName: z.string(), itemId: id,
  quantity: z.number().int().min(1).max(99), totalPrice: balance.positive(), status: z.enum(["active", "sold", "cancelled"]),
  createdAt: z.string().datetime(), closedAt: z.string().datetime().nullable(), owned: z.boolean(),
});
export const marketViewSchema = z.object({
  listings: z.array(economyMarketListingSchema).max(50), mine: z.array(economyMarketListingSchema).max(10),
  nextCursor: z.string().nullable(), serverTime: z.string().datetime(),
});
export const economyResultSchema = z.object({
  state: economyViewSchema, message: z.string(), acceptedRevision: count, replayed: z.boolean(), listing: economyMarketListingSchema.optional().nullable(),
});
export type EconomyCost = z.infer<typeof economyCostSchema>;
export type EconomyCatalog = z.infer<typeof economyCatalogSchema>;
export type EconomyView = z.infer<typeof economyViewSchema>;
export type EconomyJob = z.infer<typeof economyJobSchema>;
export type EconomyCommand = z.infer<typeof economyCommandSchema>;
export type MarketCommand = z.infer<typeof marketCommandSchema>;
export type EconomyResult = z.infer<typeof economyResultSchema>;
export type EconomyMarketListing = z.infer<typeof economyMarketListingSchema>;
export type MarketView = z.infer<typeof marketViewSchema>;
export type EconomyState = Pick<EconomyView, "wallet" | "inventory" | "buildings" | "jobs" | "migration" | "completedExplorations">;
