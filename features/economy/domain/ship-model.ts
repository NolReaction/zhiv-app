import { z } from "zod";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_ITEMS, ECONOMY_MAX_PEARLS, PEARL_DISPLAY_DIVISOR } from "./money";

const count = z.number().int().nonnegative().safe();
const uuid = z.string().uuid();
const cargoCounts = z.record(z.string().min(1).max(80), count.positive().max(ECONOMY_MAX_ITEMS));
export const shipDifficultySchema = z.enum(["easy", "medium", "hard"]);
const items = z.record(z.string().min(1).max(80), count.positive().max(ECONOMY_MAX_ITEMS))
  .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 8);
export const shipOrderSchema = z.object({
  id: z.string().min(1).max(80), templateId: z.string().min(1).max(80), title: z.string().min(1).max(120),
  revision: count.max(3).optional(), items, loadedItems: cargoCounts.prefault({}), difficulty: shipDifficultySchema.prefault("medium"), rewardItems: cargoCounts.prefault({}),
  rewardCoins: count.positive().max(ECONOMY_MAX_BALANCE), deliveredAt: z.string().datetime().nullable(),
}).refine(order => Object.entries(order.loadedItems).every(([id, amount]) => amount <= (order.items[id] ?? 0))
  && Object.keys(order.rewardItems).length <= 8, "Loaded cargo must belong to the order")
  .transform(order => order.deliveredAt ? { ...order, loadedItems: { ...order.items } } : order);
export const shipVoyageSchema = z.object({
  id: uuid, number: count.positive(), openedAt: z.string().datetime(),
  replacementsUsed: count.max(3).optional(), orders: z.array(shipOrderSchema).length(3), rewardPearls: count.max(ECONOMY_MAX_PEARLS),
}).refine(value => value.orders.every((order, index) => order.id === `${value.id}:${index}${order.revision ? `:r${order.revision}` : ""}`)
  && new Set(value.orders.map(order => order.templateId)).size === 3, "Ship orders must belong to this voyage")
  .transform(voyage => ({ ...voyage, rewardPearls: 10 * PEARL_DISPLAY_DIVISOR }));
export const economyShipSchema = z.object({
  voyage: shipVoyageSchema.nullable().prefault(null), completedVoyages: count.prefault(0),
  nextAvailableAt: z.string().datetime().nullable().prefault(null),
  resetAvailableAt: z.string().datetime().nullable().optional(),
  departureCargo: z.array(z.number().min(0).max(1)).length(3).nullable().optional(),
}).prefault({ voyage: null, completedVoyages: 0, nextAvailableAt: null });
export type EconomyShip = z.infer<typeof economyShipSchema>;
export type ShipVoyage = z.infer<typeof shipVoyageSchema>;
export type ShipOrder = z.infer<typeof shipOrderSchema>;

export const shipOrdersConfigSchema = z.object({
  version: z.literal(1), staySeconds: count.min(3600).max(172800), resetPricePearls: count.positive().max(1000),
  freeReplacements: z.literal(3), intervalSeconds: count.min(3600).max(86400), rewardPearls: count.positive().max(40),
  rewardValueCoins: count.positive().max(ECONOMY_MAX_BALANCE), maxRewardPearls: count.positive().max(40),
  payoutBps: count.min(10000).max(11000),
  templates: z.array(z.object({
    difficulty: shipDifficultySchema, rewardItems: cargoCounts.prefault({}),
    id: z.string().min(1).max(60), group: z.enum(["supplies", "provisions", "craft"]), title: z.string().min(1).max(120),
    requiredHomeLevel: count.min(1).max(5), requiredBuildings: z.record(z.string(), count.positive().max(5)), items,
  })).min(3).max(100),
}).refine(value => value.maxRewardPearls >= value.rewardPearls && value.rewardPearls % 2 === 0 && value.maxRewardPearls % 2 === 0
  && new Set(value.templates.map(template => template.id)).size === value.templates.length
  && ["easy", "medium", "hard"].every(difficulty => value.templates.some(template => template.difficulty === difficulty)));
