import { z } from "zod";
import { neighborAdminBuyCommandSchema, neighborAdminSettingsCommandSchema } from "@/features/economy/domain/neighbor-model";

const selectionSchema = z.object({
  id: z.guid(), sellerPublicId: z.string(), sellerName: z.string(), itemId: z.string(),
  quantity: z.number().int().positive(), totalPrice: z.number().int().nonnegative(),
  proceedsCoins: z.number().int().nonnegative(),
});
export const neighborAttemptSchema = z.union([
  z.object({ kind: z.literal("settings"), body: neighborAdminSettingsCommandSchema }),
  z.object({ kind: z.literal("buy"), body: neighborAdminBuyCommandSchema, selection: selectionSchema }).refine(value =>
    value.body.listingId === value.selection.id && value.body.playerPublicId === value.selection.sellerPublicId
    && value.body.expectedTotalPrice === value.selection.totalPrice && value.selection.proceedsCoins <= value.selection.totalPrice),
]);
export type NeighborAttempt = z.infer<typeof neighborAttemptSchema>;
const key = (actor: string) => `zhiv:admin-neighbor:${actor}:berest`;

/** Keep a confirmed request unchanged across reloads; never share it between administrators. */
export function readNeighborAttempt(actor: string): NeighborAttempt | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key(actor));
    if (!raw) return null;
    const parsed = neighborAttemptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function saveNeighborAttempt(actor: string, request: NeighborAttempt | null): boolean {
  try {
    if (request) window.sessionStorage.setItem(key(actor), JSON.stringify(request));
    else window.sessionStorage.removeItem(key(actor));
    return true;
  } catch { return false; }
}
