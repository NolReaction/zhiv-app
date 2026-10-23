import { z } from "zod";
import defaults from "@/apps/api/src/main/resources/world/neighbor-catalog.json";
import wardrobeCatalog from "@/apps/api/src/main/resources/world/catalog.json";
import { hasUserTextControls } from "@/lib/user-text";
import { ECONOMY_MAX_BALANCE, economyCatalog, economyResultSchema } from "./model";

const count = z.number().int().nonnegative().safe();
const clock = z.string().datetime();
const uuid = z.string().uuid().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const publicId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
const itemId = z.string().min(1).max(128);
const buildingIds = new Map(economyCatalog.buildings.map(building => [building.id, Math.max(...building.levels.map(level => level.level))]));
const clothing = (slot: string) => z.string().refine(id => wardrobeCatalog.items.some(item => item.id === id && item.slot === slot), "Неизвестный предмет гардероба");

export const neighborEquipmentSchema = z.object({
  palette: clothing("palette"), head: clothing("head").nullable(), neck: clothing("neck").nullable(),
  rod: clothing("rod").nullable(),
}).strict();
export const neighborBuildingsSchema = z.record(z.string().refine(id => buildingIds.has(id)), count.max(100))
  .refine(buildings => Object.entries(buildings).every(([id, level]) => level <= buildingIds.get(id)!), "Уровень постройки вне каталога");

/** Relics, individual fish species and legacy fish aliases cannot enter the NPC stock. */
export const neighborStockItems = economyCatalog.items.filter(item => item.tradable && item.category !== "special"
  && item.baseSellPrice > 0 && !item.id.startsWith("fish"));
const stockIds = new Set(neighborStockItems.map(item => item.id));
export const neighborSettingsSchema = z.object({
  enabled: z.boolean(), autoBuyEnabled: z.boolean(),
  name: z.string().min(1).max(40).refine(value => value === value.trim() && !hasUserTextControls(value)),
  description: z.string().min(1).max(240).refine(value => value.trim().length > 0 && !hasUserTextControls(value)),
  buildings: neighborBuildingsSchema, equipment: neighborEquipmentSchema,
  offerSlots: count.min(1).max(3), offerQuantity: count.min(1).max(5),
  allowedItemIds: z.array(itemId.refine(id => stockIds.has(id), "Этот предмет недоступен соседу")).min(1).max(100)
    .refine(items => new Set(items).size === items.length, "Предметы не должны повторяться"),
  sellPriceBps: count.min(10000).max(20000), buyPriceBps: count.min(5000).max(10000),
  firstDelaySeconds: count.min(180).max(86400), staleAfterSeconds: count.min(21600).max(604800),
  maxLotsPerDay: count.max(2), dailyBudgetCoins: count.max(300), maxLotCoins: count.max(150), globalDailyBudgetCoins: count.max(10000),
  activeFromHourUtc: count.max(23), activeUntilHourUtc: count.min(1).max(24),
}).strict().superRefine((settings, context) => {
  if (settings.maxLotCoins > settings.dailyBudgetCoins)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxLotCoins"], message: "Цена лота больше дневного бюджета" });
  if (settings.activeFromHourUtc === settings.activeUntilHourUtc)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["activeUntilHourUtc"], message: "Начало и конец интервала должны отличаться" });
  if ((settings.buildings.home ?? 0) < 2 || (settings.buildings.bridge ?? 0) < 1)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["buildings"], message: "Для торговли соседу нужны дом 2 и восстановленный мост" });
  if (Object.keys(settings.buildings).length !== buildingIds.size)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["buildings"], message: "Укажите уровни всех построек" });
});
export type NeighborSettings = z.infer<typeof neighborSettingsSchema>;
export const neighborDefaultSettings: NeighborSettings = neighborSettingsSchema.parse(defaults);

export const neighborOfferSchema = z.object({ id: uuid, itemId, quantity: count.min(1).max(99), totalPrice: count.positive(), purchased: z.boolean() }).strict();
export const neighborWorldSchema = z.object({
  buildings: neighborBuildingsSchema, equipment: neighborEquipmentSchema, gifts: z.array(itemId).max(100),
  hiddenGifts: z.array(z.enum(["flower", "leaf_bed", "keepsakes", "leaf_garland"])).max(4), jobs: z.array(z.never()).max(0),
}).strict();
export const neighborViewSchema = z.object({
  ownerPublicId: publicId, serverTime: clock,
  character: z.object({ id: z.literal("berest"), kind: z.literal("world_character"), name: z.string().min(1).max(40), description: z.string().max(240), world: neighborWorldSchema }).strict(),
  shop: z.object({ cycleId: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), refreshAt: clock, available: z.boolean(), reason: z.string().nullable(), offers: z.array(neighborOfferSchema).max(3) }).strict(),
  buying: z.object({ enabled: z.boolean(), firstDelaySeconds: count, staleAfterSeconds: count,
    maxLotsPerDay: count, dailyBudgetCoins: count, maxLotCoins: count, usedLots: count, spentCoins: count }).strict(),
}).strict().superRefine((value, context) => {
  if (value.shop.available !== (value.shop.reason === null))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["shop", "available"], message: "Inconsistent shop availability" });
  if (new Set(value.shop.offers.map(offer => offer.id)).size !== value.shop.offers.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["shop", "offers"], message: "Duplicate offers" });
});
export type NeighborView = z.infer<typeof neighborViewSchema>;
export type NeighborOffer = z.infer<typeof neighborOfferSchema>;
export const neighborCommandSchema = z.object({
  requestId: uuid, ownerPublicId: publicId, expectedRevision: count.max(Number.MAX_SAFE_INTEGER - 1),
  action: z.literal("buy_offer"), targetId: uuid, quantity: count.min(1).max(5), totalPrice: count.positive().max(ECONOMY_MAX_BALANCE),
}).strict();
export const neighborResultSchema = economyResultSchema;
export type NeighborCommand = z.infer<typeof neighborCommandSchema>;
export type NeighborResult = z.infer<typeof neighborResultSchema>;

export const neighborAdminViewSchema = z.object({
  serverTime: clock, settings: neighborSettingsSchema, version: count, pausedReason: z.string().nullable(),
  receipt: z.object({ requestId: uuid, replayed: z.boolean() }).strict().nullable().optional(),
  player: z.object({ publicId, name: z.string() }).strict().nullable(),
  usage: z.object({ usedLots: count, spentCoins: count, globalSpentCoins: count }).strict(),
  pending: z.array(z.object({ id: uuid, sellerPublicId: publicId, sellerName: z.string(), itemId, quantity: count.positive(), totalPrice: count.positive(),
    proceedsCoins: count.optional(), feeCoins: count.optional(), createdAt: clock, eligible: z.boolean(), reason: z.string().nullable() }).strict()
    .refine(row => row.proceedsCoins == null || row.proceedsCoins <= row.totalPrice)
    .refine(row => row.feeCoins == null || row.feeCoins <= row.totalPrice)
    .refine(row => row.proceedsCoins == null || row.feeCoins == null || row.proceedsCoins + row.feeCoins === row.totalPrice)).max(100),
  history: z.array(z.object({ id: uuid, listingId: uuid, sellerPublicId: publicId, itemId, quantity: count.positive(), totalPrice: count.positive(), proceedsCoins: count,
    createdAt: clock, source: z.enum(["auto", "manual"]), requestId: uuid.optional() }).strict().refine(row => row.proceedsCoins <= row.totalPrice)).max(50),
}).strict();
export type NeighborAdminView = z.infer<typeof neighborAdminViewSchema>;
const adminRequest = { requestId: uuid, reason: z.string().refine(value => !hasUserTextControls(value)).transform(value => value.trim()).pipe(z.string().min(8).max(240)) };
export const neighborAdminSettingsCommandSchema = z.object({ ...adminRequest, expectedVersion: count, settings: neighborSettingsSchema }).strict();
export const neighborAdminBuyCommandSchema = z.object({ ...adminRequest, listingId: uuid, playerPublicId: publicId, expectedTotalPrice: count.positive() }).strict();
export type NeighborAdminSettingsCommand = z.infer<typeof neighborAdminSettingsCommandSchema>;
export type NeighborAdminBuyCommand = z.infer<typeof neighborAdminBuyCommandSchema>;
