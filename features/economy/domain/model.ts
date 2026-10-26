import { z } from "zod";
import catalogJson from "@/apps/api/src/main/resources/world/economy-catalog.json";
import { hasGardenBerryReward } from "./garden-berries";
import { wardrobeItems } from "@/features/world/domain/wardrobe";

import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS, ECONOMY_MAX_ITEMS, ECONOMY_PEARL_SCALE } from "./money";
export { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS, ECONOMY_MAX_ITEMS, ECONOMY_CURRENCY_SCALE, ECONOMY_PEARL_SCALE } from "./money";
const count = z.number().int().nonnegative().safe();
const balance = count.max(ECONOMY_MAX_BALANCE);
const id = z.string().min(1).max(80);
const quantities = z.record(id, count.max(ECONOMY_MAX_ITEMS));
const requiredBuildings = z.record(id, count.positive().max(100)).prefault({});
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const economyCostSchema = z.object({ coins: balance, items: quantities });
export const economyCollectionSpecSchema = z.object({ kind: z.literal("berry_harvest"), seconds: count.positive().max(120) });
export const economyCollectionSchema = economyCollectionSpecSchema.extend({
  startedAt: z.string().datetime().nullable(), finishesAt: z.string().datetime().nullable(),
  batchId: uuid.optional(),
}).refine(value => (value.startedAt === null) === (value.finishesAt === null), "Collection timestamps must be paired")
  .refine(value => !value.batchId || value.startedAt !== null, "A collection batch must have started")
  .refine(value => !value.startedAt || !value.finishesAt || Date.parse(value.finishesAt) >= Date.parse(value.startedAt) + value.seconds * 1000,
    "Collection cannot finish before its required duration");
export const economyFishingSchema = z.object({
  ownedRods: z.array(id).max(100).prefault(["reed_rod"]), equippedRodId: id.prefault("reed_rod"),
  ownedHooks: z.array(id).max(100).prefault(["bare_hook"]), equippedHookId: id.prefault("bare_hook"),
  equippedBaitId: id.nullable().prefault(null), catches: quantities.prefault({}), stock: quantities.nullish(),
  escrow: z.record(uuid, quantities).nullish(),
}).prefault({ ownedRods: ["reed_rod"], equippedRodId: "reed_rod", ownedHooks: ["bare_hook"], equippedHookId: "bare_hook", equippedBaitId: null, catches: {} });
export const economyFishingShopSchema = z.object({
  id: uuid, openedAt: z.string().datetime(), refreshAt: z.string().datetime(), refreshPricePearls: balance,
  offers: z.array(z.object({ id, kind: z.enum(["rod", "hook", "bait", "fish"]), itemId: id, unitPrice: balance.positive(), remaining: count.max(100) })).max(4),
});
export type EconomyFishingShop = z.infer<typeof economyFishingShopSchema>;
export const economyLeaftailShopSchema = z.object({
  cycle: z.number().int().min(-1).safe().prefault(-1), purchased: z.record(id, count.max(100)).prefault({}),
}).prefault({ cycle: -1, purchased: {} });
export type EconomyLeaftailShop = z.infer<typeof economyLeaftailShopSchema>;
const rarityWeights = z.object({ common: count.positive().max(1000), uncommon: count.positive().max(1000),
  rare: count.positive().max(1000), epic: count.positive().max(1000), legendary: count.positive().max(1000) });
// Missing species use 100 tickets. These affect only the second, within-class draw.
const speciesWeights = z.record(id, count.positive().max(1000)).refine(value => Object.keys(value).length <= 100).nullish();
const defaultGearShopOdds = [
  { common: 0, uncommon: 10000, rare: 0, epic: 0, legendary: 0 },
  { common: 0, uncommon: 9000, rare: 1000, epic: 0, legendary: 0 },
  { common: 0, uncommon: 8350, rare: 1400, epic: 250, legendary: 0 },
  { common: 0, uncommon: 7800, rare: 1700, epic: 480, legendary: 20 },
  { common: 0, uncommon: 7000, rare: 2250, epic: 700, legendary: 50 },
];
const shopRarityOdds = z.object({ common: count.max(10000), uncommon: count.max(10000), rare: count.max(10000),
  epic: count.max(10000), legendary: count.max(10000) }).refine(value => Object.values(value).reduce((a, b) => a + b, 0) === 10000);
const fishingRodClassOdds = z.object({ common: count.max(10000), uncommon: count.max(10000), rare: count.max(10000),
  epic: count.max(10000), legendary: count.max(10000) }).strict()
  .refine(value => Object.values(value).reduce((sum, weight) => sum + weight, 0) === 10000, "Rod class odds must sum to 10000");
export const economyFishingCatalogSchema = z.object({
  shop: z.object({ refreshSeconds: count.positive().max(86400), refreshPricePearls: balance.positive(), refreshPriceStepPearls: balance.positive().prefault(2), slots: z.literal(4), baitStock: count.positive().max(100),
    fishStock: count.positive().max(100).prefault(3), fishPriceBps: count.positive().max(9999).prefault(8000),
    gearRarityBpsByHome: z.array(shopRarityOdds).length(5).prefault(defaultGearShopOdds) })
    .refine(value => value.refreshPriceStepPearls <= value.refreshPricePearls)
    .prefault({ refreshSeconds: 21600, refreshPricePearls: 100, refreshPriceStepPearls: 2, slots: 4, baitStock: 5, fishStock: 3, fishPriceBps: 8000, gearRarityBpsByHome: defaultGearShopOdds }),
  routeIds: z.array(id).min(1).max(100),
  collectionDrawsByRoute: z.record(id, count.positive().max(100)).prefault({}),
  classes: z.array(z.object({ rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]), itemId: id,
    weight: count.positive().max(10000), buyPrice: balance.positive() })).length(5)
    .refine(classes => new Set(classes.map(item => item.rarity)).size === 5 && new Set(classes.map(item => item.itemId)).size === 5, "Fish classes must cover five unique rarities and items"),
  fish: z.array(z.object({ itemId: id, description: z.string(), rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]),
    weight: count.positive().max(10000).nullish(), affinity: count.max(10).nullish(), buyPrice: balance.positive(), requiredHookId: id.nullish() })).min(1).max(100),
  rods: z.array(z.object({ id, name: z.string(), description: z.string(), price: balance, rareBonus: count.max(100), rarityWeights: rarityWeights.nullish(),
    classOddsBps: fishingRodClassOdds.nullish(), speciesWeights, shop: z.enum(["plesk", "leaftail"]).prefault("plesk"),
    rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).prefault("common"), requiredHomeLevel: count.positive().max(5).prefault(1) })).min(1).max(100),
  hooks: z.array(z.object({ id, name: z.string(), description: z.string(), shop: z.enum(["plesk", "leaftail"]).prefault("plesk"), price: balance, rareBonus: count.max(100), rarityWeights: rarityWeights.nullish(), speciesWeights,
    rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).prefault("common"), requiredHomeLevel: count.positive().max(5).prefault(1) })).min(1).max(100)
    .prefault([{ id: "bare_hook", name: "Простой крючок", description: "Начальная снасть без дополнительных усилений.", price: 0, rareBonus: 0, rarity: "common", requiredHomeLevel: 1, shop: "plesk" }]),
  baits: z.array(z.object({ itemId: id, description: z.string(), shop: z.enum(["plesk", "leaftail"]).prefault("plesk"), price: balance.positive(), rareBonus: count.max(100), rarityWeights: rarityWeights.nullish(),
    rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).prefault("common"), requiredHomeLevel: count.positive().max(5).prefault(1) })).max(100),
});
export const economyRareDropsSchema = z.object({ version: z.literal(1), requiredHomeLevel: count.positive().max(5),
  minSeconds: count.positive().max(31_536_000), maxSeconds: count.positive().max(31_536_000), itemIds: z.array(id).length(3),
}).refine(value => value.maxSeconds >= value.minSeconds && new Set(value.itemIds).size === value.itemIds.length);
export const economyRareDropDeliverySchema = z.object({ version: z.literal(1), seconds: count.positive(), itemId: id.nullable() });
export type EconomyRareDropClock = { version: 1; remainingSeconds: number; itemId: string };
export const economyFoodSchema = z.object({ heroMeal: id.nullable().prefault(null), builderMeal: id.nullable().prefault(null),
  heroMealEffect: z.object({ remainingWorkSeconds: count.positive().max(31_536_000), totalWorkSeconds: count.positive().max(31_536_000),
    speedBps: count.max(10000) }).refine(effect => effect.remainingWorkSeconds <= effect.totalWorkSeconds).nullish(),
  builderMealSpeedBps: count.max(10000).nullish(),
}).refine(food => !food.heroMealEffect || food.heroMeal !== null, "Hero work requires a pending meal")
  .refine(food => food.builderMealSpeedBps == null || food.builderMeal !== null, "Builder speed requires a pending meal")
  .prefault({ heroMeal: null, builderMeal: null });
export const economyTradeResidentIdSchema = z.enum(["plesk", "builder", "lopukh", "kamneshmyg", "leaftail"]);
export type TradeResidentId = z.infer<typeof economyTradeResidentIdSchema>;
const orderEffortFields = { reputationXp: count.max(10000).optional(), effortSeconds: count.max(31_536_000).optional(),
  manufacturingSeconds: count.max(31_536_000).optional(), fishingUncertain: z.boolean().optional() };
export const economyResidentOrderTermsSchema = z.object({
  id, residentId: economyTradeResidentIdSchema, name: z.string().min(1), description: z.string().max(280).nullish(),
  items: z.record(id, count.positive().max(ECONOMY_MAX_ITEMS)), coins: balance.positive(), pearls: count.max(ECONOMY_MAX_PEARLS).optional(),
  requiredBuildings: z.record(id, count.positive().max(100)).nullish(),
  requiredExplorations: z.record(id, count.positive().max(ECONOMY_MAX_ITEMS)).nullish(),
  ...orderEffortFields,
});
export const economyWeeklyOrderSchema = z.object({
  id, templateId: id, residentId: economyTradeResidentIdSchema, name: z.string().min(1), description: z.string().max(280).nullish(),
  stages: z.array(economyResidentOrderTermsSchema).length(3), stage: count.max(2),
  acceptedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).refine(weekly => Date.parse(weekly.expiresAt) > Date.parse(weekly.acceptedAt)
  && weekly.stages.every(stage => stage.residentId === weekly.residentId), "Weekly terms require one resident and a positive interval");
export const economyTradeRelationsSchema = z.object({
  version: z.literal(1).prefault(1), reputation: z.partialRecord(economyTradeResidentIdSchema, count.max(1_000_000)).prefault({}),
  dailyCycle: z.number().int().min(-1).safe().prefault(-1),
  dailyOrderXp: z.partialRecord(economyTradeResidentIdSchema, count.max(10000)).prefault({}),
  dailyPurchaseXp: z.partialRecord(economyTradeResidentIdSchema, count.max(10000)).prefault({}),
  weekly: economyWeeklyOrderSchema.nullable().prefault(null), weeklyAvailableAt: z.string().datetime().nullable().prefault(null),
  completedWeekly: count.prefault(0),
}).prefault({ version: 1, reputation: {}, dailyCycle: -1, dailyOrderXp: {}, dailyPurchaseXp: {}, weekly: null, weeklyAvailableAt: null, completedWeekly: 0 });
const economyWeeklyOrderStageSchema = z.object({ id, name: z.string().min(1), description: z.string().min(1).max(280),
  items: z.record(id, count.positive().max(100)).refine(items => Object.keys(items).length > 0), coins: balance.positive(),
  pearls: count.max(ECONOMY_MAX_PEARLS).optional(), reputationXp: count.positive().max(10000), effortSeconds: count.positive().max(31_536_000),
  manufacturingSeconds: count.max(31_536_000), fishingUncertain: z.boolean(),
});
export const economyTradeRelationsCatalogSchema = z.object({
  version: z.literal(1), maxBonusBps: z.literal(1000),
  ranks: z.array(z.object({ id, name: z.string().min(1), requiredXp: count.max(1_000_000), bonusBps: count.max(1000) })).length(5)
    .refine(ranks => ranks[0].requiredXp === 0 && ranks[0].bonusBps === 0
      && ranks.every((rank, index) => index === 0 || rank.requiredXp > ranks[index - 1].requiredXp && rank.bonusBps >= ranks[index - 1].bonusBps), "Reputation ranks must increase"),
  dailyOrderXpCap: count.positive().max(1000), purchaseXp: count.positive().max(100), dailyPurchaseXpCap: count.positive().max(100),
  weekly: z.object({ durationSeconds: z.literal(604800), templates: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_]{1,32}$/), residentId: economyTradeResidentIdSchema, name: z.string().min(1), description: z.string().min(1).max(280),
    requiredHomeLevel: count.positive().max(5), requiredBuildings, stages: z.array(economyWeeklyOrderStageSchema).length(3),
  })).min(5).max(100) }),
});
export const economyTutorialOrderSchema = z.object({
  rewardVersion: z.union([z.literal(5), z.literal(6), z.literal(7)]).optional(),
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]).prefault(1), step: count.max(4).prefault(0),
  ingredientsClaimed: z.boolean().prefault(false), completed: z.boolean().prefault(false),
  firstHarvestPrepared: z.boolean().prefault(false),
  terms: economyResidentOrderTermsSchema.nullable().prefault(null),
}).prefault({ version: 1, step: 0, ingredientsClaimed: false, completed: false, firstHarvestPrepared: false, terms: null });
export type EconomyTutorialOrder = z.infer<typeof economyTutorialOrderSchema>;
export const economyStageOrderProgressSchema = z.object({
  step: count.max(100).prefault(0), completed: z.boolean().prefault(false),
  terms: economyResidentOrderTermsSchema.nullable().prefault(null),
  availableAt: z.string().datetime().nullable().prefault(null), intervalSeconds: count.max(31_536_000).nullable().prefault(null),
  completionRewards: quantities.nullable().prefault(null),
});
export const economyStageOrdersSchema = z.object({
  version: z.literal(1).prefault(1), stages: z.record(z.string().regex(/^[1234]$/), economyStageOrderProgressSchema).prefault({}),
}).prefault({ version: 1, stages: {} });
export type EconomyStageOrders = z.infer<typeof economyStageOrdersSchema>;
export type EconomyStageOrderProgress = z.infer<typeof economyStageOrderProgressSchema>;
export const economyResidentOrdersSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]).prefault(1),
  cycle: z.number().int().min(-1).safe().prefault(-1),
  slots: z.array(z.object({ sequence: count, readyAt: z.string().datetime(), templateId: id.nullable().prefault(null), terms: economyResidentOrderTermsSchema.nullish(), residentId: economyTradeResidentIdSchema.nullish(), retired: z.boolean().optional() })).max(7).prefault([]),
  completed: count.prefault(0), earnedCoins: count.prefault(0),
  recentTemplateIds: z.array(id).max(100).prefault([]),
  replacementCycle: z.number().int().min(-1).safe().prefault(-1), freeReplacementsUsed: count.max(100).prefault(0),
}).prefault({ version: 1, cycle: -1, slots: [], completed: 0, earnedCoins: 0, recentTemplateIds: [], replacementCycle: -1, freeReplacementsUsed: 0 });
export const economyFoodCatalogSchema = z.object({
  meals: z.array(z.object({ itemId: id, heroSpeedBps: count.max(10000), builderSpeedBps: count.max(10000), heroWorkSeconds: count.positive().max(31_536_000).nullish() })).min(1).max(100),
  orders: z.object({ slots: z.union([z.literal(3), z.literal(5)]), refreshSeconds: count.min(3600).max(86400),
    replacementSeconds: count.max(86400), completionSeconds: count.max(86400),
    freeReplacements: count.max(100).prefault(3), replacementWindowSeconds: count.min(3600).max(86400).prefault(43200),
    replacementPricePearls: count.positive().max(ECONOMY_MAX_BALANCE).prefault(10), recentLimit: count.max(100).prefault(6),
    progression: z.object({
      rawBpsByHome: z.array(count.min(10000).max(100000)).length(5),
      fishBpsByHome: z.array(count.min(10000).max(20000)).length(5),
      craftedBpsByHome: z.array(count.min(10000).max(20000)).length(5),
    }).nullish(),
    templates: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), residentId: economyTradeResidentIdSchema, name: z.string().min(1), description: z.string().min(1).max(280).nullish(),
      requiredHomeLevel: count.positive().max(5), requiredBuildings,
      items: z.record(id, count.positive().max(100)).refine(items => Object.keys(items).length > 0),
      coins: balance.positive(), ...orderEffortFields,
    })).min(1).max(1000),
  }).refine(orders => orders.replacementSeconds <= orders.refreshSeconds && orders.completionSeconds <= orders.refreshSeconds),
});
const economyLeaftailOfferSchema = z.object({ id: id.max(60), itemId: id, priceCoins: balance.positive(), stock: z.literal(1), quantity: count.min(1).max(100).prefault(1),
  kind: z.enum(["item", "wardrobe", "rod", "hook", "bait"]).prefault("item"), requiredHomeLevel: count.min(1).max(5).prefault(1) });
const economyLeaftailSupplySchema = z.object({ id: id.max(60), itemId: id, unitPriceCoins: balance.positive(),
  stock: count.positive().max(100), requiredHomeLevel: count.min(1).max(5).prefault(1) });
const economyLeaftailPearlSchema = z.object({ id: id.max(60), itemId: id, pricePearls: count.positive().max(ECONOMY_MAX_BALANCE),
  stock: z.literal(1).prefault(1), requiredHomeLevel: count.min(1).max(5).prefault(1) });
export const economyCatalogSchema = z.object({
  timeEconomy: z.object({
    version: z.literal(1), coinsPerMinute: count.positive().max(1_000_000), constructionCoinsPerMinute: count.positive().max(1_000_000), orderBonusBps: count.max(10_000),
    baselineRecipes: z.record(id, id), baselineExplorations: z.record(id, id), externalPrices: z.record(id, balance),
  }).optional(),
  stageOrders: z.array(z.object({ homeLevel: count.min(1).max(4), orders: z.array(economyResidentOrderTermsSchema).min(1).max(100),
    intervalSeconds: count.max(31_536_000).prefault(0), completionRewards: quantities.prefault({}) }))
    .max(4).refine(stages => new Set(stages.map(stage => stage.homeLevel)).size === stages.length, "Stage courses require distinct home levels").optional(),
  onboarding: z.object({
    startingWallet: z.object({ coins: balance, pearls: count.max(ECONOMY_MAX_PEARLS) }),
    startingItems: quantities, residentOrder: economyResidentOrderTermsSchema,
    residentOrders: z.array(economyResidentOrderTermsSchema).min(1).max(4)
      .refine(orders => orders.length === 1 || orders.length === 4, "Current and legacy tutorial catalogs must remain readable").optional(),
  }).optional(),
  productionSlots: z.object({ upgrades: z.array(z.object({
    slots: z.number().int().min(2).max(3), requiredHomeLevel: z.number().int().min(1).max(5), pricePearls: count.positive().max(ECONOMY_MAX_PEARLS),
  })).max(2).refine(upgrades => upgrades.every((upgrade, index) => upgrade.slots === index + 2)) }).prefault({ upgrades: [] }),
  leaftailShop: z.object({ requiredHomeLevel: count.min(1).max(5), refreshSeconds: z.literal(86400),
    offers: z.array(economyLeaftailOfferSchema).min(1).max(12),
    travelOffers: z.array(economyLeaftailOfferSchema).max(32).prefault([]),
    supplyOffers: z.array(economyLeaftailSupplySchema).max(32).optional(),
    pearlOffers: z.array(economyLeaftailPearlSchema).max(12).optional(),
  }).optional(),
  rareDrops: economyRareDropsSchema.optional(),
  fishing: economyFishingCatalogSchema.optional(),
  food: economyFoodCatalogSchema.nullish(),
  tradeRelations: economyTradeRelationsCatalogSchema.optional(),
  localBuyer: z.object({ payoutBps: count.positive().max(10_000), unitPrices: z.record(id, balance.positive()).optional() }).optional(),
  version: z.union([z.literal(10), z.literal(11), z.literal(12), z.literal(13), z.literal(14)]), currencyScale: z.literal(10), pearlScale: z.literal(50), maxBatch: z.number().int().min(1).max(100),
  constructionSpeedup: z.object({ secondsPerPearl: count.positive().max(86400), priceStepPearls: balance.positive().max(ECONOMY_PEARL_SCALE).prefault(2),
    pricingPoints: z.array(z.object({ seconds: count.positive(), pearls: count.positive().max(ECONOMY_MAX_PEARLS) })).max(32).prefault([])
      .refine(points => points.length === 0 || points.length >= 2, "A pricing curve requires at least two points")
      .refine(points => points.every((point, index) => index === 0 || point.seconds > points[index - 1].seconds && point.pearls >= points[index - 1].pearls),
        "Pricing points must have increasing times and nondecreasing prices"),
  }).refine(config => config.pricingPoints.every(point => point.pearls % config.priceStepPearls === 0), "Pricing points require whole price quanta"),
  market: z.object({ requiredHomeLevel: count.positive(), requiredExplorations: count, requiredBuildings,
    maxListings: z.literal(10), baseSlots: z.literal(5).prefault(5),
    slotPricesPearls: z.array(count.positive().max(ECONOMY_MAX_PEARLS)).length(5).prefault([100, 160, 240, 360, 500]),
    maxLotQuantity: count.positive(), maxPriceMultiplier: count.positive(), feeBps: count.max(10000), dailyTradeValueByHome: z.array(balance).length(5).prefault([0, 2400, 4800, 9600, 14400]),
    showcaseSlots: count.positive().max(12).prefault(12), showcasePerSeller: count.positive().max(10).prefault(2), showcaseRefreshSeconds: count.positive().max(86400).prefault(300) }),
  items: z.array(z.object({ id, name: z.string(), category: z.string(), baseSellPrice: balance, tradable: z.boolean() })
    .refine(item => item.category === "special" ? item.baseSellPrice === 0 && !item.tradable : item.baseSellPrice > 0)).max(1000),
  buildings: z.array(z.object({ id, name: z.string(), description: z.string(), levels: z.array(z.object({
    level: z.number().int().min(1).max(100), seconds: count, cost: economyCostSchema, requiredHomeLevel: z.number().int().min(1).max(5),
    requiredBuildings, warehouseCapacity: count.positive().nullish(),
  })).max(100) })).max(100),
  recipes: z.array(z.object({ id, name: z.string(), buildingId: id, buildingLevel: count.positive(), retired: z.boolean().optional(),
    // The initial 0.7.1 API serialized the absent flag as null; keep omitted-flag semantics.
    baseCampfire: z.literal(true).nullish().transform(value => value ?? undefined), requiredHomeLevel: count.positive(),
    maxBatch: count.positive().max(100).nullish(),
    fishInput: z.object({ exactSpecies: z.boolean().optional(), itemIds: z.array(id).min(1).max(100).refine(ids => new Set(ids).size === ids.length) }).nullish(),
    requiredBuildings, requiredRecipes: quantities.prefault({}), seconds: count.positive(), cost: economyCostSchema, rewards: quantities, collection: economyCollectionSpecSchema.nullish() })
    .refine(recipe => !recipe.baseCampfire || recipe.id === "cook_grilled_fish" && recipe.buildingId === "dryer" && recipe.buildingLevel === 1,
      "Only grilled fish is available at the base campfire")
    .refine(recipe => !recipe.collection || recipe.buildingId === "garden" && hasGardenBerryReward(recipe.rewards),
      "Berry collection requires a garden recipe with known berries")
    .refine(recipe => !recipe.fishInput || recipe.fishInput.itemIds.filter(itemId => (recipe.cost.items[itemId] ?? 0) > 0).length === 1,
      "Fish recipes require exactly one replaceable fish ingredient")).max(1000),
  explorations: z.array(z.object({ id, name: z.string(), description: z.string(), requiredHomeLevel: count.positive(), activity: z.literal("mining").nullish(), retired: z.boolean().optional(),
    requiredBuildings, seconds: count.positive(), cost: economyCostSchema, rewards: quantities,
    finds: z.object({ emptyWeight: count.max(1_000_000), entries: z.array(z.object({ itemId: id,
      quantity: count.positive().max(ECONOMY_MAX_ITEMS), weight: count.positive().max(1_000_000) })).min(1).max(100)
      .refine(entries => new Set(entries.map(entry => entry.itemId)).size === entries.length) }).nullish(),
  })).max(1000),
}).superRefine((catalog, context) => {
  const itemIds = new Set(catalog.items.map(item => item.id));
  const fishIds = new Set(catalog.fishing?.fish.map(fish => fish.itemId) ?? []);
  const buildingIds = new Set(catalog.buildings.map(building => building.id));
  const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (catalog.explorations.some(route => route.finds?.entries.some(entry => {
    const item = catalog.items.find(item => item.id === entry.itemId);
    return !item?.tradable || item.category === "special" || fishIds.has(entry.itemId)
      || catalog.fishing?.classes.some(group => group.itemId === entry.itemId);
  }))) invalid("Exploration finds require tradable non-special non-fish items");
  if (catalog.version >= 13 && !catalog.timeEconomy) invalid("Time economy policy is required for catalog 13");
  const policy = catalog.timeEconomy;
  if (policy) {
    const pricedItems = [...Object.keys(policy.baselineRecipes), ...Object.keys(policy.baselineExplorations), ...Object.keys(policy.externalPrices)];
    if (new Set(pricedItems).size !== pricedItems.length || pricedItems.some(itemId => !itemIds.has(itemId)))
      invalid("Time economy sources must price distinct known items");
    if (Object.entries(policy.baselineRecipes).some(([itemId, recipeId]) => !catalog.recipes.some(recipe =>
      recipe.id === recipeId && !recipe.retired && (recipe.rewards[itemId] ?? 0) > 0)))
      invalid("Time economy baseline recipe must be active and produce its item");
    if (Object.entries(policy.baselineExplorations).some(([itemId, routeId]) => !catalog.explorations.some(route =>
      route.id === routeId && !route.retired && (route.rewards[itemId] ?? 0) > 0)))
      invalid("Time economy baseline exploration must be active and yield its item");
  }
  const leafOffers = [...(catalog.leaftailShop?.offers ?? []), ...(catalog.leaftailShop?.travelOffers ?? [])];
  if (leafOffers.length > 32 || catalog.leaftailShop?.offers.some(offer => offer.kind !== "item")
    || new Set(leafOffers.map(offer => offer.id)).size !== leafOffers.length
    || new Set(leafOffers.map(offer => `${offer.kind}:${offer.itemId}`)).size !== leafOffers.length
    || leafOffers.some(offer => {
      if (offer.kind === "item") return !catalog.items.some(item => item.id === offer.itemId && (item.category === "special" ? !item.tradable && offer.quantity === 1
        : ["wood", "stone", "fiber"].includes(item.id) && item.tradable && offer.priceCoins === 2 * item.baseSellPrice * offer.quantity));
      if (offer.kind === "wardrobe") return offer.quantity !== 1 || !wardrobeItems.some(item => item.id === offer.itemId && !item.premium && !item.starter && !item.purchase && item.sparks === 0);
      const gear = offer.kind === "rod" ? catalog.fishing?.rods.find(item => item.id === offer.itemId)
        : offer.kind === "hook" ? catalog.fishing?.hooks.find(item => item.id === offer.itemId)
        : catalog.fishing?.baits.find(item => item.itemId === offer.itemId);
      return !gear || offer.priceCoins !== gear.price * offer.quantity
        || offer.kind !== "bait" && offer.quantity !== 1;
    })) invalid("Leaftail offers require valid exclusive clothing, tackle or non-profitable material bundles");
  const leaf = catalog.leaftailShop;
  if (leaf) {
    const supplies = leaf.supplyOffers ?? [], pearls = leaf.pearlOffers ?? [];
    const all = [...leafOffers, ...supplies, ...pearls];
    const effective = [...(supplies.length ? supplies : leaf.offers), ...leaf.travelOffers, ...pearls];
    const v2 = supplies.length > 0 || pearls.length > 0;
    if (all.length > 64 || new Set(all.map(offer => offer.id)).size !== all.length
      || effective.length > 48 || new Set(effective.map(offer => `${"kind" in offer ? offer.kind : "item"}:${offer.itemId}`)).size !== effective.length
      || supplies.some(offer => !catalog.items.some(item => item.id === offer.itemId && item.tradable
        && ["material", "crafted", "provisions", "produce"].includes(item.category)
        && offer.unitPriceCoins >= 2 * item.baseSellPrice))
      || pearls.some(offer => !catalog.items.some(item => item.id === offer.itemId && item.category === "special" && !item.tradable))
      || v2 && [...(supplies.length ? [] : leaf.offers), ...leaf.travelOffers].some(offer =>
        offer.priceCoins % offer.quantity !== 0 || offer.quantity * offer.stock > 100
        || offer.kind === "item" && catalog.items.some(item => item.id === offer.itemId && item.category === "special")))
      invalid("Leaftail daily stock requires distinct safe supplies and pearl relics");
  }
  if (catalog.fishing) {
    const fishing = catalog.fishing;
    if (fishing.classes.some(group => !itemIds.has(group.itemId) || fishIds.has(group.itemId)
      || group.itemId !== `fish_${group.rarity}` || !fishing.fish.some(fish => fish.rarity === group.rarity)))
      invalid("Fish classes require canonical inventory ids and at least one collection species");
    if (new Set(fishing.fish.map(fish => fish.itemId)).size !== fishing.fish.length
      || fishing.fish.some(fish => !itemIds.has(fish.itemId)))
      invalid("Fish species require unique known items");
    if (fishing.rods.some(rod => !rod.classOddsBps)) invalid("Current rods require explicit class odds");
    if ([...fishing.rods, ...fishing.hooks].some(gear => Object.keys(gear.speciesWeights ?? {}).some(itemId => !fishIds.has(itemId))))
      invalid("Tackle species weights require known collection fish");
    if (fishing.classes.some(group => !fishing.rods.some(rod => (rod.classOddsBps?.[group.rarity] ?? 0) > 0
      && (group.rarity !== "legendary" || rod.rarity === "legendary")))) invalid("Every fish class requires an eligible rod");
    if (Object.keys(fishing.collectionDrawsByRoute).some(routeId => !fishing.routeIds.includes(routeId)) || fishing.routeIds.some(routeId => !catalog.explorations.some(route => route.id === routeId && (route.rewards.fish ?? 0) > 0
      && fishing.collectionDrawsByRoute[routeId] === route.rewards.fish)))
      invalid("Every fish in a fishing route must have its own draw");
  }
  if (catalog.onboarding && (Object.keys(catalog.onboarding.startingItems).some(item => !itemIds.has(item))
    || Object.keys(catalog.onboarding.residentOrder.items).some(item => !itemIds.has(item))
    || !Object.keys(catalog.onboarding.residentOrder.items).length
    || catalog.onboarding.residentOrder.id !== "tutorial_first_order")) invalid("Onboarding requires known goods and a stable tutorial order");
  if (catalog.onboarding?.residentOrders && (new Set(catalog.onboarding.residentOrders.map(order => order.id)).size !== catalog.onboarding.residentOrders.length
    || catalog.onboarding.residentOrders[0].id !== catalog.onboarding.residentOrder.id
    || catalog.onboarding.residentOrders.some(order => !Object.keys(order.items).length || Object.keys(order.items).some(item => !itemIds.has(item)))))
    invalid("Tutorial requires distinct orders with known goods");
  const stageOrders = catalog.stageOrders?.flatMap(stage => stage.orders) ?? [];
  if (catalog.stageOrders?.some(stage => stage.orders.some(order => !order.id.startsWith(`stage${stage.homeLevel}_`)))
    || new Set(stageOrders.map(order => order.id)).size !== stageOrders.length || stageOrders.some(order =>
    !Object.keys(order.items).length || Object.keys(order.items).some(itemId => !itemIds.has(itemId))
    || catalog.onboarding?.residentOrders?.some(tutorial => tutorial.id === order.id)))
    invalid("Stage courses require distinct order ids and known goods");
  if (catalog.stageOrders?.some(stage => Object.entries(stage.completionRewards).some(([itemId, quantity]) => !itemIds.has(itemId) || quantity <= 0)))
    invalid("Stage completion rewards require known goods and positive quantities");
  if (stageOrders.some(order => Object.entries(order.requiredBuildings ?? {}).some(([buildingId, level]) =>
    !buildingIds.has(buildingId) || !catalog.buildings.find(building => building.id === buildingId)?.levels.some(spec => spec.level === level))))
    invalid("Stage orders require known building levels");
  if (stageOrders.some(order => Object.keys(order.requiredExplorations ?? {}).some(routeId => !catalog.explorations.some(route => route.id === routeId))))
    invalid("Stage orders require known exploration routes");
  const recipeIds = new Set(catalog.recipes.map(recipe => recipe.id));
  if (catalog.recipes.some(recipe => Object.entries(recipe.requiredRecipes).some(([recipeId, quantity]) => !recipeIds.has(recipeId) || quantity < 1)))
    invalid("Recipe unlocks require known completed recipes");
  if (Object.keys(catalog.localBuyer?.unitPrices ?? {}).some(itemId => !itemIds.has(itemId)))
    invalid("Local buyer prices require known goods");
  const meals = catalog.food?.meals ?? [], orders = catalog.food?.orders.templates ?? [];
  if (new Set(meals.map(meal => meal.itemId)).size !== meals.length || meals.some(meal => !itemIds.has(meal.itemId)))
    invalid("Meals require unique known inventory items");
  if (new Set(orders.map(order => order.id)).size !== orders.length || orders.some(order =>
    Object.keys(order.items).some(itemId => !itemIds.has(itemId)) || Object.entries(order.requiredBuildings).some(([buildingId, level]) =>
      !buildingIds.has(buildingId) || !catalog.buildings.find(building => building.id === buildingId)?.levels.some(spec => spec.level === level))))
    invalid("Orders require unique ids, known goods and known building requirements");
  const compositions = orders.map(order => JSON.stringify(Object.entries(order.items).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  if (new Set(compositions).size !== compositions.length) invalid("Resident orders require distinct item compositions");
  if (catalog.food && !orders.some(order => order.requiredHomeLevel === 1 && Object.keys(order.requiredBuildings).length === 0))
    invalid("New players need at least one eligible order");
  if (catalog.recipes.some(recipe => recipe.fishInput && (recipe.fishInput.itemIds.some(itemId => !itemIds.has(itemId) || !fishIds.has(itemId))
    || Object.keys(recipe.cost.items).filter(itemId => fishIds.has(itemId)).length !== 1)))
    invalid("Fish recipe choices must reference catalog fish");
});
export const economyCatalog = economyCatalogSchema.parse(catalogJson);

/** Keep the positive wire level readable by older clients; the flag opens only the existing base fire. */
export function recipeBuildingLevel(recipe: { id?: string; buildingId: string; buildingLevel: number; baseCampfire?: boolean }): number {
  return recipe.baseCampfire === true && recipe.id === "cook_grilled_fish" && recipe.buildingId === "dryer" && recipe.buildingLevel === 1
    ? 0 : recipe.buildingLevel;
}
export const economyBookCollectionSchema = z.object({
  finds: z.array(id).max(100).prefault([]), travelSeconds: count.max(ECONOMY_MAX_ITEMS).prefault(0), quarrySeconds: count.max(ECONOMY_MAX_ITEMS).prefault(0),
}).prefault({ finds: [], travelSeconds: 0, quarrySeconds: 0 });
export const economyProgressionSchema = z.object({
  routes: quantities.prefault({}), recipes: quantities.prefault({}), collections: economyBookCollectionSchema,
}).prefault({ routes: {}, recipes: {}, collections: { finds: [], travelSeconds: 0, quarrySeconds: 0 } });
export const economyMigrationSchema = z.object({ version: z.literal(1), coinsGranted: count.max(5000), woodGranted: count.max(30), stoneGranted: count.max(30) });
export const economyJobSchema = z.object({
  id: uuid, kind: z.enum(["production", "exploration", "construction"]), targetId: id,
  recipeId: id.nullable(), targetLevel: count.nullable(), startedAt: z.string().datetime(), finishesAt: z.string().datetime(),
  rewards: quantities, cost: economyCostSchema, catalogVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(9), z.literal(10), z.literal(11), z.literal(12), z.literal(13), z.literal(14)]),
  actorId: z.enum(["mochlik", "miner"]).nullish(),
  collection: economyCollectionSchema.nullish(),
  fishing: z.object({ rodId: id, hookId: id.prefault("bare_hook"), baitId: id.nullable(), fishId: id,
    catchRevealed: z.boolean().nullish() }).nullish(),
  fishStockCost: quantities.nullish(),
  // Private server delivery; public projections never expose even a completed draw.
  expeditionFinds: z.record(id, count.positive().max(ECONOMY_MAX_ITEMS)).nullish(),
  rareDrop: economyRareDropDeliverySchema.nullish(),
  tradeSpeedBps: count.max(1000).optional(),
  meal: z.object({ itemId: id, consumer: z.enum(["hero", "builder"]), speedBps: count.max(10000), workSeconds: count.positive().max(31_536_000).optional() }).nullish(),
}).refine(job => !job.meal?.workSeconds || job.meal.consumer === "hero", "Only hero meals have active work")
  .refine(job => !job.expeditionFinds || job.kind === "exploration", "Finds belong to an exploration")
  .refine(job => !job.actorId || job.kind === "exploration", "Only exploration jobs have a saved actor")
  .refine(job => !job.tradeSpeedBps || job.kind === "construction" || job.kind === "production" && job.targetId === "woodlot"
    || job.kind === "exploration" && job.actorId === "miner", "Resident speed belongs only to their saved professional work")
  .refine(job => !job.collection || job.kind === "production" && job.targetId === "garden" && hasGardenBerryReward(job.rewards),
  "Berry collection requires a garden production order")
  .refine(job => !job.rareDrop || job.kind === "exploration" && (!job.rareDrop.itemId || job.rewards[job.rareDrop.itemId] === 1),
    "Rare materials belong to a saved exploration delivery")
  .refine(job => !job.meal || job.meal.consumer === "hero" && job.kind === "exploration"
    || job.meal.consumer === "builder" && job.kind === "construction",
    "Meal bonuses belong to their consumer's saved work");
export const economyStorageSchema = z.object({ capacity: count, used: count, reserved: count, available: count, overflow: count });
export const economyViewSchema = z.object({
  ownerPublicId: z.string().min(1).max(40), revision: count, serverTime: z.string().datetime(),
  currencyScale: z.literal(10).prefault(10), pearlScale: z.literal(50).prefault(50),
  wallet: z.object({ coins: balance, pearls: count.max(ECONOMY_MAX_PEARLS) }), inventory: quantities, buildings: z.record(id, count.max(100)),
  productionSlots: z.record(id, count.min(1).max(3)).prefault({}),
  marketSlots: count.min(5).max(10).prefault(5), unlockedItems: z.array(id).max(1000).refine(items => new Set(items).size === items.length).prefault([]),
  workshopStarterClaimed: z.boolean().prefault(false), tutorialOrder: economyTutorialOrderSchema, stageOrders: economyStageOrdersSchema,
  jobs: z.array(economyJobSchema).max(100), migration: economyMigrationSchema, catalog: economyCatalogSchema,
  fishingShop: economyFishingShopSchema.nullable().prefault(null), leaftailShop: economyLeaftailShopSchema,
  wardrobe: z.array(id).max(100).prefault(["moss", "amber_scarf"]),
  completedExplorations: count, storage: economyStorageSchema, fishing: economyFishingSchema, progression: economyProgressionSchema,
  food: economyFoodSchema, residentOrders: economyResidentOrdersSchema, tradeRelations: economyTradeRelationsSchema,
});
const commandBase = {
  requestId: uuid, ownerPublicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/), expectedRevision: count.max(Number.MAX_SAFE_INTEGER - 1), targetId: id,
  quantity: z.number().int().min(1).max(10_000).prefault(1), totalPrice: balance.prefault(0),
};
export const economyCommandSchema = z.object({ ...commandBase,
  action: z.enum(["start_production", "start_tutorial_harvest", "cancel_production", "buy_production_slot", "buy_market_slot", "start_collection", "start_garden_collection", "claim_garden_collection", "claim_production", "start_exploration", "cancel_exploration", "start_construction", "start_tutorial_workshop", "speedup_construction", "claim_job", "claim_workshop_starter", "claim_tutorial_order", "sell", "buy_fishing_item", "buy_wardrobe_item", "buy_leaftail_item", "refresh_fishing_shop", "sell_fish", "equip_fishing_rod", "equip_fishing_hook", "equip_fishing_bait", "start_fishing", "eat_food", "feed_builder", "cancel_meal", "complete_resident_order", "replace_resident_order", "accept_weekly_order"]),
  fishSelection: quantities.nullish(),
}).strict();
export const marketCommandSchema = z.object({ ...commandBase,
  action: z.enum(["create_listing", "buy_listing", "cancel_listing", "claim_sale"]),
  fishSelection: quantities.nullish(),
}).strict();
export const economyMarketListingSchema = z.object({
  id: uuid, sellerPublicId: z.string().min(1), sellerName: z.string(), itemId: id,
  quantity: z.number().int().min(1).max(99), totalPrice: balance.positive(), status: z.enum(["active", "sold", "cancelled"]),
  createdAt: z.string().datetime(), closedAt: z.string().datetime().nullable(), owned: z.boolean(), feeBps: count.max(10000).prefault(0),
  sale: z.object({
    buyerPublicId: z.string().min(1).max(40).nullable(), buyerName: z.string().min(1).max(100),
    buyerAvatarUrl: z.string().url().nullable(), proceedsCoins: balance, claimedAt: z.string().datetime().nullable(),
    buyerKind: z.enum(["player", "world_character"]).optional(), buyerCharacterId: z.literal("berest").nullable().optional(),
  }).strict().superRefine((sale, context) => {
    if (sale.buyerKind === "world_character" && (sale.buyerCharacterId !== "berest" || sale.buyerPublicId !== null || sale.buyerAvatarUrl !== null))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["buyerCharacterId"], message: "World characters cannot impersonate a player" });
    if (sale.buyerKind !== "world_character" && sale.buyerCharacterId != null)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["buyerCharacterId"], message: "Player sales cannot name a world character" });
  }).nullish(),
});
export const marketViewSchema = z.object({
  ownerPublicId: z.string().min(1).max(40),
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
export type EconomyFood = z.infer<typeof economyFoodSchema>;
export type EconomyResidentOrders = z.infer<typeof economyResidentOrdersSchema>;
export type EconomyTradeRelations = z.infer<typeof economyTradeRelationsSchema>;
export type EconomyWeeklyOrder = z.infer<typeof economyWeeklyOrderSchema>;
export type EconomyState = Pick<EconomyView, "wallet" | "inventory" | "buildings" | "jobs" | "migration" | "completedExplorations" | "fishing" | "progression"> & { marketSlots?: number; unlockedItems?: string[]; itemUnlockVersion?: 0 | 1; tutorialOrder?: EconomyTutorialOrder; stageOrders?: EconomyStageOrders; workshopStarterClaimed?: boolean; productionSlots?: Record<string, number>; wardrobe?: string[]; currencyScale?: 1 | 10; pearlScale?: 1 | 10 | 50; fishingShop?: EconomyFishingShop | null; leaftailShop?: EconomyLeaftailShop; fishingCastSeed?: string | null; rareDropState?: EconomyRareDropClock | null; minerRareDropState?: EconomyRareDropClock | null; food?: EconomyFood; residentOrders?: EconomyResidentOrders; tradeRelations?: EconomyTradeRelations };

export type EconomyFishing = z.infer<typeof economyFishingSchema>;
export type EconomyFishingCatalog = z.infer<typeof economyFishingCatalogSchema>;
