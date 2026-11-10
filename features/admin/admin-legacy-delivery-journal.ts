import { z } from "zod";
import { GAME_ITEMS, GAME_ACHIEVEMENTS } from "@/features/game/game-rewards";
import type { AdminGrantRequest, AdminPlayerCommand } from "./admin-api";
import { playerMessageSchema } from "./admin-delivery-contract";
import { readAdminAttempt, saveAdminAttempt } from "./admin-attempt-journal";
import { validAdminReason } from "./admin-input";

const common = { requestId: z.guid(), confirmationPublicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/),
  reason: z.string().refine(validAdminReason), delivery: z.enum(["silent", "notify"]).optional(), playerMessage: playerMessageSchema.optional() };
const compatible = (value: { delivery?: string; playerMessage?: object }) => value.delivery === "notify" || value.playerMessage === undefined;
const manageSchema = z.object({ ...common, action: z.enum(["grant_world_item", "grant_find"]), target: z.string().min(1).max(80) }).strict().refine(compatible);
const rewardSchema = z.object({ ...common, kind: z.enum(["item", "achievement"]), rewardId: z.string().refine(value => [...GAME_ITEMS, ...GAME_ACHIEVEMENTS].some(item => item.id === value)) }).strict().refine(compatible);
export function readLegacyManageAttempt(actor: string, target: string): AdminPlayerCommand | null {
  const value = readAdminAttempt("manage", actor, target, manageSchema);
  return value?.confirmationPublicId === target ? value : null;
}
export function readLegacyRewardAttempt(actor: string, target: string): AdminGrantRequest | null {
  const value = readAdminAttempt("reward", actor, target, rewardSchema);
  return value?.confirmationPublicId === target ? value as AdminGrantRequest : null;
}
export const saveLegacyManageAttempt = (actor: string, target: string, request: AdminPlayerCommand | null) => saveAdminAttempt("manage", actor, target, request);
export const saveLegacyRewardAttempt = (actor: string, target: string, request: AdminGrantRequest | null) => saveAdminAttempt("reward", actor, target, request);
