import { wardrobeItems, wardrobeOwned } from "@/features/world/wardrobe";
// Development adapter only. Production mutations are atomic Ktor/PostgreSQL transactions.
import { createHash, randomInt } from "node:crypto";
import { ECONOMY_CURRENCY_SCALE, ECONOMY_PEARL_SCALE, ECONOMY_MAX_PEARLS, nominalEconomyMoney, redenominateEconomyState } from "@/features/economy/money";
import { marketItemUnlocked, marketListingEligible, marketMinimumPrice } from "@/features/economy/market-rules";
import { awardDevEconomyAchievements, awardDevMarketSale, getDevIdentity, lookupDevUser } from "@/lib/dev/api-store";
import { consumeDevLegacyEconomy, getDevCollectionFinds, hasDevLegacyJourney, getDevLegacyWardrobe, syncDevWorldWardrobe } from "@/lib/dev/world-store";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_ITEMS, economyCatalog, economyCommandSchema, marketCommandSchema, type EconomyCommand,
  type EconomyMarketListing, type EconomyResult, type EconomyState, type EconomyView, type MarketCommand, type MarketView } from "@/features/economy/model";
import { applyEconomyCommand, assertEconomyStorageTransition, convertLegacyEconomy, creditEconomyItems, economyStorage, EconomyRuleError, marketUnlocked, newEconomyState } from "@/features/economy/rules";
import { inheritEconomyCollection } from "@/features/economy/collection-progress";
import { economyCommandUsesActor } from "@/features/economy/actor-availability";
import { createFishingShop, fishingShopExpired } from "@/features/economy/fishing-shop";
import { fishingState } from "@/features/economy/fishing";
import { publicEconomyJob } from "@/features/economy/public-jobs";
import { economyDevCommandSchema, type EconomyDevCommand } from "@/features/economy/dev-model";
import { economyDevSettlement } from "@/features/economy/dev-presets";
import { barterCommandSchema, type BarterCommand, type BarterOffer, type BarterView, type BarterResult } from "@/features/economy/barter-model";

type Receipt = { signature: string; message: string; acceptedRevision: number };
type ReceiptCommand = EconomyCommand | MarketCommand | EconomyDevCommand;
type Profile = { revision: number; state: EconomyState; receipts: Map<string, Receipt>; legacyJourneys: Set<string> };
type Listing = Omit<EconomyMarketListing, "owned" | "sellerName"> & { currencyScale?: 1 | 10 };
type Showcase = { refreshAt: number; ids: string[] };
type BarterReceipt = { signature: string; message: string; acceptedRevision: number; offer: BarterOffer };
type Store = { profiles: Map<string, Profile>; listings: Map<string, Listing>; showcases: Map<string, Showcase>;
  barterOffers: Map<string, BarterOffer>; barterShowcases: Map<string, Showcase>; barterReceipts: Map<string, Map<string, BarterReceipt>> };
const globalStore = globalThis as typeof globalThis & { __zhivDevEconomyStore?: Store };
function store(): Store {
  const value = globalStore.__zhivDevEconomyStore ??= { profiles: new Map(), listings: new Map(), showcases: new Map(),
    barterOffers: new Map(), barterShowcases: new Map(), barterReceipts: new Map() };
  // Next HMR may retain the pre-showcase store; preserve its profiles and paid listings.
  value.showcases ??= new Map();
  value.barterOffers ??= new Map(); value.barterShowcases ??= new Map(); value.barterReceipts ??= new Map();
  for (const listing of value.listings.values()) {
    listing.currencyScale ??= 1;
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
    value = { revision: 0, state: newEconomyState(legacy), receipts: new Map(), legacyJourneys: new Set() };
    if (economyCatalog.fishing) value.state.fishingShop = createFishingShop(value.state, now, randomInt);
    store().profiles.set(owner, value);
  }
  normalizeCurrency(value);
  value.state.fishing ??= fishingState({});
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
  delete state.fishingCastSeed;
  delete state.rareDropState;
  state.jobs = state.jobs.map(publicEconomyJob);
  return { ownerPublicId: owner, revision: value.revision, serverTime: new Date(now).toISOString(), ...state, currencyScale: ECONOMY_CURRENCY_SCALE, pearlScale: ECONOMY_PEARL_SCALE,
    wardrobe: wardrobeOwned(state.wardrobe), fishingShop: state.fishingShop ?? null, storage: economyStorage(value.state, escrowItems(owner)), catalog: structuredClone(economyCatalog) };
}
function bump(value: Profile) {
  if (value.revision >= Number.MAX_SAFE_INTEGER) fail("ECONOMY_CAPACITY", "Состояние требует обслуживания");
  value.revision++;
}
function receipt(value: Profile, owner: string, command: ReceiptCommand, now: number): EconomyResult | null {
  if (owner !== command.ownerPublicId) return fail("ECONOMY_OWNER_CHANGED", "Аккаунт изменился. Обновите хозяйство");
  const signature = JSON.stringify([command.ownerPublicId, command.expectedRevision, command.action, command.targetId, command.quantity, command.totalPrice]);
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
  return totals;
}
function commit(owner: string, value: Profile, next: EconomyState, command: ReceiptCommand, message: string, now: number): EconomyResult {
  value.state = next; bump(value);
  if (!["grant_currency", "grant_item", "grant_fishing_gear", "grant_wardrobe", "grant_upgrade_cost", "set_building_level", "finish_jobs", "apply_settlement"].includes(command.action))
    awardDevEconomyAchievements(owner, next, now);
  value.receipts.set(receiptKey(command), {
    signature: JSON.stringify([command.ownerPublicId, command.expectedRevision, command.action, command.targetId, command.quantity, command.totalPrice]),
    message, acceptedRevision: value.revision,
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
  const result = commit(owner, value, next, command, message, now);
  if (command.action === "buy_wardrobe_item") syncDevWorldWardrobe(token, next.wardrobe ?? [], now);
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
      message = `DEV: дом ${command.quantity} и все доступные ему улучшения готовы`;
      break;
    }
    case "grant_currency": {
      const currency = command.targetId as "coins" | "pearls";
      const quantum = currency === "pearls" ? ECONOMY_PEARL_SCALE : ECONOMY_CURRENCY_SCALE;
      if (command.quantity % quantum !== 0) return fail("INVALID_ECONOMY_COMMAND", `Количество валюты должно быть кратно ${quantum}`, 400);
      if (next.wallet[currency] + command.quantity > (currency === "pearls" ? ECONOMY_MAX_PEARLS : ECONOMY_MAX_BALANCE)) return fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
      next.wallet[currency] += command.quantity;
      message = `DEV: выдано ${command.quantity} ${currency === "coins" ? "монет" : "жемчужин"}`;
      break;
    }
    case "grant_item":
      creditEconomyItems(next, { [command.targetId]: command.quantity });
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
      message = `DEV: ${economyCatalog.buildings.find(item => item.id === command.targetId)!.name} — уровень ${command.quantity}`;
      break;
    }
    case "finish_jobs": {
      const jobs = next.jobs.filter(job => (command.targetId === "all" || job.kind === command.targetId) && Date.parse(job.finishesAt) > now);
      if (!jobs.length) return fail("ECONOMY_DEV_NO_JOBS", "Нет незавершённых работ этого типа");
      for (const job of jobs) job.finishesAt = new Date(now).toISOString();
      message = `DEV: ускорено работ — ${jobs.length}. Заберите результат у объекта или в путешествиях`;
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
  bump(value); value.state = next; value.legacyJourneys.add(journey.id);
}
export function removeDevEconomyOwner(owner: string) {
  store().profiles.delete(owner);
  store().showcases.delete(owner);
  store().barterShowcases.delete(owner); store().barterReceipts.delete(owner);
  for (const [id, offer] of store().barterOffers) if (offer.sellerPublicId === owner) store().barterOffers.delete(id);
  for (const [id, listing] of store().listings) if (listing.sellerPublicId === owner) store().listings.delete(id);
}
function publicListing(listing: Listing, owner: string, token: string | undefined): EconomyMarketListing {
  const seller = lookupDevUser(token, listing.sellerPublicId);
  return { ...listing, totalPrice: nominalEconomyMoney(listing.totalPrice, listing.currencyScale ?? 1), sellerName: seller.kind === "ok" ? seller.value.user.displayName : "Житель леса", owned: listing.sellerPublicId === owner };
}
function requireMarket(state: EconomyState) {
  if (!marketUnlocked(state)) fail("ECONOMY_MARKET_LOCKED", "Рынок откроется после улучшения дома до уровня 2 и возвращения из первого исследования");
}
const compareListings = (a: Listing, b: Listing) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
export function getDevEconomyMarket(token: string | undefined, options: { cursor?: string; limit?: number; ownerPublicId?: string } = {}, now = Date.now()): MarketView {
  const { owner, value } = profile(token, now);
  if (options.ownerPublicId && options.ownerPublicId !== owner) fail("ECONOMY_OWNER_CHANGED", "Аккаунт изменился. Обновите рынок");
  const config = economyCatalog.market, limit = options.limit ?? config.showcaseSlots;
  if (!Number.isInteger(limit) || limit < 1 || limit > config.showcaseSlots || options.cursor != null)
    fail("INVALID_ECONOMY_QUERY", "Лавка содержит до 12 предложений без дополнительных страниц", 400);
  const active = [...store().listings.values()].filter(item => item.status === "active").sort(compareListings);
  const mine = active.filter(item => item.sellerPublicId === owner).map(item => publicListing(item, owner, token));
  let selection = store().showcases.get(owner);
  const unlocked = marketUnlocked(value.state);
  if (unlocked && (!selection || now >= selection.refreshAt)) {
    const rank = (id: string) => createHash("md5").update(id + owner + now).digest("hex");
    const candidates = active.filter(item => item.sellerPublicId !== owner && marketListingEligible(item, value.state.buildings.home ?? 1)
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
    .filter((item): item is Listing => !!item && item.status === "active" && marketListingEligible(item, value.state.buildings.home ?? 1)
      && lookupDevUser(token, item.sellerPublicId).kind === "ok").slice(0, limit).map(item => publicListing(item, owner, token));
  return { listings, mine, serverTime: new Date(now).toISOString(), nextCursor: null,
    showcase: { refreshAt: new Date(selection?.refreshAt ?? now + config.showcaseRefreshSeconds * 1000).toISOString(),
      slots: config.showcaseSlots, maxPerSeller: config.showcasePerSeller, refreshSeconds: config.showcaseRefreshSeconds } };
}
export function commandDevEconomyMarket(token: string | undefined, input: MarketCommand, now = Date.now()): EconomyResult {
  const parsed = marketCommandSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_ECONOMY_COMMAND", "Некорректный запрос рынка", 400);
  const command = parsed.data, { owner, value } = profile(token, now);
  if (command.action !== "create_listing" && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command.targetId))
    return fail("INVALID_ECONOMY_COMMAND", "Некорректное объявление", 400);
  if (command.action === "cancel_listing") {
    if (command.quantity !== 1 || command.totalPrice !== 0) return fail("INVALID_ECONOMY_COMMAND", "Некорректный запрос отмены", 400);
  } else {
    if (command.quantity > economyCatalog.market.maxLotQuantity) return fail("ECONOMY_MARKET_QUANTITY", "В лоте может быть от 1 до 99 предметов", 400);
    if (command.totalPrice < command.quantity) return fail("ECONOMY_MARKET_PRICE", "Укажите цену всей партии в монетах", 400);
  }
  const replay = receipt(value, owner, command, now);
  if (replay) return replay;
  if (command.action !== "cancel_listing") requireMarket(value.state);
  const next = structuredClone(value.state);
  if (command.action === "create_listing") {
    const item = economyCatalog.items.find(item => item.id === command.targetId && item.tradable);
    if (!item) return fail("ECONOMY_MARKET_ITEM", "Этот предмет нельзя выставить на рынок", 400);
    if (!marketItemUnlocked(next, item.id)) return fail("ECONOMY_MARKET_ITEM_LOCKED", "Предмет пока недоступен на вашем уровне дома");
    if (command.totalPrice % ECONOMY_CURRENCY_SCALE !== 0 || command.totalPrice < marketMinimumPrice(item.id, command.quantity) || command.totalPrice > item.baseSellPrice * economyCatalog.market.maxPriceMultiplier * command.quantity) return fail("ECONOMY_MARKET_PRICE", "Цена лота вне разрешённого диапазона", 400);
    if ([...store().listings.values()].filter(item => item.sellerPublicId === owner && item.status === "active").length >= economyCatalog.market.maxListings) return fail("ECONOMY_MARKET_LIMIT", "На прилавке уже 10 лотов");
    if ((next.inventory[item.id] ?? 0) < command.quantity) return fail("ECONOMY_RESOURCES", "Не хватает предметов для лота");
    next.inventory[item.id] -= command.quantity;
    if (!next.inventory[item.id]) delete next.inventory[item.id];
    const reserved = escrowItems(owner);
    assertEconomyStorageTransition(value.state, next, reserved, { ...reserved, [item.id]: (reserved[item.id] ?? 0) + command.quantity });
    const listing: Listing = { id: crypto.randomUUID(), sellerPublicId: owner, itemId: item.id, quantity: command.quantity,
      totalPrice: command.totalPrice, currencyScale: ECONOMY_CURRENCY_SCALE, status: "active", createdAt: new Date(now).toISOString(), closedAt: null };
    store().listings.set(listing.id, listing);
    return { ...commit(owner, value, next, command, "Лот размещён на прилавке", now), listing: publicListing(listing, owner, token) };
  }
  const listing = store().listings.get(command.targetId.toLowerCase());
  if (!listing) return fail("ECONOMY_MARKET_NOT_FOUND", "Лот не найден", 404);
  if (listing.status !== "active") return fail("ECONOMY_MARKET_NOT_ACTIVE", "Лот уже куплен или снят с продажи");
  if (command.action === "cancel_listing") {
    if (listing.sellerPublicId !== owner) return fail("ECONOMY_MARKET_OWNER", "Это прилавок другого игрока", 403);
    creditEconomyItems(next, { [listing.itemId]: listing.quantity });
    assertEconomyStorageTransition(value.state, next, escrowItems(owner), escrowItems(owner, listing.id));
    listing.status = "cancelled"; listing.closedAt = new Date(now).toISOString();
    return { ...commit(owner, value, next, command, "Лот снят, предметы возвращены", now), listing: publicListing(listing, owner, token) };
  }
  if (listing.sellerPublicId === owner) return fail("ECONOMY_MARKET_SELF_TRADE", "Нельзя купить собственный лот");
  if (command.quantity !== listing.quantity || command.totalPrice !== listing.totalPrice) return fail("ECONOMY_MARKET_QUOTE_CHANGED", "Проверьте количество и цену лота");
  const selection = store().showcases.get(owner);
  if (!selection || now >= selection.refreshAt || !selection.ids.includes(listing.id))
    return fail("ECONOMY_MARKET_SHOWCASE_CHANGED", "Предложение вне текущей витрины. Обновите лавку");
  if (!marketListingEligible(listing, next.buildings.home ?? 1))
    return fail("ECONOMY_MARKET_ITEM_LOCKED", "Предмет пока недоступен на вашем уровне дома или цена устарела");
  const seller = store().profiles.get(listing.sellerPublicId);
  if (!seller || lookupDevUser(token, listing.sellerPublicId).kind !== "ok") return fail("ECONOMY_MARKET_NOT_ACTIVE", "Продавец больше недоступен");
  normalizeCurrency(seller);
  if (next.wallet.coins < listing.totalPrice) return fail("ECONOMY_RESOURCES", "Не хватает монет");
  if (seller.state.wallet.coins + listing.totalPrice > ECONOMY_MAX_BALANCE || seller.revision >= Number.MAX_SAFE_INTEGER) return fail("ECONOMY_CAPACITY", "Продавец пока не может принять оплату");
  creditEconomyItems(next, { [listing.itemId]: listing.quantity });
  assertEconomyStorageTransition(value.state, next, escrowItems(owner));
  next.wallet.coins -= listing.totalPrice;
  seller.state.wallet.coins += listing.totalPrice; bump(seller);
  listing.status = "sold"; listing.closedAt = new Date(now).toISOString();
  awardDevMarketSale(listing.sellerPublicId, now);
  return { ...commit(owner, value, next, command, "Покупка получена, монеты отправлены продавцу", now), listing: publicListing(listing, owner, token) };
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

const barterUnlocked = (state: EconomyState) => (state.buildings.home ?? 1) >= 3;
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
    const candidates = active.filter(offer => offer.sellerPublicId !== owner && barterItem(offer.offeredItemId)
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
    .filter((offer): offer is BarterOffer => !!offer && offer.status === "active" && barterItem(offer.offeredItemId)
      && barterItem(offer.requestedItemId) && lookupDevUser(token, offer.sellerPublicId).kind === "ok")
    .map(offer => publicBarter(offer, owner, token)) : [];
  return { ownerPublicId: owner, offers, mine: active.filter(offer => offer.sellerPublicId === owner)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(offer => publicBarter(offer, owner, token)),
    serverTime: new Date(now).toISOString(), showcase: { refreshAt: new Date(selection?.refreshAt ?? now + 1800_000).toISOString(),
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
  if (command.action !== "cancel_offer" && !barterUnlocked(value.state)) return fail("ECONOMY_BARTER_LOCKED", "Обмен откроется на третьем уровне дома");
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
  if (sellerUpdate) { sellerUpdate.profile.state = sellerUpdate.state; bump(sellerUpdate.profile); }
  value.state = next; bump(value);
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
  assertEconomyStorageTransition(value.state, next, escrowItems(owner));
  // Revision capacity is checked before assigning the new state.
  bump(value); value.state = next;
  value.receipts.set(requestId.toLowerCase(), { signature, message: "Награда получена", acceptedRevision: value.revision });
  return view(owner, value, now);
}
