import { z } from "zod";
import { adminRequest, type AdminRevokeRequest } from "./admin-api";
import { playerMessageSchema, type DeliveryOptions } from "./admin-delivery-contract";

/** Currency quantities here are visible whole units; the server converts pearls. */
export type AdminEconomyGrant = AdminRevokeRequest & DeliveryOptions & {
  coins: number;
  pearls: number;
  items: Record<string, number>;
  buildings: Record<string, number>;
  productionSlots: Record<string, number>;
  rods: string[];
  hooks: string[];
};

const positive = z.number().int().positive().max(10_000);
export const adminEconomyGrantSchema = z.object({
  requestId: z.guid(), confirmationPublicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/),
  reason: z.string().min(8).max(240), coins: z.number().int().min(0).max(1_000_000_000), pearls: z.number().int().min(0).max(1_000_000_000),
  items: z.record(z.string().min(1).max(80), positive), buildings: z.record(z.string().min(1).max(80), positive),
  productionSlots: z.record(z.string().min(1).max(80), z.number().int().min(2).max(3)),
  rods: z.array(z.string().min(1).max(80)).max(100), hooks: z.array(z.string().min(1).max(80)).max(100),
  delivery: z.enum(["silent", "notify"]).optional(), playerMessage: playerMessageSchema.optional(),
}).strict().refine(value => value.delivery === "notify" || value.playerMessage === undefined, "Silent grants cannot contain a player message");

export const adminEconomyReceiptSchema = z.object({
  requestId: z.guid(), publicId: z.string(), changed: z.boolean(),
  acceptedRevision: z.number().int().nonnegative().safe(), createdAt: z.string().datetime(),
});

export function grantAdminEconomy(target: string, body: AdminEconomyGrant, signal?: AbortSignal) {
  return adminRequest(`users/${encodeURIComponent(target)}/grant-economy`, adminEconomyReceiptSchema.refine(value => value.requestId === body.requestId && value.publicId === target,
    "Grant receipt must match the request and recipient"), signal, body);
}
