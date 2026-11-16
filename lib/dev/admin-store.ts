import type { NeighborAdminSettingsCommand, NeighborAdminBuyCommand } from "@/features/economy/domain/neighbor-model";
import { getDevIdentity } from "./api-store";
import { devAdminAllowed } from "./admin-access";
import { buyDevNeighborListing, getDevAdminNeighbor, DevEconomyError } from "./economy-store";
import { configureDevNeighbor, devNeighborVersion } from "./neighbor-store";

type Audit = { requestId: string; actorPublicId: string; targetPublicId: string; action: "neighbor_settings" | "neighbor_buy"; details: string;
  rewardId: null; granted: null; reason: string; affectedSessions: number; createdAt: string };
type AdminState = { receipts: Map<string, { signature: string; target?: string }>; audit: Audit[] };
const host = globalThis as typeof globalThis & { __zhivDevAdminStore?: AdminState };
const state = (): AdminState => host.__zhivDevAdminStore ??= { receipts: new Map(), audit: [] };
export const resetDevAdminStoreForTests = () => { delete host.__zhivDevAdminStore; };
export function getDevAdminAudit(offset: number, limit: number) {
  const events = [...state().audit].reverse();
  return { serverTime: new Date().toISOString(), total: events.length, offset, limit, events: events.slice(offset, offset + limit) };
}
/** Synchronous shared-memory transaction: no awaits between validation, settlement and receipt. */
export function commandDevAdminNeighbor(token: string, kind: "settings" | "buy", command: NeighborAdminSettingsCommand | NeighborAdminBuyCommand) {
  const actor = getDevIdentity(token);
  if (!actor) throw new DevEconomyError("UNAUTHORIZED", "Войдите в аккаунт", 401);
  if (!devAdminAllowed(token)) throw new DevEconomyError("FORBIDDEN", "Локальный доступ администратора отозван", 403);
  const saved = state(), id = `${actor.user.publicId}:${command.requestId}`, signature = JSON.stringify({ kind, command });
  const replay = saved.receipts.get(id);
  if (replay) {
    if (replay.signature !== signature) throw new DevEconomyError("INVALID_NEIGHBOR_BUY", "Этот запрос уже использован с другими условиями", 409);
    return { ...getDevAdminNeighbor(token, replay.target), receipt: { requestId: command.requestId, replayed: true } };
  }
  let target: string | undefined;
  if (kind === "settings" && "settings" in command) {
    if (devNeighborVersion() !== command.expectedVersion) throw new DevEconomyError("NEIGHBOR_VERSION_CONFLICT", "Настройки уже изменились. Обновите панель", 409);
    configureDevNeighbor(command.settings);
  } else if (kind === "buy" && "listingId" in command) {
    target = command.playerPublicId;
    const view = getDevAdminNeighbor(token, target), lot = view.pending.find(row => row.id === command.listingId.toLowerCase());
    if (!lot || lot.totalPrice !== command.expectedTotalPrice) throw new DevEconomyError("NEIGHBOR_QUOTE_CHANGED", "Лот или его цена изменились. Обновите панель", 409);
    if (!lot.eligible || !buyDevNeighborListing(command.listingId, { manual: true, expectedTotalPrice: command.expectedTotalPrice,
      playerPublicId: target, requestId: command.requestId }))
      throw new DevEconomyError("NEIGHBOR_LISTING_UNAVAILABLE", "Лот недоступен для выкупа. Обновите панель", 409);
  } else throw new DevEconomyError("INVALID_NEIGHBOR_BUY", "Некорректная операция", 400);
  saved.receipts.set(id, { signature, target });
  saved.audit.push({ requestId: command.requestId, actorPublicId: actor.user.publicId, targetPublicId: target ?? actor.user.publicId,
    action: kind === "settings" ? "neighbor_settings" : "neighbor_buy", details: JSON.stringify(command),
    rewardId: null, granted: null, reason: command.reason, affectedSessions: 0, createdAt: new Date().toISOString() });
  return { ...getDevAdminNeighbor(token, target), receipt: { requestId: command.requestId, replayed: false } };
}
