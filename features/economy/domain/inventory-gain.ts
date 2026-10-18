import { fishClassForItem, fishClassInventory } from "./fishing";
import { isMinerJob } from "./actor-availability";
import { hasGardenBerryReward } from "./garden-berries";
import type { EconomyCommand, EconomyJob, EconomyResult, EconomyView, MarketCommand } from "./model";

export type InventoryGainItem = Readonly<{ itemId: string; quantity: number }>;

export type InventoryGain = Readonly<{
  id: string; ownerPublicId: string; revision: number; source: "claim" | "purchase";
  /** Only an accepted production or miner claim can celebrate at a map station. */
  stationId?: string;
  items: readonly InventoryGainItem[];
  /** Saved catch drawings only. Economic stock and every existing consumer keep using items. */
  displayItems?: readonly InventoryGainItem[];
}>;
export const INVENTORY_GAIN_HISTORY_LIMIT = 8;

/** A receipt may replace class drawings with its own actual species. A previous
 * masked snapshot can recover species from the accepted collection delta, but
 * never assign more fish than the confirmed class stock increase. */
function fishingDisplayItems(before: EconomyView, after: EconomyView, job: EconomyJob, items: readonly InventoryGainItem[]) {
  const catalog = after.catalog.fishing;
  if (!job.fishing || !catalog) return undefined;
  const classes = new Map(catalog.classes.map(group => [group.itemId, group]));
  const species = new Map(catalog.fish.map(fish => [fish.itemId, fish]));
  const budgets = new Map(items.filter(item => classes.has(item.itemId)).map(item => [item.itemId, item.quantity]));
  if (!budgets.size) return undefined;
  const finishesAt = Date.parse(job.finishesAt), serverTime = Date.parse(before.serverTime);
  const ready = Number.isFinite(finishesAt) && Number.isFinite(serverTime) && serverTime >= finishesAt;
  const savedEntries = Object.entries(job.rewards).filter(([id]) => species.has(id));
  // Older public projections used the real river fish id as an unknown total.
  // Distinct saved species are unambiguous; an all-river catch needs the marker.
  const savedVisible = ready && (job.fishing.catchRevealed === true || job.fishing.catchRevealed == null && savedEntries.some(([id]) => id !== "fish"));
  const candidates = savedVisible ? savedEntries : catalog.fish.map(fish => {
    const previous = before.fishing?.catches?.[fish.itemId] ?? 0, current = after.fishing?.catches?.[fish.itemId] ?? 0;
    return [fish.itemId, Number.isSafeInteger(previous) && Number.isSafeInteger(current) && previous >= 0 && current >= previous ? current - previous : 0] as const;
  });
  const catches: InventoryGainItem[] = [];
  for (const [itemId, count] of candidates) {
    const group = fishClassForItem(itemId, catalog), budget = group ? budgets.get(group.itemId) ?? 0 : 0;
    if (!group || !Number.isSafeInteger(count) || count <= 0 || budget <= 0) continue;
    const quantity = Math.min(count, budget);
    catches.push(Object.freeze({ itemId, quantity })); budgets.set(group.itemId, budget - quantity);
  }
  if (!catches.length) return undefined;
  const remainder = items.flatMap(item => classes.has(item.itemId)
    ? (budgets.get(item.itemId) ?? 0) > 0 ? [Object.freeze({ ...item, quantity: budgets.get(item.itemId)! })] : []
    : [item]);
  return Object.freeze([...catches, ...remainder]);
}

/** A newer inventory alone is not a reward. Require the exact accepted command
 * revision and its known outputs, then show only the confirmed positive delta.
 * A restored receipt whose changes are already loaded cannot replay a payout. */
export function inventoryGainFromReceipt(before: EconomyView | null, result: EconomyResult,
  command: EconomyCommand | MarketCommand): InventoryGain | null {
  const after = result.state;
  if (!before || before.ownerPublicId !== after.ownerPublicId || command.ownerPublicId !== after.ownerPublicId
    || command.expectedRevision !== before.revision || result.acceptedRevision !== before.revision + 1
    || after.revision !== result.acceptedRevision || !before.inventory || !after.inventory) return null;
  let allowed: Record<string, number>, source: InventoryGain["source"], stationId: string | undefined, fishingJob: EconomyJob | undefined;
  if (command.action === "claim_garden_collection") {
    const jobs = before.jobs.filter(job => job.collection?.batchId === command.targetId);
    if (!jobs.length || jobs.some(job => job.kind !== "production" || job.targetId !== "garden" || !hasGardenBerryReward(job.rewards)
      || after.jobs.some(item => item.id === job.id))) return null;
    allowed = {};
    for (const job of jobs) for (const [itemId, quantity] of Object.entries(job.rewards)) allowed[itemId] = (allowed[itemId] ?? 0) + quantity;
    source = "claim";
    if (after.catalog.buildings.some(station => station.id === "garden")) stationId = "garden";
  } else if (command.action === "claim_job") {
    const job = before.jobs.find(item => item.id === command.targetId);
    if (!job || job.kind === "construction" || after.jobs.some(item => item.id === job.id)) return null;
    allowed = fishClassInventory(job.rewards); source = "claim";
    if (job.fishing && after.catalog.fishing) {
      fishingJob = job;
      const fishEntries = Object.entries(job.rewards).filter(([id]) => fishClassForItem(id, after.catalog.fishing));
      const masked = job.fishing.catchRevealed !== true && fishEntries.length === 1 && fishEntries[0][0] === "fish" && job.fishing.fishId === "fish";
      if (masked) {
        const count = fishEntries[0][1];
        // Older masked snapshots know only the total. Confirmed gains set each class limit.
        allowed = { ...allowed, ...Object.fromEntries(after.catalog.fishing.classes.map(group => [group.itemId, count])) };
      }
    }
    if (job.kind === "production" && after.catalog.buildings.some(station => station.id === job.targetId)) stationId = job.targetId;
    if (isMinerJob(job) && after.catalog.buildings.some(station => station.id === "quarry")) stationId = "quarry";
  } else if (command.action === "buy_fishing_item") {
    const offer = before.fishingShop?.offers.find(item => item.id === command.targetId && (item.kind === "bait" || item.kind === "fish"));
    if (!offer || !before.catalog.fishing || !before.catalog.fishing.baits.some(item => item.itemId === offer.itemId) && !fishClassForItem(offer.itemId, before.catalog.fishing)) return null;
    allowed = { [offer.itemId]: command.quantity }; source = "purchase";
  } else if (command.action === "buy_leaftail_item") {
    const shop = before.catalog.leaftailShop;
    const offer = [...(shop?.offers ?? []), ...(shop?.travelOffers ?? [])]
      .find(item => command.targetId === `${after.leaftailShop.cycle}:${item.id}`);
    if (!offer || command.quantity !== 1 || offer.kind && offer.kind !== "item" && offer.kind !== "bait") return null;
    allowed = { [offer.itemId]: offer.quantity ?? 1 }; source = "purchase";
  } else if (command.action === "buy_listing") {
    const listing = result.listing;
    if (!listing || listing.id !== command.targetId || listing.status !== "sold") return null;
    allowed = { [listing.itemId]: listing.quantity }; source = "purchase";
  } else return null;
  allowed = fishClassInventory(allowed);
  const previousInventory = fishClassInventory(before.inventory), currentInventory = fishClassInventory(after.inventory);
  const known = new Set(after.catalog.items.map(item => item.id));
  const items = Object.entries(allowed).flatMap(([itemId, limit]) => {
    const previous = previousInventory[itemId] ?? 0, current = currentInventory[itemId] ?? 0;
    if (!known.has(itemId) || ![previous, current, limit].every(value => Number.isSafeInteger(value) && value >= 0)) return [];
    const quantity = Math.min(limit, current - previous);
    return quantity > 0 ? [Object.freeze({ itemId, quantity })] : [];
  });
  if (!items.length) return null;
  const displayItems = fishingJob ? fishingDisplayItems(before, after, fishingJob, items) : undefined;
  return Object.freeze({ id: command.requestId, ownerPublicId: after.ownerPublicId,
    revision: result.acceptedRevision, source, ...(stationId ? { stationId } : {}), items: Object.freeze(items),
    ...(displayItems ? { displayItems } : {}) });
}
