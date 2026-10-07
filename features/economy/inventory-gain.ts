import type { EconomyCommand, EconomyResult, EconomyView, MarketCommand } from "./model";

export type InventoryGain = Readonly<{
  id: string; ownerPublicId: string; revision: number; source: "claim" | "purchase";
  /** Only an accepted production claim can celebrate at a map station. */
  stationId?: string;
  items: readonly Readonly<{ itemId: string; quantity: number }>[];
}>;
export const INVENTORY_GAIN_HISTORY_LIMIT = 8;

/** A newer inventory alone is not a reward. Require the exact accepted command
 * revision and its known outputs, then show only the confirmed positive delta.
 * A restored receipt whose changes are already loaded cannot replay a payout. */
export function inventoryGainFromReceipt(before: EconomyView | null, result: EconomyResult,
  command: EconomyCommand | MarketCommand): InventoryGain | null {
  const after = result.state;
  if (!before || before.ownerPublicId !== after.ownerPublicId || command.ownerPublicId !== after.ownerPublicId
    || command.expectedRevision !== before.revision || result.acceptedRevision !== before.revision + 1
    || after.revision !== result.acceptedRevision || !before.inventory || !after.inventory) return null;
  let allowed: Record<string, number>, source: InventoryGain["source"], stationId: string | undefined;
  if (command.action === "claim_job") {
    const job = before.jobs.find(item => item.id === command.targetId);
    if (!job || job.kind === "construction" || after.jobs.some(item => item.id === job.id)) return null;
    allowed = job.rewards; source = "claim";
    if (job.kind === "production" && after.catalog.buildings.some(station => station.id === job.targetId)) stationId = job.targetId;
  } else if (command.action === "buy_fishing_item") {
    const offer = before.fishingShop?.offers.find(item => item.id === command.targetId && item.kind === "bait");
    if (!offer || !before.catalog.fishing?.baits.some(item => item.itemId === offer.itemId)) return null;
    allowed = { [offer.itemId]: command.quantity }; source = "purchase";
  } else if (command.action === "buy_listing") {
    const listing = result.listing;
    if (!listing || listing.id !== command.targetId || listing.status !== "sold") return null;
    allowed = { [listing.itemId]: listing.quantity }; source = "purchase";
  } else return null;
  const known = new Set(after.catalog.items.map(item => item.id));
  const items = Object.entries(allowed).flatMap(([itemId, limit]) => {
    const previous = before.inventory[itemId] ?? 0, current = after.inventory[itemId] ?? 0;
    if (!known.has(itemId) || ![previous, current, limit].every(value => Number.isSafeInteger(value) && value >= 0)) return [];
    const quantity = Math.min(limit, current - previous);
    return quantity > 0 ? [Object.freeze({ itemId, quantity })] : [];
  });
  return items.length ? Object.freeze({ id: command.requestId, ownerPublicId: after.ownerPublicId,
    revision: result.acceptedRevision, source, ...(stationId ? { stationId } : {}), items: Object.freeze(items) }) : null;
}
