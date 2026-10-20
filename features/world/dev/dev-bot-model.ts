import { z } from "zod";
import { economyCatalog, economyCommandSchema, economyMarketListingSchema, economyViewSchema } from "@/features/economy/domain/model";
import { worldCatalog } from "@/features/world/domain/model";
import { isValidDisplayName } from "@/lib/check-in-presentation";

const uuid = economyCommandSchema.shape.requestId;
const publicId = economyCommandSchema.shape.ownerPublicId;
const name = z.string().max(100).refine(isValidDisplayName, "Введите имя до 50 символов");
const homeLevel = z.number().int().min(1).max(5);
const itemId = z.string().min(1).max(80);
const botId = { botId: uuid };
const base = { ownerPublicId: publicId, requestId: uuid };
const sharingMode = z.enum(["LATEST_ONLY", "OFF"]);
const earthMode = z.enum(["OFF", "SHARING", "GHOST"]);
const earthPrecision = z.enum(["APPROXIMATE", "PRECISE"]);
const earthDuration = z.union([z.literal(60), z.literal(480)]).nullable();
const earthPosition = z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  accuracyMeters: z.number().finite().min(0).max(100_000) }).strict();

/** Local DEV commands are never accepted by the production game API. Currency amounts use stored units. */
export const devBotCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("create"), displayName: name, homeLevel }).strict(),
  z.object({ ...base, ...botId, action: z.literal("rename"), displayName: name }).strict(),
  z.object({ ...base, ...botId, action: z.literal("set_home"), homeLevel }).strict(),
  z.object({ ...base, ...botId, action: z.literal("set_building"), buildingId: itemId, level: z.number().int().min(0).max(10) }).strict(),
  z.object({ ...base, ...botId, action: z.literal("equip"), slot: z.enum(["palette", "head", "neck", "rod"]), itemId: itemId.nullable() }).strict(),
  z.object({ ...base, ...botId, action: z.literal("grant_currency"), currency: z.enum(["coins", "pearls"]), quantity: z.number().int().min(1).max(10_000_000) }).strict(),
  z.object({ ...base, ...botId, action: z.literal("grant_item"), itemId, quantity: z.number().int().min(1).max(1_000_000) }).strict(),
  z.object({ ...base, ...botId, action: z.literal("create_listing"), itemId, quantity: z.number().int().min(1).max(99), totalPrice: economyCommandSchema.shape.totalPrice }).strict(),
  z.object({ ...base, ...botId, action: z.literal("cancel_listing"), listingId: uuid }).strict(),
  z.object({ ...base, ...botId, action: z.literal("buy_listing"), listingId: uuid }).strict(),
  z.object({ ...base, ...botId, action: z.literal("claim_sale"), listingId: uuid }).strict(),
  z.object({ ...base, ...botId, action: z.literal("finish_jobs") }).strict(),
  z.object({ ...base, ...botId, action: z.literal("start_job"), kind: z.enum(["construction", "production", "exploration"]), targetId: itemId }).strict(),
  z.object({ ...base, ...botId, action: z.literal("claim_job"), jobId: uuid }).strict(),
  z.object({ ...base, ...botId, action: z.literal("set_sharing"), sharingMode }).strict(),
  z.object({ ...base, ...botId, action: z.literal("set_earth_sharing"), mode: earthMode, precision: earthPrecision, durationMinutes: earthDuration }).strict(),
  z.object({ ...base, ...botId, action: z.literal("set_earth_position"), ...earthPosition.shape }).strict(),
  z.object({ ...base, ...botId, action: z.literal("check_in") }).strict(),
  z.object({ ...base, ...botId, action: z.literal("delete") }).strict(),
]).superRefine((command, context) => {
  const invalid = (path: string) => context.addIssue({ code: "custom", path: [path], message: "Неизвестный предмет или уровень" });
  if (command.action === "grant_item" || command.action === "create_listing") {
    if (!economyCatalog.items.some(item => item.id === command.itemId && (command.action !== "create_listing" || item.tradable))) invalid("itemId");
  } else if (command.action === "set_building") {
    const building = economyCatalog.buildings.find(item => item.id === command.buildingId);
    if (!building || command.level === 0 && ["home", "warehouse"].includes(building.id)
      || command.level > 0 && !building?.levels.some(level => level.level === command.level)) invalid("level");
  } else if (command.action === "equip") {
    if (command.itemId === null ? command.slot === "palette" : !worldCatalog.items.some(item => item.id === command.itemId && item.slot === command.slot)) invalid("itemId");
  }
});

export const devBotSchema = z.object({
  id: uuid, publicId, displayName: name, circleId: uuid, sharingMode, createdAt: z.string().datetime(),
  lastCheckInAt: z.string().datetime().nullable().default(null),
  earth: z.object({ mode: earthMode, precision: earthPrecision, sharingUntil: z.string().datetime().nullable(),
    position: earthPosition.nullable(), sharedUpdatedAt: z.string().datetime().nullable(), sharedExpiresAt: z.string().datetime().nullable(),
    nextPublishAt: z.string().datetime().nullable() }).strict().default({ mode: "OFF", precision: "APPROXIMATE", sharingUntil: null,
    position: null, sharedUpdatedAt: null, sharedExpiresAt: null, nextPublishAt: null }),
  economy: economyViewSchema.pick({ revision: true, buildings: true, wallet: true, inventory: true, jobs: true, storage: true }).strict(),
  equipment: z.object({ palette: itemId, head: itemId.nullable(), neck: itemId.nullable(), rod: itemId.nullable() }).strict(),
  listings: z.array(economyMarketListingSchema).max(10),
}).strict();
export const devBotsSnapshotSchema = z.object({
  ownerPublicId: publicId, serverTime: z.string().datetime(), maxBots: z.literal(5), bots: z.array(devBotSchema).max(5),
  ownListings: z.array(economyMarketListingSchema).max(10).default([]),
}).strict();
export const devBotResultSchema = z.object({ snapshot: devBotsSnapshotSchema, botId: uuid, message: z.string().max(500), replayed: z.boolean() }).strict();
export type DevBot = z.infer<typeof devBotSchema>;
export type DevBotCommand = z.infer<typeof devBotCommandSchema>;
type WithoutIdentity<T> = T extends unknown ? Omit<T, "ownerPublicId" | "requestId"> : never;
export type DevBotAction = WithoutIdentity<DevBotCommand>;
export type DevBotsSnapshot = z.infer<typeof devBotsSnapshotSchema>;
export type DevBotResult = z.infer<typeof devBotResultSchema>;
