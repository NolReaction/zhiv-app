import { neighborDefaultSettings, neighborSettingsSchema, type NeighborOffer, type NeighborSettings } from "@/features/economy/domain/neighbor-model";
import { marketDay } from "@/features/economy/domain/market-rules";
import { freshNeighborUsage, type NeighborUsage } from "@/features/economy/domain/neighbor-rules";

type Cycle = { day: string; offers: NeighborOffer[]; boughtItemIds: string[] };
type NeighborHistory = { id: string; listingId: string; sellerPublicId: string; itemId: string; quantity: number; totalPrice: number; proceedsCoins: number; createdAt: string; source: "auto" | "manual"; requestId?: string };
type NeighborData = {
  settings: NeighborSettings; version: number; cycles: Map<string, Cycle>; usage: Map<string, NeighborUsage>;
  globalUsage: NeighborUsage; experienced: Set<string>; boughtItems: Map<string, { day: string; ids: string[] }>;
  history: NeighborHistory[]; timer?: ReturnType<typeof setInterval>;
  scanCursor?: string;
};
const host = globalThis as typeof globalThis & { __zhivDevNeighborStore?: NeighborData };
function data(): NeighborData {
  return host.__zhivDevNeighborStore ??= { settings: structuredClone(neighborDefaultSettings), version: 0, cycles: new Map(), usage: new Map(),
    globalUsage: freshNeighborUsage(Date.now()), experienced: new Set(), boughtItems: new Map(), history: [] };
}
export function resetDevNeighborStoreForTests() {
  if (host.__zhivDevNeighborStore?.timer) clearInterval(host.__zhivDevNeighborStore.timer);
  delete host.__zhivDevNeighborStore;
}
export function devNeighborSettings(): NeighborSettings { return structuredClone(data().settings); }
/** The local admin route authenticates before this shared test/DEV settings adapter. */
export function configureDevNeighbor(settings: NeighborSettings): void {
  const value = data(); value.settings = neighborSettingsSchema.parse(settings); value.version = (value.version ?? 0) + 1;
}
export function devNeighborVersion(): number { return data().version ?? 0; }
export function devNeighborHistory(owner?: string): NeighborHistory[] {
  return structuredClone(data().history.filter(row => !owner || row.sellerPublicId === owner).slice(-50).reverse());
}
export function devNeighborCycle(owner: string, now: number): Cycle | undefined {
  const cycle = data().cycles.get(owner);
  return cycle?.day === marketDay(now) ? cycle : undefined;
}
export function saveDevNeighborCycle(owner: string, now: number, offers: NeighborOffer[]): Cycle {
  const current = devNeighborCycle(owner, now);
  if (current) return current;
  const bought = devNeighborBoughtItems(owner, now);
  const cycle = { day: marketDay(now), offers: structuredClone(offers).map(offer => ({ ...offer, purchased: offer.purchased || bought.includes(offer.itemId) })), boughtItemIds: [...bought] };
  data().cycles.set(owner, cycle);
  return cycle;
}
export function devNeighborBoughtItems(owner: string, now: number): readonly string[] {
  const found = data().boughtItems.get(owner);
  return found?.day === marketDay(now) ? [...found.ids] : [];
}
export function markDevNeighborOfferBought(owner: string, offer: NeighborOffer, now: number): void {
  offer.purchased = true;
  const ids = [...new Set([...devNeighborBoughtItems(owner, now), offer.itemId])];
  data().boughtItems.set(owner, { day: marketDay(now), ids });
}
export function devNeighborUsage(owner: string, now: number): NeighborUsage {
  const found = data().usage.get(owner);
  return found?.day === marketDay(now) ? { ...found } : freshNeighborUsage(now);
}
export function devNeighborGlobalSpent(now: number): number {
  return data().globalUsage.day === marketDay(now) ? data().globalUsage.spentCoins : 0;
}
export function devNeighborScanCursor(): string | undefined { return data().scanCursor; }
export function saveDevNeighborScanCursor(cursor: string): void { data().scanCursor = cursor; }
export function devNeighborExperienced(owner: string): boolean { return data().experienced.has(owner); }
export function markDevNeighborExperienced(owner: string): void { data().experienced.add(owner); }
export function recordDevNeighborSale(row: NeighborHistory, now: number): void {
  const saved = data(), usage = devNeighborUsage(row.sellerPublicId, now);
  saved.usage.set(row.sellerPublicId, { day: usage.day, usedLots: usage.usedLots + 1, spentCoins: usage.spentCoins + row.totalPrice });
  const global = saved.globalUsage.day === marketDay(now) ? saved.globalUsage : freshNeighborUsage(now);
  saved.globalUsage = { day: global.day, usedLots: global.usedLots + 1, spentCoins: global.spentCoins + row.totalPrice };
  saved.experienced.add(row.sellerPublicId);
  saved.history.push(row);
  if (saved.history.length > 500) saved.history.splice(0, saved.history.length - 500);
}
export function removeDevNeighborOwner(owner: string, deleteHistory = false): void {
  // Reset retains day stock, purchases, experience and subsidy caps. Deletion removes personal state only.
  if (!deleteHistory) return;
  const saved = data();
  saved.cycles.delete(owner); saved.usage.delete(owner); saved.experienced.delete(owner); saved.boughtItems.delete(owner);
  saved.history = saved.history.filter(row => row.sellerPublicId !== owner);
}
export function mergeDevNeighborOwners(source: string, target: string, now = Date.now()): void {
  if (source === target) return;
  const saved = data(), first = devNeighborUsage(source, now), second = devNeighborUsage(target, now);
  saved.usage.set(target, { day: marketDay(now), usedLots: Math.min(Number.MAX_SAFE_INTEGER, first.usedLots + second.usedLots), spentCoins: Math.min(Number.MAX_SAFE_INTEGER, first.spentCoins + second.spentCoins) });
  if (saved.experienced.has(source)) saved.experienced.add(target);
  const ids = [...new Set([...devNeighborBoughtItems(source, now), ...devNeighborBoughtItems(target, now)])];
  saved.boughtItems.set(target, { day: marketDay(now), ids });
  const firstCycle = devNeighborCycle(source, now), secondCycle = devNeighborCycle(target, now);
  const retained = secondCycle ?? firstCycle;
  if (retained) saved.cycles.set(target, { ...structuredClone(retained), boughtItemIds: ids,
    offers: retained.offers.map(offer => ({ ...offer, purchased: offer.purchased || ids.includes(offer.itemId) })) });
  saved.history = saved.history.map(row => row.sellerPublicId === source ? { ...row, sellerPublicId: target } : row);
  saved.cycles.delete(source); saved.usage.delete(source); saved.experienced.delete(source); saved.boughtItems.delete(source);
}
export function ensureDevNeighborTimer(tick: () => void): void {
  if (process.env.NODE_ENV !== "development" || data().timer) return;
  data().timer = setInterval(() => { try { tick(); } catch { /* The next bounded tick retries without mutating failed trades. */ } }, 30000);
  const timer = data().timer;
  if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
}
