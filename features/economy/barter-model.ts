import { z } from "zod";
import { economyCommandSchema, economyViewSchema, type EconomyView } from "./model";

export const BARTER_HOME_LEVEL = 3;
export const BARTER_MAX_OFFERS = 3;
const base = {
  requestId: economyCommandSchema.shape.requestId,
  ownerPublicId: economyCommandSchema.shape.ownerPublicId,
  expectedRevision: economyCommandSchema.shape.expectedRevision,
};
const itemId = economyCommandSchema.shape.targetId;
const uuid = economyCommandSchema.shape.requestId;
export const barterCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("create_offer"), offeredItemId: itemId, requestedItemId: itemId }).strict(),
  z.object({ ...base, action: z.literal("accept_offer"), offerId: uuid }).strict(),
  z.object({ ...base, action: z.literal("cancel_offer"), offerId: uuid }).strict(),
]).superRefine((command, context) => {
  if (command.action === "create_offer" && command.offeredItemId === command.requestedItemId) {
    context.addIssue({ code: "custom", path: ["requestedItemId"], message: "Выберите другой особый материал" });
  }
});
export const barterOfferSchema = z.object({
  id: uuid, sellerPublicId: z.string().min(1).max(40), sellerName: z.string().max(100),
  offeredItemId: itemId, requestedItemId: itemId,
  status: z.enum(["active", "exchanged", "cancelled"]),
  createdAt: z.string().datetime(), closedAt: z.string().datetime().nullable(), owned: z.boolean(),
});
export const barterViewSchema = z.object({
  ownerPublicId: z.string().min(1).max(40), offers: z.array(barterOfferSchema).max(6), mine: z.array(barterOfferSchema).max(BARTER_MAX_OFFERS),
  serverTime: z.string().datetime(), showcase: z.object({
    refreshAt: z.string().datetime(), slots: z.literal(6), maxPerSeller: z.literal(1), refreshSeconds: z.literal(1800),
  }),
});
export const barterResultSchema = z.object({
  state: economyViewSchema, message: z.string(), acceptedRevision: z.number().int().nonnegative().safe(), replayed: z.boolean(),
  // This is the original receipt's offer; a replay may legitimately still say
  // active. The fresh GET, rather than this receipt, describes today's shelf.
  offer: barterOfferSchema,
});
export type BarterCommand = z.infer<typeof barterCommandSchema>;
export type BarterOffer = z.infer<typeof barterOfferSchema>;
export type BarterView = z.infer<typeof barterViewSchema>;
export type BarterResult = z.infer<typeof barterResultSchema>;
export type BarterIntent = BarterCommand extends infer Command ? Command extends BarterCommand ? Omit<Command, keyof typeof base> : never : never;

/** Eligibility comes from the confirmed economy catalog; currencies and
 * ordinary materials never become barter goods just by entering an ID. */
export function barterItems(state: EconomyView) {
  return state.catalog.items.filter(item => item.category === "special" && !item.tradable);
}
