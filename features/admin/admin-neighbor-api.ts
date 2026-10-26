import { z } from "zod";
import {
  neighborAdminBuyCommandSchema, neighborAdminSettingsCommandSchema, neighborAdminViewSchema,
} from "@/features/economy/domain/neighbor-model";
import { ApiError } from "@/lib/check-in-api";
import { adminRequest, verifyAdminActor } from "./admin-api";

export type AdminNeighborView = z.infer<typeof neighborAdminViewSchema>;
export type AdminNeighborBuy = z.infer<typeof neighborAdminBuyCommandSchema>;
export type AdminNeighborSettings = z.infer<typeof neighborAdminSettingsCommandSchema>;
const resultSchema = neighborAdminViewSchema.extend({
  receipt: z.object({ requestId: z.guid(), replayed: z.boolean() }),
});

export async function loadAdminNeighbor(actor: string, target: string, signal: AbortSignal) {
  await verifyAdminActor(actor, signal);
  const query = target ? `?${new URLSearchParams({ publicId: target })}` : "";
  const data = await adminRequest(`neighbor${query}`, neighborAdminViewSchema, signal);
  await verifyAdminActor(actor, signal);
  if ((data.player?.publicId ?? "") !== target || data.pending.some(lot => lot.sellerPublicId !== target)) {
    throw new ApiError("Ответ относится к другому игроку. Обновите данные.", 502);
  }
  return data;
}

export async function writeAdminNeighbor(actor: string, kind: "settings" | "buy", body: AdminNeighborSettings | AdminNeighborBuy, signal: AbortSignal) {
  await verifyAdminActor(actor, signal);
  const data = await adminRequest(`neighbor/${kind}`, resultSchema.refine(value => value.receipt.requestId === body.requestId
    && (kind !== "buy" || ("playerPublicId" in body && value.player?.publicId === body.playerPublicId
      && value.pending.every(lot => lot.sellerPublicId === body.playerPublicId))),
    "Neighbor receipt must match the immutable request"), signal, body);
  await verifyAdminActor(actor, signal);
  return data;
}

// Only explicit server rejections allow replacing an uncertain operation with a new UUID.
export function definitiveNeighborFailure(cause: unknown) {
  return cause instanceof ApiError && [400, 404, 409, 422].includes(cause.status)
    && !!cause.body && "code" in cause.body && new Set([
      "INVALID_NEIGHBOR_SETTINGS", "NEIGHBOR_VERSION_CONFLICT", "NEIGHBOR_LISTING_UNAVAILABLE",
      "INVALID_NEIGHBOR_BUY", "NEIGHBOR_QUOTE_CHANGED", "NEIGHBOR_PLAYER_NOT_FOUND", "INVALID_NEIGHBOR_PLAYER",
    ]).has(cause.body.code);
}
