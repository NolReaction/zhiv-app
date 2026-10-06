import { z } from "zod";
import catalogJson from "@/apps/api/src/main/resources/world/economy-catalog.json";

import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS, ECONOMY_MAX_ITEMS } from "./money";
export { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS, ECONOMY_MAX_ITEMS, ECONOMY_CURRENCY_SCALE, ECONOMY_PEARL_SCALE } from "./money";
const count = z.number().int().nonnegative().safe();
const balance = count.max(ECONOMY_MAX_BALANCE);
const id = z.string().min(1).max(80);
const quantities = z.record(id, count.max(ECONOMY_MAX_ITEMS));
const requiredBuildings = z.record(id, count.positive().max(100)).default({});
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const economyCostSchema = z.object({ coins: balance, items: quantities });
export const economyCollectionSpecSchema = z.object({ kind: z.literal("berry_harvest"), seconds: count.positive().max(120) });
export const economyCollectionSchema = economyCollectionSpecSchema.extend({
  startedAt: z.string().datetime().nullable(), finishesAt: z.string().datetime().nullable(),
}).refine(value => (value.startedAt === null) === (value.finishesAt === null), "Collection timestamps must be paired")
  .refine(value => !value.startedAt || !value.finishesAt || Date.parse(value.finishesAt) >= Date.parse(value.startedAt) + value.seconds * 1000,
    "Collection cannot finish before its required duration");
export const economyFishingSchema = z.object({
  ownedRods: z.array(id).max(100).default(["reed_rod"]), equippedRodId: id.default("reed_rod"),
  ownedHooks: z.array(id).max(100).default(["bare_hook"]), equippedHookId: id.default("bare_hook"),
  equippedBaitId: id.nullable().default(null), catches: quantities.default({}),
}).default({ ownedRods: ["reed_rod"], equippedRodId: "reed_rod", ownedHooks: ["bare_hook"], equippedHookId: "bare_hook", equippedBaitId: null, catches: {} });
export const economyFishingShopSchema = z.object({
  id: uuid, openedAt: z.string().datetime(), refreshAt: z.string().datetime(), refreshPricePearls: balance,
  offers: z.array(z.object({ id, kind: z.enum(["rod", "hook", "bait", "fish"]), itemId: id, unitPrice: balance.positive(), remaining: count.max(100) })).max(4),
});
export type EconomyFishingShop = z.infer<typeof economyFishingShopSchema>;
const rarityWeights = z.object({ common: count.positive().max(1000), uncommon: count.positive().max(1000),
  rare: count.positive().max(1000), epic: count.positive().max(1000), legendary: count.positive().max(1000) });
const defaultGearShopOdds = [
  { common: 0, uncommon: 10000, rare: 0, epic: 0, legendary: 0 },
  { common: 0, uncommon: 9000, rare: 1000, epic: 0, legendary: 0 },
  { common: 0, uncommon: 8350, rare: 1400, epic: 250, legendary: 0 },
  { common: 0, uncommon: 7800, rare: 1700, epic: 480, legendary: 20 },
  { common: 0, uncommon: 7000, rare: 2250, epic: 700, legendary: 50 },
];
const shopRarityOdds = z.object({ common: count.max(10000), uncommon: count.max(10000), rare: count.max(10000),
  epic: count.max(10000), legendary: count.max(10000) }).refine(value => Object.values(value).reduce((a, b) => a + b, 0) === 10000);
export const economyFishingCatalogSchema = z.object({
  shop: z.object({ refreshSeconds: count.positive().max(86400), refreshPricePearls: balance.positive(), slots: z.literal(4), baitStock: count.positive().max(100),
    fishStock: count.positive().max(100).default(3), fishPriceBps: count.positive().max(9999).default(8000),
    gearRarityBpsByHome: z.array(shopRarityOdds).length(5).default(defaultGearShopOdds) })
    .default({ refreshSeconds: 21600, refreshPricePearls: 100, slots: 4, baitStock: 5, fishStock: 3, fishPriceBps: 8000, gearRarityBpsByHome: defaultGearShopOdds }),
  routeIds: z.array(id).min(1).max(100),
  collectionDrawsByRoute: z.record(id, count.positive().max(100)).default({}),
  fish: z.array(z.object({ itemId: id, description: z.string(), rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]),
    weight: count.positive().max(10000), affinity: count.max(10), buyPrice: balance.positive(), requiredHookId: id.nullish() })).min(1).max(100),
  rods: z.array(z.object({ id, name: z.string(), description: z.string(), price: balance, rareBonus: count.max(100), rarityWeights: rarityWeights.nullish(),
    rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).default("common"), requiredHomeLevel: count.positive().max(5).default(1) })).min(1).max(100),
  hooks: z.array(z.object({ id, name: z.string(), description: z.string(), price: balance, rareBonus: count.max(100), rarityWeights: rarityWeights.nullish(),
    rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).default("common"), requiredHomeLevel: count.positive().max(5).default(1) })).min(1).max(100)
    .default([{ id: "bare_hook", name: "Простой крючок", description: "Начальная снасть без дополнительных усилений.", price: 0, rareBonus: 0, rarity: "common", requiredHomeLevel: 1 }]),
  baits: z.array(z.object({ itemId: id, description: z.string(), price: balance.positive(), rareBonus: count.max(100), rarityWeights: rarityWeights.nullish(),
    rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).default("common"), requiredHomeLevel: count.positive().max(5).default(1) })).max(100),
});
export const economyRareDropsSchema = z.object({ version: z.literal(1), requiredHomeLevel: count.positive().max(5),
  minSeconds: count.positive().max(31_536_000), maxSeconds: count.positive().max(31_536_000), itemIds: z.array(id).length(3),
}).refine(value => value.maxSeconds >= value.minSeconds && new Set(value.itemIds).size === value.itemIds.length);
export const economyRareDropDeliverySchema = z.object({ version: z.literal(1), seconds: count.positive(), itemId: id.nullable() });
export type EconomyRareDropClock = { version: 1; remainingSeconds: number; itemId: string };
export const economyCatalogSchema = z.object({
  productionSlots: z.object({ upgrades: z.array(z.object({
    slots: z.number().int().min(2).max(3), requiredHomeLevel: z.number().int().min(1).max(5), pricePearls: count.positive().max(ECONOMY_MAX_PEARLS),
  })).max(2).refine(upgrades => upgrades.every((upgrade, index) => upgrade.slots === index + 2)) }).default({ upgrades: [] }),
  rareDrops: economyRareDropsSchema.optional(),
  fishing: economyFishingCatalogSchema.optional(),
  localBuyer: z.object({ payoutBps: count.positive().max(10_000) }).optional(),
  version: z.literal(3), currencyScale: z.literal(10), pearlScale: z.literal(50), maxBatch: z.number().int().min(1).max(100),
  constructionSpeedup: z.object({ secondsPerPearl: count.positive().max(86400) }),
  market: z.object({ requiredHomeLevel: count.positive(), requiredExplorations: count, maxListings: count.positive(), maxLotQuantity: count.positive(), maxPriceMultiplier: count.positive(), feeBps: count.max(10000), dailyTradeValueByHome: z.array(balance).length(5).default([0, 2400, 4800, 9600, 14400]),
    showcaseSlots: count.positive().max(12).default(12), showcasePerSeller: count.positive().max(10).default(2), showcaseRefreshSeconds: count.positive().max(86400).default(1800) }),
  items: z.array(z.object({ id, name: z.string(), category: z.string(), baseSellPrice: balance, tradable: z.boolean() })
    .refine(item => item.category === "special" ? item.baseSellPrice === 0 && !item.tradable : item.baseSellPrice > 0)).max(1000),
  buildings: z.array(z.object({ id, name: z.string(), description: z.string(), levels: z.array(z.object({
    level: z.number().int().min(1).max(100), seconds: count, cost: economyCostSchema, requiredHomeLevel: z.number().int().min(1).max(5),
    requiredBuildings, warehouseCapacity: count.positive().nullish(),
  })).max(100) })).max(100),
  recipes: z.array(z.object({ id, name: z.string(), buildingId: id, buildingLevel: count.positive(), requiredHomeLevel: count.positive(),
    maxBatch: count.positive().max(100).nullish(),
    requiredBuildings, seconds: count.positive(), cost: economyCostSchema, rewards: quantities, collection: economyCollectionSpecSchema.nullish() })
    .refine(recipe => !recipe.collection || recipe.buildingId === "garden" && (recipe.rewards.berries ?? 0) > 0,
      "Berry collection requires a garden recipe with berries")).max(1000),
  explorations: z.array(z.object({ id, name: z.string(), description: z.string(), requiredHomeLevel: count.positive(), activity: z.literal("mining").nullish(),
    requiredBuildings, seconds: count.positive(), cost: economyCostSchema, rewards: quantities })).max(1000),
});
export const economyCatalog = economyCatalogSchema.parse(catalogJson);
export const economyBookCollectionSchema = z.object({
  finds: z.array(id).max(100).default([]), travelSeconds: count.max(ECONOMY_MAX_ITEMS).default(0), quarrySeconds: count.max(ECONOMY_MAX_ITEMS).default(0),
}).default({ finds: [], travelSeconds: 0, quarrySeconds: 0 });
export const economyProgressionSchema = z.object({
  routes: quantities.default({}), recipes: quantities.default({}), collections: economyBookCollectionSchema,
}).default({ routes: {}, recipes: {}, collections: { finds: [], travelSeconds: 0, quarrySeconds: 0 } });
export const economyMigrationSchema = z.object({ version: z.literal(1), coinsGranted: count.max(5000), woodGranted: count.max(30), stoneGranted: count.max(30) });
export const economyJobSchema = z.object({
  id: uuid, kind: z.enum(["production", "exploration", "construction"]), targetId: id,
  recipeId: id.nullable(), targetLevel: count.nullable(), startedAt: z.string().datetime(), finishesAt: z.string().datetime(),
  rewards: quantities, cost: economyCostSchema, catalogVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  collection: economyCollectionSchema.nullish(),
  fishing: z.object({ rodId: id, hookId: id.default("bare_hook"), baitId: id.nullable(), fishId: id }).nullish(),
  rareDrop: economyRareDropDeliverySchema.nullish(),
}).refine(job => !job.collection || job.kind === "production" && job.targetId === "garden" && (job.rewards.berries ?? 0) > 0,
  "Berry collection requires a garden production order")
  .refine(job => !job.rareDrop || job.kind === "exploration" && (!job.rareDrop.itemId || job.rewards[job.rareDrop.itemId] === 1),
    "Rare materials belong to a saved exploration delivery");
export const economyStorageSchema = z.object({ capacity: count, used: count, reserved: count, available: count, overflow: count });
export const economyViewSchema = z.object({
  ownerPublicId: z.string().min(1).max(40), revision: count, serverTime: z.string().datetime(),
  currencyScale: z.literal(10).default(10), pearlScale: z.literal(50).default(50),
  wallet: z.object({ coins: balance, pearls: count.max(ECONOMY_MAX_PEARLS) }), inventory: quantities, buildings: z.record(id, count.max(100)),
  productionSlots: z.record(id, count.min(1).max(3)).default({}),
  jobs: z.array(economyJobSchema).max(100), migration: economyMigrationSchema, catalog: economyCatalogSchema,
  fishingShop: economyFishingShopSchema.nullable().default(null),
  wardrobe: z.array(id).max(100).default(["moss", "amber_scarf"]),
  completedExplorations: count, storage: economyStorageSchema, fishing: economyFishingSchema, progression: economyProgressionSchema,
});
const commandBase = {
  requestId: uuid, ownerPublicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/), expectedRevision: count.max(Number.MAX_SAFE_INTEGER - 1), targetId: id,
  quantity: z.number().int().min(1).max(10_000).default(1), totalPrice: balance.default(0),
};
export const economyCommandSchema = z.object({ ...commandBase,
  action: z.enum(["start_production", "buy_production_slot", "start_collection", "start_exploration", "cancel_exploration", "start_construction", "speedup_construction", "claim_job", "sell", "buy_fishing_item", "buy_wardrobe_item", "refresh_fishing_shop", "sell_fish", "equip_fishing_rod", "equip_fishing_hook", "equip_fishing_bait", "start_fishing"]),
}).strict();
export const marketCommandSchema = z.object({ ...commandBase,
  action: z.enum(["create_listing", "buy_listing", "cancel_listing"]),
}).strict();
export const economyMarketListingSchema = z.object({
  id: uuid, sellerPublicId: z.string().min(1), sellerName: z.string(), itemId: id,
  quantity: z.number().int().min(1).max(99), totalPrice: balance.positive(), status: z.enum(["active", "sold", "cancelled"]),
  createdAt: z.string().datetime(), closedAt: z.string().datetime().nullable(), owned: z.boolean(), feeBps: count.max(10000).default(0),
});
export const marketViewSchema = z.object({
  listings: z.array(economyMarketListingSchema).max(12), mine: z.array(economyMarketListingSchema).max(10),
  nextCursor: z.null(), serverTime: z.string().datetime(),
  tradeBudget: z.object({ buysUsed: count, salesUsed: count, limit: count, resetsAt: z.string().datetime(), feeBps: count.max(10000),
    homeBandMin: count, homeBandMax: count }).nullish(),
  showcase: z.object({ refreshAt: z.string().datetime(), slots: count.positive().max(12), maxPerSeller: count.positive().max(10), refreshSeconds: count.positive().max(86400) }).optional(),
});
export const economyResultSchema = z.object({
  state: economyViewSchema, message: z.string(), acceptedRevision: count, replayed: z.boolean(), listing: economyMarketListingSchema.optional().nullable(),
});
export type EconomyCost = z.infer<typeof economyCostSchema>;
export type EconomyStorage = z.infer<typeof economyStorageSchema>;
export type EconomyCatalog = z.infer<typeof economyCatalogSchema>;
export type EconomyView = z.infer<typeof economyViewSchema>;
export type EconomyJob = z.infer<typeof economyJobSchema>;
export type EconomyCommand = z.infer<typeof economyCommandSchema>;
export type MarketCommand = z.infer<typeof marketCommandSchema>;
export type EconomyResult = z.infer<typeof economyResultSchema>;
export type EconomyMarketListing = z.infer<typeof economyMarketListingSchema>;
export type MarketView = z.infer<typeof marketViewSchema>;
export type EconomyProgression = z.infer<typeof economyProgressionSchema>;
export type EconomyState = Pick<EconomyView, "wallet" | "inventory" | "buildings" | "jobs" | "migration" | "completedExplorations" | "fishing" | "progression"> & { productionSlots?: Record<string, number>; wardrobe?: string[]; currencyScale?: 1 | 10; pearlScale?: 1 | 10 | 50; fishingShop?: EconomyFishingShop | null; fishingCastSeed?: string | null; rareDropState?: EconomyRareDropClock | null };

export type EconomyFishing = z.infer<typeof economyFishingSchema>;
export type EconomyFishingCatalog = z.infer<typeof economyFishingCatalogSchema>;
