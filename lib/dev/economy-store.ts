import { promoRequestSchema, type PromoRequest, type PromoResult } from "@/features/promo/model";
import type { PromoCatalog } from "@/lib/server/promo-catalog";
import { wardrobeItems, wardrobeOwned } from "@/features/world/domain/wardrobe";
// Development adapter only. Production mutations are atomic Ktor/PostgreSQL transactions.
import { createHash, randomInt } from "node:crypto";
import { ECONOMY_CURRENCY_SCALE, ECONOMY_PEARL_SCALE, ECONOMY_MAX_PEARLS, formatPearls, nominalEconomyMoney, redenominateEconomyState } from "@/features/economy/domain/money";
import { marketBudgetReset, marketDailyLimit, marketDay, marketHomeRange, marketItemUnlocked, marketListingEligible, marketMinimumPrice, marketSaleFee, marketCanTrade, marketShowcaseCurrent, marketSlotCount } from "@/features/economy/domain/market-rules";
import { awardDevEconomyAchievements, awardDevMarketSale, getDevIdentity, getDevGuestWorldAccess, lookupDevUser } from "@/lib/dev/api-store";
import type { GuestWorld } from "@/features/people/guest-world-model";
import { consumeDevLegacyEconomy, getDevCollectionFinds, hasDevLegacyJourney, getDevLegacyWardrobe, syncDevWorldWardrobe } from "@/lib/dev/world-store";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_ITEMS, economyCatalog, economyCommandSchema, economyResidentOrdersSchema, marketCommandSchema, type EconomyCommand,
  type EconomyMarketListing, type EconomyResult, type EconomyState, type EconomyView, type MarketCommand, type MarketView } from "@/features/economy/domain/model";
import { applyEconomyCommand, assertEconomyStorageTransition, convertLegacyEconomy, creditEconomyItems, economyStorage, EconomyRuleError, marketUnlocked, newEconomyState } from "@/features/economy/domain/rules";
import { inheritEconomyCollection } from "@/features/economy/domain/collection-progress";
import { economyCommandUsesActor } from "@/features/economy/domain/actor-availability";
import { createFishingShop, fishingShopExpired } from "@/features/economy/domain/fishing-shop";
import { fishingState, fishClassInventory, fishingClassItemId } from "@/features/economy/domain/fishing";
import { creditFishStock, debitFishStock, FishSelectionChangedError, fishStockWithinItems, normalizeFishStockInventory, reconcileFishStock } from "@/features/economy/domain/fish-stock";
import { publicEconomyJob } from "@/features/economy/domain/public-jobs";
import { tutorialOrderProgress } from "@/features/economy/domain/tutorial-order";
import { ensureStageOrders, stageOrdersProgress } from "@/features/economy/domain/stage-orders";
import { persistEconomyItemUnlocks, unlockedEconomyItems } from "@/features/economy/domain/item-unlocks";
import { foodState } from "@/features/economy/domain/food";
import { economyDevCommandSchema, type EconomyDevCommand } from "@/features/economy/dev/dev-model";
import { economyDevSettlement } from "@/features/economy/dev/dev-presets";
import { BARTER_DAILY_LIMIT, barterCommandSchema, barterSameHomeBand, type BarterCommand, type BarterOffer, type BarterView, type BarterResult } from "@/features/economy/domain/barter-model";

type Receipt = { signature: string; message: string; acceptedRevision: number; action?: ReceiptCommand["action"] };
type ReceiptCommand = EconomyCommand | MarketCommand | EconomyDevCommand;
type Profile = { revision: number; state: EconomyState; receipts: Map<string, Receipt>; legacyJourneys: Set<string> };
type Listing = Omit<EconomyMarketListing, "owned" | "sellerName"> & { currencyScale?: 1 | 10 };
type Showcase = { refreshAt: number; ids: string[] };
type BarterReceipt = { signature: string; message: string; acceptedRevision: number; offer: BarterOffer };
type TradeTurnover = { day: string; buysUsed: number; salesUsed: number; barterUsed: number };
type PromoClaim = { requestId: string; title: string; reward: PromoResult["reward"]; acceptedRevision: number; signature: string };
type Store = { promoClaims: Map<string, Map<string, PromoClaim>>; turnover: Map<string, TradeTurnover>; profiles: Map<string, Profile>; listings: Map<string, Listing>; showcases: Map<string, Showcase>;
  resetMarketReceipts: Map<string, { revision: number; receipts: Map<string, Receipt> }>;
  barterOffers: Map<string, BarterOffer>; barterShowcases: Map<string, Showcase>; barterReceipts: Map<string, Map<string, BarterReceipt>> };
const globalStore = globalThis as typeof globalThis & { __zhivDevEconomyStore?: Store };
function store(): Store {
  const value = globalStore.__zhivDevEconomyStore ??= { promoClaims: new Map(), turnover: new Map(), profiles: new Map(), listings: new Map(), showcases: new Map(), resetMarketReceipts: new Map(),
    barterOffers: new Map(), barterShowcases: new Map(), barterReceipts: new Map() };
  // Next HMR may retain the pre-showcase store; preserve its profiles and paid listings.
  value.promoClaims ??= new Map(); value.showcases ??= new Map(); value.turnover ??= new Map();
  value.barterOffers ??= new Map(); value.barterShowcases ??= new Map(); value.barterReceipts ??= new Map();
  value.resetMarketReceipts ??= new Map();
  for (const listing of value.listings.values()) {
    listing.currencyScale ??= 1; listing.feeBps ??= 0;
    if (listing.status === "active" && listing.currencyScale === 1) {
      listing.totalPrice = nominalEconomyMoney(listing.totalPrice, 1); listing.currencyScale = 10;
    }
  }
  return value;
}
export const resetDevEconomyStoreForTests = () => { delete globalStore.__zhivDevEconomyStore; };
export { EconomyRuleError as DevEconomyError };
function fail(code: string, message: string, status = 409): never { throw new EconomyRuleError(code, message, status); }
function profile(token: string | undefined, now: number) {
  const identity = getDevIdentity(token);
  if (!identity) return fail("UNAUTHORIZED", "Войдите в аккаунт", 401);
  const owner = identity.user.publicId;
  let value = store().profiles.get(owner);
  if (!value) {
    const legacy = consumeDevLegacyEconomy(token, now);
    const retained = store().resetMarketReceipts.get(owner);
    value = { revision: retained?.revision ?? 0, state: newEconomyState(legacy), receipts: new Map(retained?.receipts), legacyJourneys: new Set() };
    store().resetMarketReceipts.delete(owner);
    if (economyCatalog.fishing) value.state.fishingShop = createFishingShop(value.state, now, randomInt);
    store().profiles.set(owner, value);
  }
  normalizeCurrency(value);
  value.state.fishing ??= fishingState({});
  normalizeFishStockInventory(value.state);
  value.state.wardrobe = wardrobeOwned(value.state.wardrobe, getDevLegacyWardrobe(owner));
  value.state.progression = inheritEconomyCollection(value.state.progression, getDevCollectionFinds(owner));
  value.state.buildings.warehouse ??= 1;
  value.state.buildings.kiln ??= 0;
  return { owner, value };
}
function normalizeCurrency(value: Profile) {
  if (value.state.currencyScale === ECONOMY_CURRENCY_SCALE && value.state.pearlScale === ECONOMY_PEARL_SCALE) return;
  const next = redenominateEconomyState(value.state);
  bump(value); value.state = next;
}
function view(owner: string, value: Profile, now: number): EconomyView {
  const state = structuredClone(value.state);
  ensureStageOrders(state, economyCatalog, now);
  const unlockedItems = unlockedEconomyItems(state, legacyItemHistory(owner));
  delete state.fishingCastSeed;
  delete state.rareDropState;
  delete state.minerRareDropState;
  delete state.itemUnlockVersion;
  state.jobs = state.jobs.map(job => publicEconomyJob(job, now));
  return { ownerPublicId: owner, revision: value.revision, serverTime: new Date(now).toISOString(), ...state, currencyScale: ECONOMY_CURRENCY_SCALE, pearlScale: ECONOMY_PEARL_SCALE,
    tutorialOrder: tutorialOrderProgress(state), stageOrders: stageOrdersProgress(state), food: foodState(state), residentOrders: economyResidentOrdersSchema.parse(state.residentOrders),
    marketSlots: marketSlotCount(state), unlockedItems,
    productionSlots: state.productionSlots ?? {}, workshopStarterClaimed: state.workshopStarterClaimed ?? false, wardrobe: wardrobeOwned(state.wardrobe), fishingShop: state.fishingShop ?? null, leaftailShop: state.leaftailShop ?? { cycle: -1, purchased: {} }, storage: economyStorage(value.state, escrowItems(owner)), catalog: structuredClone(economyCatalog) };
}
function bump(value: Profile) {
  if (value.revision >= Number.MAX_SAFE_INTEGER) fail("ECONOMY_CAPACITY", "Состояние требует обслуживания");
  value.revision++;
}
function receipt(value: Profile, owner: string, command: ReceiptCommand, now: number, scope = ""): EconomyResult | null {
  if (owner !== command.ownerPublicId) return fail("ECONOMY_OWNER_CHANGED", "Аккаунт изменился. Обновите хозяйство");
  const signature = scope + commandSignature(command);
  const found = value.receipts.get(receiptKey(command));
  if (found) {
    if (found.signature !== signature) return fail("ECONOMY_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия");
    return { state: view(owner, value, now), message: found.message, acceptedRevision: found.acceptedRevision, replayed: true };
  }
  if (value.revision !== command.expectedRevision) return fail("ECONOMY_REVISION_CONFLICT", "Хозяйство изменилось на другом устройстве. Проверьте состояние и повторите действие");
  if (value.revision >= Number.MAX_SAFE_INTEGER) return fail("ECONOMY_CAPACITY", "Состояние требует обслуживания");
  return null;
}
function receiptKey(command: ReceiptCommand) {
  return command.requestId.toLowerCase();
}
function commandSignature(command: ReceiptCommand) {
  const parts: unknown[] = [command.ownerPublicId, command.expectedRevision, command.action, command.targetId, command.quantity, command.totalPrice];
  if ("fishSelection" in command && command.fishSelection != null)
    parts.push(Object.entries(command.fishSelection).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0));
  return JSON.stringify(parts);
}
function removeFishEscrow(state: EconomyState, listingId: string) {
  const current = fishingState(state);
  if (!current.escrow?.[listingId]) return;
  const escrow = { ...current.escrow };
  delete escrow[listingId];
  state.fishing = { ...current, escrow };
}
function escrowItems(owner: string, excluding?: string): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const listing of store().listings.values()) {
    if (listing.id !== excluding && listing.status === "active" && listing.sellerPublicId === owner)
      totals[listing.itemId] = (totals[listing.itemId] ?? 0) + listing.quantity;
  }
  for (const offer of store().barterOffers.values()) {
    if (offer.id !== excluding && offer.status === "active" && offer.sellerPublicId === owner)
      totals[offer.offeredItemId] = (totals[offer.offeredItemId] ?? 0) + 1;
  }
  return fishClassInventory(totals);
}
/** Only ownership evidence from the old ledger contributes to legacy discovery. */
function legacyItemHistory(owner: string): string[] {
  const items = [...store().listings.values()].filter(listing => listing.sellerPublicId === owner).map(listing => listing.itemId);
  for (const offer of store().barterOffers.values()) if (offer.sellerPublicId === owner) {
    items.push(offer.offeredItemId);
    if (offer.status === "exchanged") items.push(offer.requestedItemId);
  }
  return items;
}
function knownMarketState(owner: string, state: EconomyState): EconomyState {
  return { ...state, unlockedItems: unlockedEconomyItems(state, legacyItemHistory(owner)) };
}
/** Seal discovery from the prior state before inspecting any newly transferred goods. */
function persistItemUnlocks(owner: string, previous: EconomyState, next: EconomyState, confirmedRewards: readonly string[] = []) {
  const prior = unlockedEconomyItems(previous, legacyItemHistory(owner));
  next.unlockedItems = [...new Set([...prior, ...(next.unlockedItems ?? [])])].sort();
  next.itemUnlockVersion = 1;
  persistEconomyItemUnlocks(next, confirmedRewards);
}
function commit(owner: string, value: Profile, next: EconomyState, command: ReceiptCommand, message: string, now: number, scope = ""): EconomyResult {
  reconcileFishStock(next);
  persistItemUnlocks(owner, value.state, next);
  bump(value); value.state = next;
  if (!["grant_currency", "grant_item", "grant_fishing_gear", "grant_wardrobe", "grant_upgrade_cost", "set_building_level", "finish_jobs", "apply_settlement"].includes(command.action))
    awardDevEconomyAchievements(owner, next, now);
  value.receipts.set(receiptKey(command), {
    signature: scope + commandSignature(command),
    message, acceptedRevision: value.revision, action: command.action,
  });
  return { state: view(owner, value, now), message, acceptedRevision: value.revision, replayed: false };
}
export function initializeDevEconomy(token: string | undefined, now = Date.now()): void { profile(token, now); }
export function getDevEconomy(token: string | undefined, now = Date.now(), expectedOwner?: string): EconomyView {
  const { owner, value } = profile(token, now);
  if (expectedOwner != null && owner !== expectedOwner) fail("ECONOMY_OWNER_CHANGED", "Аккаунт изменился. Обновите хозяйство");
  if (economyCatalog.fishing && fishingShopExpired(value.state.fishingShop, now)) {
    const shop = createFishingShop(value.state, now, randomInt);
    bump(value); value.state.fishingShop = shop;
  }
  return view(owner, value, now);
}
export function commandDevEconomy(token: string | undefined, input: EconomyCommand, now = Date.now()): EconomyResult {
  const parsed = economyCommandSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_ECONOMY_COMMAND", "Некорректный запрос хозяйства", 400);
  const command = parsed.data, { owner, value } = profile(token, now);
  const replay = receipt(value, owner, command, now);
  if (replay) return replay;
  if (economyCommandUsesActor(command) && hasDevLegacyJourney(token, now)) return fail("ECONOMY_EXPLORER_BUSY", "Мохлик ещё в прежнем путешествии. Сначала подтвердите возвращение");
  const next = structuredClone(value.state);
  const reserved = escrowItems(owner);
  const fishing = command.action === "start_fishing" || command.action === "start_exploration"
    && economyCatalog.fishing?.routeIds.includes(command.targetId);
  const message = applyEconomyCommand(next, command, now, () => fishing ? crypto.randomUUID() : command.requestId, reserved, randomInt);
  assertEconomyStorageTransition(value.state, next, reserved);
  const wardrobeChanged = JSON.stringify(value.state.wardrobe) !== JSON.stringify(next.wardrobe);
  const result = commit(owner, value, next, command, message, now);
  if (wardrobeChanged) syncDevWorldWardrobe(token, next.wardrobe ?? [], now);
  return result;
}
/** QA tools mutate the same server snapshot and receipt ledger as ordinary play. */
export function commandDevEconomyCheat(token: string | undefined, input: EconomyDevCommand, now = Date.now()): EconomyResult {
  if (process.env.NODE_ENV !== "development") return fail("DEV_TOOLS_DISABLED", "Читы доступны только в локальной разработке", 404);
  const parsed = economyDevCommandSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_ECONOMY_COMMAND", "Некорректная DEV-команда", 400);
  const command = parsed.data, { owner, value } = profile(token, now);
  const replay = receipt(value, owner, command, now);
  if (replay) return replay;
  const next: EconomyState = structuredClone(value.state);
  let message: string;
  switch (command.action) {
    case "apply_settlement": {
      if (next.jobs.length) return fail("ECONOMY_BUILDING_BUSY", "Сначала завершите или отмените задания и заберите результаты");
      next.buildings = economyDevSettlement(command.quantity);
      message = `DEV: дом ${command.quantity}, его улучшения и кладовая ${command.quantity} готовы`;
      break;
    }
    case "grant_currency": {
      const currency = command.targetId as "coins" | "pearls";
      const quantum = currency === "pearls" ? ECONOMY_PEARL_SCALE : ECONOMY_CURRENCY_SCALE;
      if (command.quantity % quantum !== 0) return fail("INVALID_ECONOMY_COMMAND", `Количество валюты должно быть кратно ${currency === "pearls" ? formatPearls(quantum) : quantum}`, 400);
      if (next.wallet[currency] + command.quantity > (currency === "pearls" ? ECONOMY_MAX_PEARLS : ECONOMY_MAX_BALANCE)) return fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
      next.wallet[currency] += command.quantity;
      message = `DEV: выдано ${currency === "pearls" ? formatPearls(command.quantity) : command.quantity} ${currency === "coins" ? "монет" : "жемчужин"}`;
      break;
    }
    case "grant_item":
      creditEconomyItems(next, { [command.targetId]: command.quantity });
      creditFishStock(next, { [command.targetId]: command.quantity });
      message = `DEV: выдано ${command.quantity} × ${economyCatalog.items.find(item => item.id === command.targetId)!.name}`;
      break;
    case "grant_wardrobe": {
      const items = wardrobeItems.filter(item => command.targetId === "all" || item.id === command.targetId);
      next.wardrobe = wardrobeOwned(next.wardrobe, items.map(item => item.id));
      message = command.targetId === "all" ? "DEV: вся одежда добавлена в гардероб" : `DEV: ${items[0].name} теперь в гардеробе`;
      break;
    }
    case "grant_fishing_gear": {
      const fishing = fishingState(next), catalog = economyCatalog.fishing!;
      const rods = catalog.rods.filter(rod => command.targetId === "all" || rod.id === command.targetId).map(rod => rod.id);
      const hooks = catalog.hooks.filter(hook => command.targetId === "all" || hook.id === command.targetId).map(hook => hook.id);
      next.fishing = { ...fishing, ownedRods: [...new Set([...fishing.ownedRods, ...rods])], ownedHooks: [...new Set([...fishing.ownedHooks, ...hooks])] };
      message = command.targetId === "all" ? "DEV: все удочки и крючки доступны перед рыбалкой" : "DEV: снасть доступна перед рыбалкой";
      break;
    }
    case "grant_upgrade_cost": {
      const building = economyCatalog.buildings.find(item => item.id === command.targetId)!;
      const target = building.levels.find(level => level.level === (next.buildings[building.id] ?? 0) + 1);
      if (!target) return fail("ECONOMY_MAX_LEVEL", "Доступные улучшения уже завершены");
      next.wallet.coins = Math.max(next.wallet.coins, target.cost.coins);
      creditEconomyItems(next, Object.fromEntries(Object.entries(target.cost.items)
        .map(([item, quantity]) => [item, Math.max(0, quantity - (next.inventory[item] ?? 0))])));
      message = `DEV: добавлены недостающие монеты и материалы для «${building.name}», уровень ${target.level}`;
      break;
    }
    case "set_building_level": {
      if (next.jobs.some(job => job.kind === "exploration"
        ? command.targetId === "quarry" && !!economyCatalog.explorations.find(route => route.id === job.targetId)?.requiredBuildings.quarry
        : job.targetId === command.targetId))
        return fail("ECONOMY_BUILDING_BUSY", "Сначала ускорьте работу этого здания и заберите результат");
      next.buildings[command.targetId] = command.quantity;
      message = `DEV: ${economyCatalog.buildings.find(item => item.id === command.targetId)!.name}: уровень ${command.quantity}`;
      break;
    }
    case "finish_jobs": {
      const jobs = next.jobs.filter(job => (command.targetId === "all" || job.kind === command.targetId) && Date.parse(job.finishesAt) > now);
      if (!jobs.length) return fail("ECONOMY_DEV_NO_JOBS", "Нет незавершённых работ этого типа");
      for (const job of jobs) job.finishesAt = new Date(now).toISOString();
      message = `DEV: ускорено работ: ${jobs.length}. Заберите результат у объекта или в путешествиях`;
      break;
    }
  }
  // DEV grants may deliberately exceed storage capacity, but never numeric limits,
  // including the player's materials already reserved by market listings.
  const reserved = escrowItems(owner);
  if (Object.entries(next.inventory).some(([item, quantity]) => quantity + (reserved[item] ?? 0) > ECONOMY_MAX_ITEMS))
    return fail("ECONOMY_CAPACITY", "Сначала освободите место для этого материала");
  return commit(owner, value, next, command, message, now);
}
export function getDevEconomyWardrobe(token: string | undefined, now = Date.now()): readonly string[] { return profile(token, now).value.state.wardrobe ?? []; }
export function getDevEconomyBuildingLevels(token: string | undefined, now = Date.now()): { home: number; workshop: number } {
  const { value } = profile(token, now);
  return { home: value.state.buildings.home ?? 1, workshop: value.state.buildings.workshop ?? 0 };
}
export function creditDevLegacyJourney(token: string | undefined, journey: { id: string; rewards: { sparks: number; wood: number; stone: number } }, now = Date.now()) {
  const { owner, value } = profile(token, now);
  if (value.legacyJourneys.has(journey.id)) return;
  const converted = convertLegacyEconomy(journey.rewards), next = structuredClone(value.state);
  if (next.wallet.coins + converted.coinsGranted > ECONOMY_MAX_BALANCE) fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
  creditEconomyItems(next, { wood: converted.woodGranted, stone: converted.stoneGranted });
  assertEconomyStorageTransition(value.state, next, escrowItems(owner));
  next.wallet.coins += converted.coinsGranted;
  persistItemUnlocks(owner, value.state, next, Object.entries({ wood: converted.woodGranted, stone: converted.stoneGranted })
    .filter(([, quantity]) => quantity > 0).map(([item]) => item));
  bump(value); value.state = next; value.legacyJourneys.add(journey.id);
}
/** A game reset preserves account-level limits; deleting a test identity also removes its history. */
export function removeDevEconomyOwner(owner: string, options: { deleteHistory?: boolean } = {}) {
  const saved = store().profiles.get(owner);
  if (options.deleteHistory) { store().turnover.delete(owner); store().promoClaims.delete(owner); store().resetMarketReceipts.delete(owner); }
  else if (saved) {
    if (saved.revision >= Number.MAX_SAFE_INTEGER) fail("ECONOMY_CAPACITY", "Состояние требует обслуживания");
    store().resetMarketReceipts.set(owner, { revision: saved.revision + 1,
      receipts: new Map([...saved.receipts].filter(([, receipt]) => receipt.action === "claim_sale")) });
  }
  store().profiles.delete(owner);
  store().showcases.delete(owner);
  store().barterShowcases.delete(owner); store().barterReceipts.delete(owner);
  for (const [id, offer] of store().barterOffers) if (offer.sellerPublicId === owner) store().barterOffers.delete(id);
  for (const [id, listing] of store().listings) if (listing.sellerPublicId === owner && (options.deleteHistory || !pendingSale(listing))) store().listings.delete(id);
}
function tradeTurnover(owner: string, now: number): TradeTurnover {
  const current = store().turnover.get(owner), day = marketDay(now);
  return current?.day === day ? current : { day, buysUsed: 0, salesUsed: 0, barterUsed: 0 };
}
function tradeBudget(owner: string, state: EconomyState, now: number): NonNullable<MarketView["tradeBudget"]> {
  const used = tradeTurnover(owner, now), home = state.buildings.home ?? 1, band = marketHomeRange(home);
  return { buysUsed: used.buysUsed, salesUsed: used.salesUsed, limit: marketDailyLimit(home), resetsAt: marketBudgetReset(now),
    feeBps: economyCatalog.market.feeBps, homeBandMin: band.min, homeBandMax: band.max };
}
function compatibleMarketSeller(ownerHome: number, sellerId: string, minimumHome = 2): boolean {
  const seller = store().profiles.get(sellerId);
  return !!seller && marketUnlocked(seller.state) && (seller.state.buildings.home ?? 1) >= minimumHome
    && (minimumHome === 3 ? barterSameHomeBand(ownerHome, seller.state.buildings.home ?? 1)
      : marketCanTrade(ownerHome, seller.state.buildings.home ?? 1));
}
function publicListing(listing: Listing, owner: string, token: string | undefined): EconomyMarketListing {
  const seller = lookupDevUser(token, listing.sellerPublicId);
  return { ...listing, sale: listing.sellerPublicId === owner ? structuredClone(listing.sale ?? null) : null,
    totalPrice: nominalEconomyMoney(listing.totalPrice, listing.currencyScale ?? 1), sellerName: seller.kind === "ok" ? seller.value.user.displayName : "Житель леса", owned: listing.sellerPublicId === owner };
}
// Missing sale on a pre-upgrade DEV row means its money was already credited.
const pendingSale = (listing: Listing) => listing.status === "sold" && listing.sale != null && listing.sale.claimedAt === null;
const occupiedListing = (listing: Listing) => listing.status === "active" || pendingSale(listing);
function requireMarket(state: EconomyState) {
  if (!marketUnlocked(state)) fail("ECONOMY_MARKET_LOCKED", "Рынок откроется с домом уровня 2 после восстановления моста");
}
const compareListings = (a: Listing, b: Listing) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** No profile(), normalization, legacy conversion, showcase writes or host initialization during a visit. */
export function getDevGuestWorldEconomy(viewer: string, target: string, sellerName: string, legacy: { homeLevel: number; workshopLevel: number }):
  { world: Pick<GuestWorld["world"], "buildings" | "jobs">; market: GuestWorld["market"] } {
  const saved = globalStore.__zhivDevEconomyStore;
  const state = saved?.profiles.get(target)?.state, buyer = saved?.profiles.get(viewer)?.state;
  const buildings = state ? { ...state.buildings } : Object.fromEntries(economyCatalog.buildings.map(building => [building.id,
    building.id === "home" ? legacy.homeLevel : building.id === "workshop" ? legacy.workshopLevel : ["garden", "warehouse"].includes(building.id) ? 1 : 0]));
  const reason = !buyer || !marketUnlocked(buyer) ? "buyer_locked" : !state || !marketUnlocked(state) ? "seller_locked"
    : !marketCanTrade(buyer.buildings.home ?? 1, state.buildings.home ?? 1) ? "home_band" : null;
  const listings = [...(saved?.listings.values() ?? [])].filter(listing => listing.sellerPublicId === target && listing.status === "active")
    .sort(compareListings).slice(0, 10).map(listing => ({ id: listing.id, sellerPublicId: listing.sellerPublicId, sellerName,
      itemId: listing.itemId, quantity: listing.quantity, totalPrice: nominalEconomyMoney(listing.totalPrice, listing.currencyScale ?? 1),
      feeBps: listing.feeBps ?? 0, status: listing.status, createdAt: listing.createdAt, closedAt: listing.closedAt, owned: false, sale: null }));
  const jobs = (state?.jobs ?? []).map(job => ({ id: job.id, kind: job.kind, targetId: job.targetId, recipeId: job.recipeId,
    targetLevel: job.targetLevel, startedAt: job.startedAt, finishesAt: job.finishesAt, actorId: job.actorId ?? null,
    collection: job.collection ? { kind: job.collection.kind, seconds: job.collection.seconds,
      startedAt: job.collection.startedAt ?? null, finishesAt: job.collection.finishesAt ?? null } : null }));
  return { world: { buildings, jobs }, market: { listings, available: reason === null, reason } };
}

export function getDevEconomyMarket(token: string | undefined, options: { cursor?: string; limit?: number; ownerPublicId?: string } = {}, now = Date.now()): MarketView {
  const { owner, value } = profile(token, now);
  if (options.ownerPublicId && options.ownerPublicId !== owner) fail("ECONOMY_OWNER_CHANGED", "Аккаунт изменился. Обновите рынок");
  const config = economyCatalog.market, limit = options.limit ?? config.showcaseSlots;
  if (!Number.isInteger(limit) || limit < 1 || limit > config.showcaseSlots || options.cursor != null)
    fail("INVALID_ECONOMY_QUERY", "Лавка содержит до 12 предложений без дополнительных страниц", 400);
  const active = [...store().listings.values()].filter(item => item.status === "active").sort(compareListings);
  const mine = [...store().listings.values()].filter(item => item.sellerPublicId === owner && occupiedListing(item))
    .sort(compareListings).map(item => publicListing(item, owner, token));
  const known = knownMarketState(owner, value.state);
  let selection = store().showcases.get(owner);
  const unlocked = marketUnlocked(value.state);
  if (unlocked && (!selection || !marketShowcaseCurrent(selection.refreshAt, now))) {
    const rank = (id: string) => createHash("md5").update(id + owner + now).digest("hex");
    const candidates = active.filter(item => item.sellerPublicId !== owner && compatibleMarketSeller(value.state.buildings.home ?? 1, item.sellerPublicId) && marketListingEligible(item, known)
      && lookupDevUser(token, item.sellerPublicId).kind === "ok").map(item => ({ item, rank: rank(item.id) }))
      .sort((a, b) => a.rank.localeCompare(b.rank) || a.item.id.localeCompare(b.item.id));
    const perSeller = new Map<string, number>(), ids: string[] = [];
    for (const { item } of candidates) {
      const count = perSeller.get(item.sellerPublicId) ?? 0;
      if (count >= config.showcasePerSeller) continue;
      ids.push(item.id); perSeller.set(item.sellerPublicId, count + 1);
      if (ids.length >= config.showcaseSlots) break;
    }
    selection = { refreshAt: now + config.showcaseRefreshSeconds * 1000, ids };
    store().showcases.set(owner, selection);
  }
  const listings = !unlocked || !selection ? [] : selection.ids.map(id => store().listings.get(id))
    .filter((item): item is Listing => !!item && item.status === "active" && compatibleMarketSeller(value.state.buildings.home ?? 1, item.sellerPublicId) && marketListingEligible(item, known)
      && lookupDevUser(token, item.sellerPublicId).kind === "ok").slice(0, limit).map(item => publicListing(item, owner, token));
  return { ownerPublicId: owner, listings, mine, serverTime: new Date(now).toISOString(), nextCursor: null, tradeBudget: tradeBudget(owner, value.state, now),
    showcase: { refreshAt: new Date(selection?.refreshAt ?? now + config.showcaseRefreshSeconds * 1000).toISOString(),
      slots: config.showcaseSlots, maxPerSeller: config.showcasePerSeller, refreshSeconds: config.showcaseRefreshSeconds } };
}
export function commandDevEconomyMarket(token: string | undefined, input: MarketCommand, now = Date.now()): EconomyResult {
  return commandDevMarket(token, input, now);
}

/** Friend storefronts skip the random showcase only; every purchase invariant stays in the shared pipeline. */
export function commandDevGuestWorldMarket(token: string | undefined, circleId: string, input: MarketCommand, now = Date.now()): EconomyResult {
  const access = getDevGuestWorldAccess(token, circleId);
  if (access.kind !== "ok") return fail(access.kind === "unauthorized" ? "UNAUTHORIZED" : "GUEST_WORLD_UNAVAILABLE",
    "Поляна недоступна", access.kind === "unauthorized" ? 401 : 404);
  const parsed = marketCommandSchema.safeParse(input);
  if (!parsed.success || parsed.data.action !== "buy_listing") return fail("INVALID_ECONOMY_COMMAND", "В гостях можно только покупать товары", 400);
  const listing = globalStore.__zhivDevEconomyStore?.listings.get(parsed.data.targetId.toLowerCase());
  if (!listing || listing.sellerPublicId !== access.value.target.publicId)
    return fail("GUEST_WORLD_UNAVAILABLE", "Предложение недоступно на этой поляне", 404);
  return commandDevMarket(token, parsed.data, now, access.value.target.publicId, `friend:${circleId}:`);
}

function commandDevMarket(token: string | undefined, input: MarketCommand, now: number, friendSellerId?: string, receiptScope = ""): EconomyResult {
  const parsed = marketCommandSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_ECONOMY_COMMAND", "Некорректный запрос рынка", 400);
  const command = parsed.data;
  if (command.fishSelection != null && command.action !== "create_listing")
    return fail("INVALID_ECONOMY_COMMAND", "Выбор рыбы используется только при создании лота", 400);
  const { owner, value } = profile(token, now);
  if (command.action !== "create_listing" && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command.targetId))
    return fail("INVALID_ECONOMY_COMMAND", "Некорректное объявление", 400);
  if (command.action === "cancel_listing" || command.action === "claim_sale") {
    if (command.quantity !== 1 || command.totalPrice !== 0) return fail("INVALID_ECONOMY_COMMAND", "Некорректный запрос отмены", 400);
  } else {
    if (command.quantity > economyCatalog.market.maxLotQuantity) return fail("ECONOMY_MARKET_QUANTITY", "В лоте может быть от 1 до 99 предметов", 400);
    if (command.totalPrice < command.quantity) return fail("ECONOMY_MARKET_PRICE", "Укажите цену всей партии в монетах", 400);
  }
  const replay = receipt(value, owner, command, now, receiptScope);
  if (replay) return replay;
  if (command.action !== "cancel_listing" && command.action !== "claim_sale") requireMarket(value.state);
  const next = structuredClone(value.state);
  const known = knownMarketState(owner, value.state);
  if (command.action === "create_listing") {
    const item = economyCatalog.items.find(item => item.id === fishingClassItemId(command.targetId) && item.tradable);
    if (!item) return fail("ECONOMY_MARKET_ITEM", "Этот предмет нельзя выставить на рынок", 400);
    if (!marketItemUnlocked(known, item.id)) return fail("ECONOMY_MARKET_ITEM_LOCKED", "Сначала откройте этот предмет в хозяйстве");
    if (command.totalPrice % ECONOMY_CURRENCY_SCALE !== 0 || command.totalPrice < marketMinimumPrice(item.id, command.quantity) || command.totalPrice > item.baseSellPrice * economyCatalog.market.maxPriceMultiplier * command.quantity) return fail("ECONOMY_MARKET_PRICE", "Цена лота вне разрешённого диапазона", 400);
    const slots = marketSlotCount(next);
    if ([...store().listings.values()].filter(item => item.sellerPublicId === owner && occupiedListing(item)).length >= slots)
      return fail("ECONOMY_MARKET_LIMIT", `На прилавке уже заняты все места: ${slots}`);
    if (marketMinimumPrice(item.id, command.quantity) > marketDailyLimit(next.buildings.home ?? 1))
      return fail("ECONOMY_MARKET_DAILY_LOT_LIMIT", "Разделите партию: её базовая стоимость превышает дневной объём продаж");
    if ((next.inventory[item.id] ?? 0) < command.quantity) return fail("ECONOMY_RESOURCES", "Не хватает предметов для лота");
    let fishStockCost: Record<string, number>;
    try { fishStockCost = debitFishStock(next, { [item.id]: command.quantity }, command.fishSelection ?? undefined); }
    catch (error) { if (error instanceof FishSelectionChangedError) return fail("ECONOMY_FISH_SELECTION_CHANGED", error.message); throw error; }
    next.inventory[item.id] -= command.quantity;
    if (!next.inventory[item.id]) delete next.inventory[item.id];
    const reserved = escrowItems(owner);
    assertEconomyStorageTransition(value.state, next, reserved, { ...reserved, [item.id]: (reserved[item.id] ?? 0) + command.quantity });
    const listing: Listing = { id: crypto.randomUUID(), sellerPublicId: owner, itemId: item.id, quantity: command.quantity,
      totalPrice: command.totalPrice, feeBps: economyCatalog.market.feeBps, currencyScale: ECONOMY_CURRENCY_SCALE, status: "active", createdAt: new Date(now).toISOString(), closedAt: null, sale: null };
    if (Object.keys(fishStockCost).length) {
      const current = fishingState(next);
      next.fishing = { ...current, escrow: { ...current.escrow, [listing.id]: fishStockCost } };
    }
    store().listings.set(listing.id, listing);
    return { ...commit(owner, value, next, command, "Лот размещён на прилавке", now), listing: publicListing(listing, owner, token) };
  }
  const listing = store().listings.get(command.targetId.toLowerCase());
  if (!listing) return fail("ECONOMY_MARKET_NOT_FOUND", "Лот не найден", 404);
  if (command.action === "claim_sale") {
    if (listing.sellerPublicId !== owner) return fail("ECONOMY_MARKET_OWNER", "Это прилавок другого игрока", 403);
    if (!pendingSale(listing) || !listing.sale) return fail("ECONOMY_MARKET_NOT_PENDING", "Выручка уже собрана или лот ещё не продан");
    if (next.wallet.coins + listing.sale.proceedsCoins > ECONOMY_MAX_BALANCE)
      return fail("ECONOMY_CAPACITY", "В кошельке недостаточно места для выручки");
    next.wallet.coins += listing.sale.proceedsCoins;
    listing.sale.claimedAt = new Date(now).toISOString();
    return { ...commit(owner, value, next, command, "Выручка собрана", now), listing: publicListing(listing, owner, token) };
  }
  if (listing.status !== "active") return fail("ECONOMY_MARKET_NOT_ACTIVE", "Лот уже куплен или снят с продажи");
  if (command.action === "cancel_listing") {
    if (listing.sellerPublicId !== owner) return fail("ECONOMY_MARKET_OWNER", "Это прилавок другого игрока", 403);
    creditEconomyItems(next, { [listing.itemId]: listing.quantity });
    assertEconomyStorageTransition(value.state, next, escrowItems(owner), escrowItems(owner, listing.id));
    creditFishStock(next, fishStockWithinItems(next.fishing.escrow?.[listing.id] ?? { [listing.itemId]: listing.quantity }, { [listing.itemId]: listing.quantity }));
    removeFishEscrow(next, listing.id);
    listing.status = "cancelled"; listing.closedAt = new Date(now).toISOString();
    return { ...commit(owner, value, next, command, "Лот снят, предметы возвращены", now), listing: publicListing(listing, owner, token) };
  }
  if (listing.sellerPublicId === owner) return fail("ECONOMY_MARKET_SELF_TRADE", "Нельзя купить собственный лот");
  if (command.quantity !== listing.quantity || command.totalPrice !== listing.totalPrice) return fail("ECONOMY_MARKET_QUOTE_CHANGED", "Проверьте количество и цену лота");
  const selection = store().showcases.get(owner);
  if (!friendSellerId && (!selection || !marketShowcaseCurrent(selection.refreshAt, now) || !selection.ids.includes(listing.id)))
    return fail("ECONOMY_MARKET_SHOWCASE_CHANGED", "Предложение вне текущей витрины. Обновите лавку");
  if (!marketListingEligible(listing, known))
    return fail("ECONOMY_MARKET_ITEM_LOCKED", "Предмет пока не открыт в хозяйстве или цена устарела");
  const seller = store().profiles.get(listing.sellerPublicId);
  if (!seller || lookupDevUser(token, listing.sellerPublicId).kind !== "ok") return fail("ECONOMY_MARKET_NOT_ACTIVE", "Продавец больше недоступен");
  normalizeCurrency(seller);
  if (!marketUnlocked(seller.state)) return fail("ECONOMY_MARKET_LOCKED", "Продавец ещё не восстановил мост");
  if (!marketCanTrade(next.buildings.home ?? 1, seller.state.buildings.home ?? 1))
    return fail("ECONOMY_MARKET_HOME_BAND", "Уровень поселения изменился. Обновите витрину");
  const valueTraded = marketMinimumPrice(listing.itemId, listing.quantity);
  const buyerTurnover = tradeTurnover(owner, now), sellerTurnover = tradeTurnover(listing.sellerPublicId, now);
  if (buyerTurnover.buysUsed + valueTraded > marketDailyLimit(next.buildings.home ?? 1))
    return fail("ECONOMY_MARKET_DAILY_LIMIT", "Дневной объём покупок исчерпан. Он обновится в 00:00 UTC");
  if (sellerTurnover.salesUsed + valueTraded > marketDailyLimit(seller.state.buildings.home ?? 1))
    return fail("ECONOMY_MARKET_SELLER_DAILY_LIMIT", "Продавец достиг дневного объёма продаж");
  const proceeds = listing.totalPrice - marketSaleFee(listing.totalPrice, listing.feeBps ?? 0);
  if (next.wallet.coins < listing.totalPrice) return fail("ECONOMY_RESOURCES", "Не хватает монет");
  if (seller.revision >= Number.MAX_SAFE_INTEGER) return fail("ECONOMY_CAPACITY", "Состояние продавца требует обслуживания");
  creditEconomyItems(next, { [listing.itemId]: listing.quantity });
  assertEconomyStorageTransition(value.state, next, escrowItems(owner));
  creditFishStock(next, fishStockWithinItems(seller.state.fishing.escrow?.[listing.id] ?? { [listing.itemId]: listing.quantity }, { [listing.itemId]: listing.quantity }));
  next.wallet.coins -= listing.totalPrice;
  const sellerNext = structuredClone(seller.state);
  removeFishEscrow(sellerNext, listing.id);
  reconcileFishStock(sellerNext);
  persistItemUnlocks(listing.sellerPublicId, seller.state, sellerNext);
  bump(seller); seller.state = sellerNext;
  store().turnover.set(owner, { ...buyerTurnover, buysUsed: buyerTurnover.buysUsed + valueTraded });
  store().turnover.set(listing.sellerPublicId, { ...sellerTurnover, salesUsed: sellerTurnover.salesUsed + valueTraded });
  listing.status = "sold"; listing.closedAt = new Date(now).toISOString();
  const buyer = getDevIdentity(token)!;
  listing.sale = { buyerPublicId: owner, buyerName: buyer.user.displayName, buyerAvatarUrl: buyer.profile.avatarUrl,
    proceedsCoins: proceeds, claimedAt: null };
  awardDevMarketSale(listing.sellerPublicId, now);
  return { ...commit(owner, value, next, command, "Покупка получена. Продавец сможет забрать выручку в своей лавке", now, receiptScope), listing: publicListing(listing, owner, token) };
}

/** Achievement reads must not initialize an economy, mint conversion grants or expose the private cast seed. */
export function getDevEconomyAchievementState(owner: string): Pick<EconomyState, "completedExplorations" | "buildings" | "fishing" | "progression"> | null {
  const state = store().profiles.get(owner)?.state;
  if (!state) return null;
  return { completedExplorations: state.completedExplorations, buildings: { ...state.buildings }, fishing: structuredClone(fishingState(state)),
    progression: inheritEconomyCollection(state.progression, getDevCollectionFinds(owner)) };
}

/** A verified completed trade, not a listing attempt, qualifies the seller. */
export function getDevConfirmedMarketSales(owner: string): number {
  return [...store().listings.values()].some(listing => listing.sellerPublicId === owner && listing.status === "sold") ? 1 : 0;
}

const barterUnlocked = (state: EconomyState) => (state.buildings.home ?? 1) >= 3 && marketUnlocked(state);
function barterItem(id: string) {
  return economyCatalog.items.some(item => item.id === id && item.category === "special" && !item.tradable);
}
function publicBarter(offer: BarterOffer, owner: string, token: string | undefined): BarterOffer {
  const seller = lookupDevUser(token, offer.sellerPublicId);
  return { ...offer, owned: offer.sellerPublicId === owner,
    sellerName: seller.kind === "ok" ? seller.value.user.displayName : "Житель леса" };
}
export function getDevEconomyBarter(token: string | undefined, now = Date.now()): BarterView {
  const { owner, value } = profile(token, now);
  const active = [...store().barterOffers.values()].filter(offer => offer.status === "active");
  let selection = store().barterShowcases.get(owner);
  const unlocked = barterUnlocked(value.state);
  if (unlocked && (!selection || now >= selection.refreshAt)) {
    const rank = (id: string) => createHash("md5").update(id + owner + now).digest("hex");
    const candidates = active.filter(offer => offer.sellerPublicId !== owner && compatibleMarketSeller(value.state.buildings.home ?? 1, offer.sellerPublicId, 3) && barterItem(offer.offeredItemId)
      && barterItem(offer.requestedItemId) && lookupDevUser(token, offer.sellerPublicId).kind === "ok")
      .map(offer => ({ offer, rank: rank(offer.id) })).sort((a, b) => a.rank.localeCompare(b.rank) || a.offer.id.localeCompare(b.offer.id));
    const sellers = new Set<string>(), ids: string[] = [];
    for (const { offer } of candidates) {
      if (sellers.has(offer.sellerPublicId)) continue;
      sellers.add(offer.sellerPublicId); ids.push(offer.id);
      if (ids.length === 6) break;
    }
    selection = { refreshAt: now + 1800_000, ids };
    store().barterShowcases.set(owner, selection);
  }
  const offers = unlocked && selection ? selection.ids.map(id => store().barterOffers.get(id))
    .filter((offer): offer is BarterOffer => !!offer && offer.status === "active" && compatibleMarketSeller(value.state.buildings.home ?? 1, offer.sellerPublicId, 3) && barterItem(offer.offeredItemId)
      && barterItem(offer.requestedItemId) && lookupDevUser(token, offer.sellerPublicId).kind === "ok")
    .map(offer => publicBarter(offer, owner, token)) : [];
  return { ownerPublicId: owner, offers, mine: active.filter(offer => offer.sellerPublicId === owner)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(offer => publicBarter(offer, owner, token)),
    serverTime: new Date(now).toISOString(), dailyLimit: { used: tradeTurnover(owner, now).barterUsed, limit: BARTER_DAILY_LIMIT, resetsAt: marketBudgetReset(now) }, showcase: { refreshAt: new Date(selection?.refreshAt ?? now + 1800_000).toISOString(),
      slots: 6, maxPerSeller: 1, refreshSeconds: 1800 } };
}
/** DEV uses the same synchronous transaction boundary for both accounts; production uses ordered DB locks. */
export function commandDevEconomyBarter(token: string | undefined, input: BarterCommand, now = Date.now()): BarterResult {
  const parsed = barterCommandSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_ECONOMY_COMMAND", "Некорректный запрос обмена", 400);
  const command = parsed.data, { owner, value } = profile(token, now);
  if (owner !== command.ownerPublicId) return fail("ECONOMY_OWNER_CHANGED", "Аккаунт изменился. Обновите хозяйство");
  const signature = JSON.stringify(command), requestId = command.requestId.toLowerCase();
  const receipts = store().barterReceipts.get(owner) ?? new Map<string, BarterReceipt>();
  const receipt = receipts.get(requestId);
  if (receipt) {
    if (receipt.signature !== signature) return fail("ECONOMY_REQUEST_CONFLICT", "Запрос уже использован для другого действия");
    return { state: view(owner, value, now), ...receipt, offer: structuredClone(receipt.offer), replayed: true };
  }
  if (value.receipts.has(requestId)) return fail("ECONOMY_REQUEST_CONFLICT", "Запрос уже использован для другого действия");
  if (value.revision !== command.expectedRevision) return fail("ECONOMY_REVISION_CONFLICT", "Хозяйство изменилось. Обновите его");
  if (value.revision >= Number.MAX_SAFE_INTEGER) return fail("ECONOMY_CAPACITY", "Состояние требует обслуживания");
  if (command.action !== "cancel_offer" && !barterUnlocked(value.state)) return fail("ECONOMY_BARTER_LOCKED", "Обмен откроется с домом уровня 3 и восстановленным мостом");
  const next = structuredClone(value.state), held = escrowItems(owner);
  let offer: BarterOffer, message: string;
  let sellerUpdate: { profile: Profile; state: EconomyState } | undefined;
  if (command.action === "create_offer") {
    if (!barterItem(command.offeredItemId) || !barterItem(command.requestedItemId) || command.offeredItemId === command.requestedItemId)
      return fail("ECONOMY_BARTER_ITEM", "Выберите две разные реликвии", 400);
    if ([...store().barterOffers.values()].filter(row => row.sellerPublicId === owner && row.status === "active").length >= 3)
      return fail("ECONOMY_BARTER_LIMIT", "У вас уже три предложения обмена");
    if (!(next.inventory[command.offeredItemId] > 0)) return fail("ECONOMY_RESOURCES", "Не хватает реликвии для обмена");
    next.inventory[command.offeredItemId]--;
    assertEconomyStorageTransition(value.state, next, held, { ...held, [command.offeredItemId]: (held[command.offeredItemId] ?? 0) + 1 });
    offer = { id: crypto.randomUUID(), sellerPublicId: owner, sellerName: getDevIdentity(token)!.user.displayName,
      offeredItemId: command.offeredItemId, requestedItemId: command.requestedItemId, status: "active", createdAt: new Date(now).toISOString(), closedAt: null, owned: true };
    message = "Предложение обмена размещено";
  } else {
    const found = store().barterOffers.get(command.offerId.toLowerCase());
    if (!found) return fail("ECONOMY_BARTER_NOT_FOUND", "Предложение не найдено", 404);
    if (found.status !== "active") return fail("ECONOMY_BARTER_NOT_ACTIVE", "Предложение уже закрыто");
    offer = structuredClone(found); offer.closedAt = new Date(now).toISOString();
    if (command.action === "cancel_offer") {
      if (offer.sellerPublicId !== owner) return fail("ECONOMY_BARTER_OWNER", "Это предложение другого игрока", 403);
      creditEconomyItems(next, { [offer.offeredItemId]: 1 });
      assertEconomyStorageTransition(value.state, next, held, escrowItems(owner, offer.id));
      offer.status = "cancelled"; message = "Предложение снято, реликвия возвращена";
    } else {
      if (offer.sellerPublicId === owner) return fail("ECONOMY_BARTER_SELF_TRADE", "Нельзя обменяться с собой");
      const selection = store().barterShowcases.get(owner);
      if (!selection || now >= selection.refreshAt || !selection.ids.includes(offer.id)) return fail("ECONOMY_BARTER_SHOWCASE_CHANGED", "Предложение вне текущей витрины. Обновите обмен");
      if (!barterItem(offer.offeredItemId) || !barterItem(offer.requestedItemId)) return fail("ECONOMY_BARTER_ITEM", "Обмен этим предметом приостановлен");
      const seller = store().profiles.get(offer.sellerPublicId);
      if (!seller || lookupDevUser(token, offer.sellerPublicId).kind !== "ok") return fail("ECONOMY_BARTER_NOT_ACTIVE", "Автор предложения недоступен");
      if (!barterUnlocked(seller.state)) return fail("ECONOMY_BARTER_LOCKED", "Автор предложения ещё не открыл обмен");
      if (!barterSameHomeBand(next.buildings.home ?? 1, seller.state.buildings.home ?? 1))
        return fail("ECONOMY_BARTER_HOME_BAND", "Уровень поселения изменился. Обновите обмен");
      if (tradeTurnover(owner, now).barterUsed >= BARTER_DAILY_LIMIT || tradeTurnover(offer.sellerPublicId, now).barterUsed >= BARTER_DAILY_LIMIT)
        return fail("ECONOMY_BARTER_DAILY_LIMIT", "Один из участников уже обменялся сегодня. Новый обмен доступен после 00:00 UTC");
      if (seller.revision >= Number.MAX_SAFE_INTEGER) return fail("ECONOMY_CAPACITY", "Автор предложения пока не может принять обмен");
      if (!(next.inventory[offer.requestedItemId] > 0)) return fail("ECONOMY_RESOURCES", "Не хватает реликвии для обмена");
      next.inventory[offer.requestedItemId]--;
      creditEconomyItems(next, { [offer.offeredItemId]: 1 });
      const sellerNext = structuredClone(seller.state);
      creditEconomyItems(sellerNext, { [offer.requestedItemId]: 1 });
      assertEconomyStorageTransition(value.state, next, held);
      assertEconomyStorageTransition(seller.state, sellerNext, escrowItems(offer.sellerPublicId), escrowItems(offer.sellerPublicId, offer.id));
      sellerUpdate = { profile: seller, state: sellerNext };
      offer.status = "exchanged"; message = "Обмен завершён: реликвия получена";
    }
  }
  // All validation precedes the first write, so a failed exchange leaves both inventories and escrow intact.
  persistItemUnlocks(owner, value.state, next);
  if (sellerUpdate) {
    persistItemUnlocks(offer.sellerPublicId, sellerUpdate.profile.state, sellerUpdate.state);
    bump(sellerUpdate.profile); sellerUpdate.profile.state = sellerUpdate.state;
    for (const participant of [owner, offer.sellerPublicId]) {
      const turnover = tradeTurnover(participant, now);
      store().turnover.set(participant, { ...turnover, barterUsed: turnover.barterUsed + 1 });
    }
  }
  bump(value); value.state = next;
  store().barterOffers.set(offer.id, offer);
  const accepted = publicBarter(offer, owner, token);
  receipts.set(requestId, { signature, message, acceptedRevision: value.revision, offer: structuredClone(accepted) });
  store().barterReceipts.set(owner, receipts);
  value.receipts.set(requestId, { signature: `barter:${signature}`, message, acceptedRevision: value.revision });
  return { state: view(owner, value, now), message, acceptedRevision: value.revision, replayed: false, offer: accepted };
}

/** Trusted rewards adapter: validate all wallet/storage limits before any mutation. */
export function creditDevProgressionReward(token: string | undefined, ownerPublicId: string, requestId: string,
  reward: { coins: number; pearls: number; items: Record<string, number> }, signature: string, now = Date.now()): EconomyView {
  const { owner, value } = profile(token, now);
  if (owner !== ownerPublicId) fail("ECONOMY_OWNER_CHANGED", "Аккаунт изменился. Обновите награды");
  if (value.receipts.has(requestId.toLowerCase())) fail("ECONOMY_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия");
  const next = structuredClone(value.state);
  for (const currency of ["coins", "pearls"] as const) {
    if (!Number.isSafeInteger(reward[currency]) || reward[currency] < 0 || next.wallet[currency] + reward[currency] > (currency === "pearls" ? ECONOMY_MAX_PEARLS : ECONOMY_MAX_BALANCE))
      fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
    next.wallet[currency] += reward[currency];
  }
  creditEconomyItems(next, reward.items);
  creditFishStock(next, reward.items);
  assertEconomyStorageTransition(value.state, next, escrowItems(owner));
  persistItemUnlocks(owner, value.state, next);
  // Revision capacity is checked before assigning the new state.
  bump(value); value.state = next;
  value.receipts.set(requestId.toLowerCase(), { signature, message: "Награда получена", acceptedRevision: value.revision });
  return view(owner, value, now);
}

/** Synchronous DEV equivalent of the PostgreSQL transaction; the catalog never reaches the browser. */
export function redeemDevPromo(token: string | undefined, input: PromoRequest, catalog: PromoCatalog, now = Date.now()): PromoResult {
  const parsed = promoRequestSchema.safeParse(input);
  if (!parsed.success) fail("INVALID_PROMO_CODE", "Проверьте промокод: от 3 до 40 латинских букв, цифр, - или _.", 400);
  const command = parsed.data, { owner, value } = profile(token, now);
  if (owner !== command.ownerPublicId) fail("ECONOMY_OWNER_CHANGED", "Открыт другой профиль. Обновите страницу.");
  const requestId = command.requestId.toLowerCase();
  const signature = `promo:v1:${createHash("sha256").update(JSON.stringify(command)).digest("hex")}`;
  const claims = store().promoClaims.get(owner) ?? new Map<string, PromoClaim>();
  const prior = value.receipts.get(requestId);
  if (prior) {
    if (prior.signature !== signature) fail("ECONOMY_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия");
    const claim = [...claims.values()].find(entry => entry.requestId === requestId);
    if (!claim) fail("PROMO_ALREADY_USED", "Вы уже получили подарок по этому промокоду.");
    return { state: view(owner, value, now), message: "Подарок уже получен", acceptedRevision: claim.acceptedRevision,
      replayed: true, title: claim.title, reward: structuredClone(claim.reward) };
  }
  const entry = catalog.codes.find(entry => entry.enabled && entry.code === command.code);
  if (!entry) fail("PROMO_NOT_FOUND", "Промокод не найден. Проверьте, правильно ли он введён.");
  if (entry.startsAt && now < Date.parse(entry.startsAt)) fail("PROMO_NOT_STARTED", "Этот промокод начнёт действовать позже.");
  if (entry.endsAt && now >= Date.parse(entry.endsAt)) fail("PROMO_EXPIRED", "Срок действия промокода закончился.");
  if (claims.has(entry.id)) fail("PROMO_ALREADY_USED", "Вы уже получили подарок по этому промокоду.");
  if (value.revision !== command.expectedRevision) fail("ECONOMY_REVISION_CONFLICT", "Хозяйство изменилось. Обновите состояние и повторите ввод промокода.");
  const reward = { ...entry.reward, pearls: entry.reward.pearls * 2 };
  let state: EconomyView;
  try { state = creditDevProgressionReward(token, owner, requestId, reward, signature, now); } catch (error) {
    if (error instanceof EconomyRuleError && error.code === "ECONOMY_STORAGE_FULL") fail(error.code, "В кладовой недостаточно места для подарка. Освободите место и повторите: промокод не использован.");
    throw error;
  }
  claims.set(entry.id, { requestId, title: entry.title, reward: structuredClone(reward), acceptedRevision: state.revision, signature });
  store().promoClaims.set(owner, claims);
  return { state, message: "Подарок получен", acceptedRevision: state.revision, replayed: false, title: entry.title, reward };
}
