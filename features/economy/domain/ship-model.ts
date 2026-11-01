import { z } from "zod";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_ITEMS, ECONOMY_MAX_PEARLS } from "./money";

const count = z.number().int().nonnegative().safe();
const uuid = z.string().uuid();
const items = z.record(z.string().min(1).max(80), count.positive().max(ECONOMY_MAX_ITEMS))
  .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 8);
export const shipOrderSchema = z.object({
  id: z.string().min(1).max(80), templateId: z.string().min(1).max(80), title: z.string().min(1).max(120),
  items, rewardCoins: count.positive().max(ECONOMY_MAX_BALANCE), deliveredAt: z.string().datetime().nullable(),
});
export const shipVoyageSchema = z.object({
  id: uuid, number: count.positive(), openedAt: z.string().datetime(),
  orders: z.array(shipOrderSchema).length(3), rewardPearls: count.max(ECONOMY_MAX_PEARLS),
}).refine(value => value.orders.every((order, index) => order.id === `${value.id}:${index}`)
  && new Set(value.orders.map(order => order.templateId)).size === 3, "Ship orders must belong to this voyage");
export const economyShipSchema = z.object({
  voyage: shipVoyageSchema.nullable().prefault(null), completedVoyages: count.prefault(0),
  nextAvailableAt: z.string().datetime().nullable().prefault(null),
}).prefault({ voyage: null, completedVoyages: 0, nextAvailableAt: null });
export type EconomyShip = z.infer<typeof economyShipSchema>;
export type ShipVoyage = z.infer<typeof shipVoyageSchema>;
export type ShipOrder = z.infer<typeof shipOrderSchema>;

export const shipOrdersConfigSchema = z.object({
  version: z.literal(1), intervalSeconds: count.min(3600).max(86400), rewardPearls: count.positive().max(40),
  rewardValueCoins: count.positive().max(ECONOMY_MAX_BALANCE), maxRewardPearls: count.positive().max(40),
  payoutBps: count.min(10000).max(11000),
  templates: z.array(z.object({
    id: z.string().min(1).max(60), group: z.enum(["supplies", "provisions", "craft"]), title: z.string().min(1).max(120),
    requiredHomeLevel: count.min(1).max(5), requiredBuildings: z.record(z.string(), count.positive().max(5)), items,
  })).min(3).max(100),
}).refine(value => value.maxRewardPearls >= value.rewardPearls && value.rewardPearls % 2 === 0 && value.maxRewardPearls % 2 === 0
  && new Set(value.templates.map(template => template.id)).size === value.templates.length
  && ["supplies", "provisions", "craft"].every(group => value.templates.some(template => template.group === group)));
