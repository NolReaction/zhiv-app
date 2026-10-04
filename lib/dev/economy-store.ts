// Development adapter only. Production mutations are atomic Ktor/PostgreSQL transactions.
import { getDevIdentity, lookupDevUser } from "@/lib/dev/api-store";
import { consumeDevLegacyEconomy, hasDevLegacyJourney } from "@/lib/dev/world-store";
import { ECONOMY_MAX_BALANCE, economyCatalog, economyCommandSchema, marketCommandSchema, type EconomyCommand,
  type EconomyMarketListing, type EconomyResult, type EconomyState, type EconomyView, type MarketCommand, type MarketView } from "@/features/economy/model";
import { applyEconomyCommand, assertEconomyStorageTransition, convertLegacyEconomy, creditEconomyItems, economyStorage, EconomyRuleError, marketUnlocked, newEconomyState } from "@/features/economy/rules";
import { economyDevCommandSchema, type EconomyDevCommand } from "@/features/economy/dev-model";

type Receipt = { signature: string; message: string; acceptedRevision: number };
type ReceiptCommand = EconomyCommand | MarketCommand | EconomyDevCommand;
type Profile = { revision: number; state: EconomyState; receipts: Map<string, Receipt>; legacyJourneys: Set<string> };
type Listing = Omit<EconomyMarketListing, "owned" | "sellerName">;
type Store = { profiles: Map<string, Profile>; listings: Map<string, Listing> };
const globalStore = globalThis as typeof globalThis & { __zhivDevEconomyStore?: Store };
const store = () => globalStore.__zhivDevEconomyStore ??= { profiles: new Map(), listings: new Map() };
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
    store().profiles.set(owner, value);
  }
  value.state.buildings.warehouse ??= 1;
  value.state.buildings.kiln ??= 0;
  return { owner, value };
}
function view(owner: string, value: Profile, now: number): EconomyView {
  return { ownerPublicId: owner, revision: value.revision, serverTime: new Date(now).toISOString(), ...structuredClone(value.state),
    storage: economyStorage(value.state, escrowItems(owner)), catalog: structuredClone(economyCatalog) };
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
  return totals;
}
function commit(owner: string, value: Profile, next: EconomyState, command: ReceiptCommand, message: string, now: number): EconomyResult {
  value.state = next; bump(value);
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
  return view(owner, value, now);
}
export function commandDevEconomy(token: string | undefined, input: EconomyCommand, now = Date.now()): EconomyResult {
  const parsed = economyCommandSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_ECONOMY_COMMAND", "Некорректный запрос хозяйства", 400);
  const command = parsed.data, { owner, value } = profile(token, now);
  const replay = receipt(value, owner, command, now);
  if (replay) return replay;
  if (["start_exploration", "start_collection"].includes(command.action) && hasDevLegacyJourney(token, now)) return fail("ECONOMY_EXPLORER_BUSY", "Мохлик ещё в прежнем путешествии. Сначала подтвердите возвращение");
  const next = structuredClone(value.state);
  const reserved = escrowItems(owner);
  const message = applyEconomyCommand(next, command, now, () => command.requestId, reserved);
  assertEconomyStorageTransition(value.state, next, reserved);
  return commit(owner, value, next, command, message, now);
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
    case "grant_currency": {
      const currency = command.targetId as "coins" | "pearls";
      if (next.wallet[currency] + command.quantity > ECONOMY_MAX_BALANCE) return fail("ECONOMY_CAPACITY", "Кошелёк заполнен");
      next.wallet[currency] += command.quantity;
      message = `DEV: выдано ${command.quantity} ${currency === "coins" ? "монет" : "жемчужин"}`;
      break;
    }
    case "grant_item":
      creditEconomyItems(next, { [command.targetId]: command.quantity });
      message = `DEV: выдано ${command.quantity} × ${economyCatalog.items.find(item => item.id === command.targetId)!.name}`;
      break;
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
      if (next.jobs.some(job => job.targetId === command.targetId && (job.kind === "construction" || job.kind === "production")))
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
  if (Object.entries(next.inventory).some(([item, quantity]) => quantity + (reserved[item] ?? 0) > ECONOMY_MAX_BALANCE))
    return fail("ECONOMY_CAPACITY", "Сначала освободите место для этого материала");
  return commit(owner, value, next, command, message, now);
}
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
  for (const [id, listing] of store().listings) if (listing.sellerPublicId === owner) store().listings.delete(id);
}
function publicListing(listing: Listing, owner: string, token: string | undefined): EconomyMarketListing {
  const seller = lookupDevUser(token, listing.sellerPublicId);
  return { ...listing, sellerName: seller.kind === "ok" ? seller.value.user.displayName : "Житель леса", owned: listing.sellerPublicId === owner };
}
function requireMarket(state: EconomyState) {
  if (!marketUnlocked(state)) fail("ECONOMY_MARKET_LOCKED", "Рынок откроется после улучшения дома до уровня 2 и возвращения из первого исследования");
}
const compareListings = (a: Listing, b: Listing) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
export function getDevEconomyMarket(token: string | undefined, options: { cursor?: string; limit?: number; ownerPublicId?: string } = {}, now = Date.now()): MarketView {
  const { owner } = profile(token, now);
  if (options.ownerPublicId && options.ownerPublicId !== owner) fail("ECONOMY_OWNER_CHANGED", "Аккаунт изменился. Обновите рынок");
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("INVALID_ECONOMY_QUERY", "Некорректный размер страницы", 400);
  let boundary: { createdAt: string; id: string } | null = null;
  if (options.cursor != null) {
    try {
      if (options.cursor.length > 160 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw Error();
      const [createdAt, id, extra] = Buffer.from(options.cursor, "base64url").toString("utf8").split("|");
      if (extra || !Number.isFinite(Date.parse(createdAt)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw Error();
      boundary = { createdAt: new Date(createdAt).toISOString(), id: id.toLowerCase() };
    } catch { fail("INVALID_ECONOMY_QUERY", "Некорректная страница рынка", 400); }
  }
  const active = [...store().listings.values()].filter(item => item.status === "active").sort(compareListings);
  const mine = active.filter(item => item.sellerPublicId === owner).map(item => publicListing(item, owner, token));
  const candidates = active.filter(item => item.sellerPublicId !== owner && (!boundary || item.createdAt < boundary.createdAt || item.createdAt === boundary.createdAt && item.id < boundary.id));
  const page = candidates.slice(0, limit), last = page.at(-1);
  return { listings: page.map(item => publicListing(item, owner, token)), mine, serverTime: new Date(now).toISOString(),
    nextCursor: candidates.length > limit && last ? Buffer.from(`${last.createdAt}|${last.id}`).toString("base64url") : null };
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
    if (command.totalPrice > item.baseSellPrice * economyCatalog.market.maxPriceMultiplier * command.quantity) return fail("ECONOMY_MARKET_PRICE", "Цена лота вне разрешённого диапазона", 400);
    if ([...store().listings.values()].filter(item => item.sellerPublicId === owner && item.status === "active").length >= economyCatalog.market.maxListings) return fail("ECONOMY_MARKET_LIMIT", "На прилавке уже 10 лотов");
    if ((next.inventory[item.id] ?? 0) < command.quantity) return fail("ECONOMY_RESOURCES", "Не хватает предметов для лота");
    next.inventory[item.id] -= command.quantity;
    if (!next.inventory[item.id]) delete next.inventory[item.id];
    const reserved = escrowItems(owner);
    assertEconomyStorageTransition(value.state, next, reserved, { ...reserved, [item.id]: (reserved[item.id] ?? 0) + command.quantity });
    const listing: Listing = { id: crypto.randomUUID(), sellerPublicId: owner, itemId: item.id, quantity: command.quantity,
      totalPrice: command.totalPrice, status: "active", createdAt: new Date(now).toISOString(), closedAt: null };
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
  const seller = store().profiles.get(listing.sellerPublicId);
  if (!seller) return fail("ECONOMY_MARKET_NOT_ACTIVE", "Продавец больше недоступен");
  if (next.wallet.coins < listing.totalPrice) return fail("ECONOMY_RESOURCES", "Не хватает монет");
  if (seller.state.wallet.coins + listing.totalPrice > ECONOMY_MAX_BALANCE || seller.revision >= Number.MAX_SAFE_INTEGER) return fail("ECONOMY_CAPACITY", "Продавец пока не может принять оплату");
  creditEconomyItems(next, { [listing.itemId]: listing.quantity });
  assertEconomyStorageTransition(value.state, next, escrowItems(owner));
  next.wallet.coins -= listing.totalPrice;
  seller.state.wallet.coins += listing.totalPrice; bump(seller);
  listing.status = "sold"; listing.closedAt = new Date(now).toISOString();
  return { ...commit(owner, value, next, command, "Покупка получена, монеты отправлены продавцу", now), listing: publicListing(listing, owner, token) };
}
