import assert from "node:assert/strict";

const DAY = 86_400_000, HOUR = 3_600_000;
let activeAdapter = false;
const devKeys = () => Object.getOwnPropertyNames(globalThis).filter(key => key.startsWith("__zhivDev"));

/** Run the real DEV market transaction against the simulator's already funded
 * state. Bootstrap supplies identity only: its initial economy is discarded,
 * never added to the player's wallet or stock. Only one isolated case may own
 * DEV globals at a time; close() restores any previous test context.
 */
export function createNeighborScenario({ identities, economyStore, neighborStore, neighborRules, market,
  state, now, ownerPublicId }) {
  assert(!activeAdapter, "Close the previous neighbor scenario before opening another");
  assert(!globalThis.__zhivDevNeighborStore?.timer, "Neighbor scenarios require an isolated process without a live DEV timer");
  assert(Number.isFinite(now) && /^\d{4}-\d{4}-\d{4}$/.test(ownerPublicId), "Synthetic owner and simulation time are required");
  const previousGlobals = new Map(devKeys().map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of previousGlobals.keys()) delete globalThis[key];
  activeAdapter = true;
  let closed = false, context;
  function close() {
    if (closed) return;
    closed = true;
    neighborStore.resetDevNeighborStoreForTests();
    for (const key of devKeys()) delete globalThis[key];
    for (const [key, descriptor] of previousGlobals) Object.defineProperty(globalThis, key, descriptor);
    activeAdapter = false;
  }
  try {
    const original = structuredClone(state);
    const identity = identities.createDevIdentity("Симулятор рынка", crypto.randomUUID(), "UTC");
    const store = globalThis.__zhivDevStore;
    const userId = store.publicIds.get(identity.me.user.publicId);
    assert(userId && store.users.has(userId), "DEV identity must exist before binding its economy");
    store.publicIds.delete(identity.me.user.publicId);
    store.users.get(userId).publicId = ownerPublicId;
    store.publicIds.set(ownerPublicId, userId);
    economyStore.initializeDevEconomy(identity.token, now);
    const row = globalThis.__zhivDevEconomyStore.profiles.get(ownerPublicId);
    assert(row, "DEV economy must exist before transferring the simulation state");
    row.state = state;
    assert.deepEqual(state, original, "Identity bootstrap must not grant simulator currency or items");
    context = { identity, row };
  } catch (error) { close(); throw error; }

  const requireOpen = () => assert(!closed, "Neighbor scenario is closed");
  const rawListings = () => [...globalThis.__zhivDevEconomyStore.listings.values()]
    .filter(row => row.sellerPublicId === ownerPublicId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  function syncState() {
    const next = context.row.state;
    if (next !== state) {
      // Public responses conceal private rare-drop clocks and fishing seeds.
      // Keep the real stored state, including unfinished jobs and their terms.
      for (const key of Object.keys(state)) if (!(key in next)) delete state[key];
      Object.assign(state, next);
      context.row.state = state;
    }
    const timer = globalThis.__zhivDevNeighborStore?.timer;
    if (timer) { clearInterval(timer); delete globalThis.__zhivDevNeighborStore.timer; }
  }
  function usage(at) {
    requireOpen();
    const used = neighborStore.devNeighborUsage(ownerPublicId, at);
    const turnover = globalThis.__zhivDevEconomyStore.turnover.get(ownerPublicId);
    return { ...used, globalSpentCoins: neighborStore.devNeighborGlobalSpent(at),
      marketSalesUsed: turnover?.day === market.marketDay(at) ? turnover.salesUsed : 0,
      marketLimit: market.marketDailyLimit(state.buildings.home ?? 1) };
  }
  function command(action, targetId, quantity = 1, totalPrice = 0, at) {
    requireOpen(); assert(Number.isFinite(at), "A market command needs the simulation clock");
    assert(["create_listing", "claim_sale", "cancel_listing"].includes(action), "Only funded seller operations belong to this scenario");
    try {
      return economyStore.commandDevEconomyMarket(context.identity.token, { requestId: crypto.randomUUID(), ownerPublicId,
        expectedRevision: context.row.revision, action, targetId, quantity, totalPrice }, at);
    } finally { syncState(); }
  }
  function tick(at) {
    requireOpen(); assert(Number.isFinite(at), "A neighbor tick needs the simulation clock");
    const sales = [];
    for (const listing of rawListings().filter(row => row.status === "active")) {
      if (!economyStore.buyDevNeighborListing(listing.id, { now: at })) continue;
      const paid = globalThis.__zhivDevEconomyStore.listings.get(listing.id);
      assert.equal(paid.sale?.buyerCharacterId, "berest");
      sales.push({ itemId: paid.itemId, quantity: paid.quantity, totalPrice: paid.totalPrice,
        proceedsCoins: paid.sale.proceedsCoins, feeCoins: paid.totalPrice - paid.sale.proceedsCoins,
        createdAt: paid.createdAt, closedAt: paid.closedAt });
    }
    syncState();
    return { sales, automaticTransactions: sales.length };
  }
  function quote(itemId, quantity) {
    requireOpen();
    const settings = neighborStore.devNeighborSettings();
    if (!settings.allowedItemIds.includes(itemId) || !market.marketItemUnlocked(state, itemId)) return 0;
    const gross = Math.min(neighborRules.neighborBuyPriceCeiling(itemId, quantity, settings), settings.maxLotCoins,
      settings.dailyBudgetCoins, settings.globalDailyBudgetCoins);
    const rounded = Math.floor(gross / 10) * 10;
    return rounded >= market.marketMinimumPrice(itemId, quantity) ? rounded : 0;
  }
  function nextDue(at) {
    requireOpen();
    const settings = neighborStore.devNeighborSettings();
    if (!settings.enabled || !settings.autoBuyEnabled || !market.economyMarketUnlocked(state)) return null;
    const firstSale = !neighborStore.devNeighborExperienced(ownerPublicId) && !economyStore.getDevConfirmedMarketSales(ownerPublicId);
    const due = [];
    for (const listing of rawListings().filter(row => row.status === "active")) {
      const baseValue = market.marketMinimumPrice(listing.itemId, listing.quantity);
      if (listing.totalPrice > settings.dailyBudgetCoins || listing.totalPrice > settings.globalDailyBudgetCoins
        || baseValue > market.marketDailyLimit(state.buildings.home ?? 1) || settings.maxLotsPerDay < 1) continue;
      let candidate = Math.max(at, Date.parse(listing.createdAt) + (firstSale ? settings.firstDelaySeconds : settings.staleAfterSeconds) * 1000);
      // At most the next UTC day is needed for a renewable budget. Advance to
      // a real active hour; never shorten the listing's required waiting time.
      for (let attempt = 0; attempt < 3; attempt++) {
        for (let hour = 0; hour < 25 && !neighborRules.neighborActiveHour(settings, candidate); hour++)
          candidate = (Math.floor(candidate / HOUR) + 1) * HOUR;
        const spent = usage(candidate);
        const reason = neighborRules.neighborListingReason(listing, state, settings, { now: candidate, firstSale,
          usage: spent, globalSpentCoins: spent.globalSpentCoins, boughtItemIds: neighborStore.devNeighborBoughtItems(ownerPublicId, candidate) });
        if (!reason && spent.marketSalesUsed + baseValue <= spent.marketLimit) { due.push(candidate); break; }
        if (["lots_limit", "daily_budget", "global_budget", "shop_resale"].includes(reason)
          || !reason && spent.marketSalesUsed + baseValue > spent.marketLimit) {
          candidate = (Math.floor(candidate / DAY) + 1) * DAY;
        } else break;
      }
    }
    return due.length ? Math.min(...due) : null;
  }
  return {
    get settings() { requireOpen(); return neighborStore.devNeighborSettings(); },
    command, tick, usage, quote, nextDue, close,
    confirmedSales() { requireOpen(); return economyStore.getDevConfirmedMarketSales(ownerPublicId); },
    listings() { requireOpen(); return structuredClone(rawListings()); },
    escrowItems() {
      requireOpen(); const items = {};
      for (const listing of rawListings()) if (listing.status === "active")
        items[listing.itemId] = (items[listing.itemId] ?? 0) + listing.quantity;
      return items;
    },
  };
}
