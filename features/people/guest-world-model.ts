import { z } from "zod";
import { economyCatalog, economyMarketListingSchema } from "@/features/economy/domain/model";

const publicId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
const count = z.number().int().nonnegative().safe();
const itemId = z.string().min(1).max(128);
const clock = z.string().datetime();
const buildingIds = new Set(economyCatalog.buildings.map(building => building.id));

/** Only visible scenery and work clocks cross the friendship boundary. */
export const guestWorldSchema = z.object({
  ownerPublicId: publicId,
  circleId: z.string().uuid(),
  user: z.object({ publicId, displayName: z.string().min(1).max(100) }).strict(),
  serverTime: clock,
  world: z.object({
    buildings: z.record(z.string().refine(id => buildingIds.has(id)), count.max(100)),
    equipment: z.object({ palette: itemId, head: itemId.nullable(), neck: itemId.nullable(), rod: itemId.nullable() }).strict(),
    gifts: z.array(itemId).max(100),
    hiddenGifts: z.array(z.enum(["flower", "leaf_bed", "keepsakes", "leaf_garland"])).max(4),
    jobs: z.array(z.object({
      id: z.string().uuid(),
      kind: z.enum(["construction", "production", "exploration"]),
      targetId: itemId,
      recipeId: itemId.nullable(),
      targetLevel: count.max(100).nullable(),
      startedAt: clock,
      finishesAt: clock,
      collection: z.object({ kind: z.literal("berry_harvest"), seconds: count,
        startedAt: clock.nullable(), finishesAt: clock.nullable() }).strict().nullable(),
      actorId: z.enum(["mochlik", "miner"]).nullable(),
    }).strict()).max(100).refine(jobs => new Set(jobs.map(job => job.id)).size === jobs.length),
  }).strict(),
  market: z.object({
    listings: z.array(economyMarketListingSchema.strict()).max(10),
    available: z.boolean(),
    reason: z.enum(["buyer_locked", "seller_locked", "home_band"]).nullable(),
  }).strict(),
}).strict().superRefine((visit, context) => {
  if (visit.user.publicId === visit.ownerPublicId)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["user", "publicId"], message: "A visit needs another player" });
  if (visit.market.available !== (visit.market.reason === null))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["market", "available"], message: "Inconsistent storefront availability" });
  const ids = new Set<string>();
  for (const [index, listing] of visit.market.listings.entries()) {
    if (listing.sellerPublicId !== visit.user.publicId || listing.owned || listing.status !== "active" || ids.has(listing.id))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["market", "listings", index], message: "Invalid owner's listing" });
    ids.add(listing.id);
  }
});

export type GuestWorld = z.infer<typeof guestWorldSchema>;
export type GuestWorldTarget = { circleId: string; targetPublicId: string; displayName: string };
