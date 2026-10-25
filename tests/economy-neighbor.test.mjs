import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/neighbor-model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/neighbor-rules.ts");
const market = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const neighborStore = await vite.ssrLoadModule("/lib/dev/neighbor-store.ts");
const { economyCatalog, economyMarketListingSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-10-23T09:00:00Z"), nextDay = Date.parse("2026-10-24T09:00:00Z"), sixHours = 21600000;
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());
const read = (player, at = now) => economy.getDevEconomy(player.token, at);
const row = player => globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
function player(home = 2, inventory = { wood: 20, stone: 20, fiber: 20, berries: 20 }) {
  const value = identities.createDevIdentity("Лесник", crypto.randomUUID());
  read(value);
  Object.assign(row(value).state.buildings, { home, bridge: home >= 2 ? 1 : 0, warehouse: 6 });
  row(value).state.completedExplorations = 1;
  row(value).state.inventory = { ...inventory };
  row(value).state.wallet.coins = 100000;
  return value;
}
const shop = (player, at = now) => economy.getDevEconomyNeighbor(player.token, at);
const settings = (changes = {}) => ({ ...structuredClone(model.neighborDefaultSettings), ...changes });
const configure = changes => neighborStore.configureDevNeighbor(settings(changes));
function buyCommand(player, offer, at = now) {
  return { requestId: crypto.randomUUID(), ownerPublicId: player.me.user.publicId, expectedRevision: read(player, at).revision,
    action: "buy_offer", targetId: offer.id, quantity: offer.quantity, totalPrice: offer.totalPrice };
}
const buy = (player, offer, at = now) => economy.commandDevEconomyNeighbor(player.token, buyCommand(player, offer, at), at);
function listing(player, quantity = 1, price = quantity * 30, at = now) {
  return economy.commandDevEconomyMarket(player.token, { requestId: crypto.randomUUID(), ownerPublicId: player.me.user.publicId,
    expectedRevision: read(player, at).revision, action: "create_listing", targetId: "wood", quantity, totalPrice: price }, at).listing;
}
const mine = (player, at = now) => economy.getDevEconomyMarket(player.token, {}, at).mine;

test("neighbor is an explicit world character with three personal accessible daily offers", () => {
  const owner = player(), view = shop(owner);
  assert.equal(model.neighborViewSchema.safeParse(view).success, true);
  assert.deepEqual(Object.keys(view.character).sort(), ["description", "id", "kind", "name", "world"]);
  assert.equal(view.character.id, "berest"); assert.equal(view.character.kind, "world_character");
  assert.equal(view.shop.offers.length, 3);
  assert.ok(view.shop.offers.every(offer => read(owner).unlockedItems.includes(offer.itemId)));
  assert.equal(new Set(view.shop.offers.map(offer => offer.itemId)).size, 3);
  assert.ok(view.shop.offers.every(offer => !offer.purchased && offer.quantity === 1));
  assert.equal(view.shop.refreshAt, "2026-10-24T00:00:00.000Z");
});

test("locked readers do not freeze an empty shop before restoring the market", () => {
  const owner = player(1);
  assert.equal(shop(owner).shop.reason, "market_locked");
  assert.equal(neighborStore.devNeighborCycle(owner.me.user.publicId, now), undefined);
  row(owner).state.buildings.home = 2; row(owner).state.buildings.bridge = 1;
  assert.equal(shop(owner).shop.offers.length, 3);
});

test("reloads, unlocks and settings changes never reroll today's daily IDs or frozen quotes", () => {
  const owner = player(), first = shop(owner).shop.offers;
  row(owner).state.buildings.home = 5;
  row(owner).state.unlockedItems = economyCatalog.items.map(item => item.id);
  configure({ offerQuantity: 5, sellPriceBps: 20000 });
  assert.deepEqual(shop(owner, now + 60000).shop.offers, first);
  const tomorrow = shop(owner, nextDay).shop.offers;
  assert.ok(tomorrow.every(offer => !first.some(old => old.id === offer.id)));
  assert.ok(tomorrow.every(offer => offer.quantity === 5));
});

test("buying stock commits coins, inventory, budget and a replayable receipt only once", () => {
  const owner = player(), offer = shop(owner).shop.offers[0], before = read(owner);
  const request = buyCommand(owner, offer);
  const result = economy.commandDevEconomyNeighbor(owner.token, request, now);
  assert.equal(result.state.wallet.coins, before.wallet.coins - offer.totalPrice);
  assert.equal(result.state.inventory[offer.itemId], (before.inventory[offer.itemId] ?? 0) + offer.quantity);
  assert.equal(result.state.revision, before.revision + 1);
  assert.equal(shop(owner).shop.offers[0].purchased, true);
  assert.equal(economy.commandDevEconomyNeighbor(owner.token, request, nextDay).replayed, true);
  assert.equal(read(owner, nextDay).wallet.coins, result.state.wallet.coins);
  assert.throws(() => buy(owner, offer), { code: "NEIGHBOR_OFFER_UNAVAILABLE" });
});

test("owner binding, personal offer membership, quote and revision are all checked", () => {
  const first = player(), second = player(), offer = shop(first).shop.offers[0]; shop(second);
  const request = buyCommand(first, offer), before = read(first);
  assert.throws(() => economy.commandDevEconomyNeighbor(second.token, request, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => buy(second, offer), { code: "NEIGHBOR_OFFER_UNAVAILABLE" });
  assert.throws(() => economy.commandDevEconomyNeighbor(first.token, { ...request, totalPrice: offer.totalPrice - 1 }, now), { code: "NEIGHBOR_QUOTE_CHANGED" });
  assert.throws(() => economy.commandDevEconomyNeighbor(first.token, { ...request, expectedRevision: before.revision + 1 }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.deepEqual(read(first), before);
});

test("failed storage, pause, unavailable item and daily budget never consume a daily offer", () => {
  const owner = player(), offer = shop(owner).shop.offers[0];
  const original = { ...row(owner).state.inventory };
  row(owner).state.buildings.warehouse = 1; row(owner).state.inventory = { wood: 50 };
  assert.throws(() => buy(owner, offer), { code: "ECONOMY_STORAGE_FULL" });
  row(owner).state.inventory = original; row(owner).state.buildings.warehouse = 6;
  configure({ enabled: false }); assert.throws(() => buy(owner, offer), { code: "NEIGHBOR_UNAVAILABLE" });
  configure({ allowedItemIds: [offer.itemId === "wood" ? "stone" : "wood"] });
  assert.throws(() => buy(owner, offer), { code: "NEIGHBOR_OFFER_UNAVAILABLE" });
  configure({});
  globalThis.__zhivDevEconomyStore.turnover.set(owner.me.user.publicId, { day: "2026-10-23", buysUsed: 2400, salesUsed: 0, barterUsed: 0 });
  assert.throws(() => buy(owner, offer), { code: "ECONOMY_MARKET_DAILY_LIMIT" });
  assert.equal(shop(owner).shop.offers[0].purchased, false);
});

test("GET neither buys a stale lot nor consumes a first-sale subsidy", () => {
  const owner = player(), lot = listing(owner);
  shop(owner, now + sixHours); read(owner, now + sixHours); mine(owner, now + sixHours);
  assert.equal(mine(owner, now + sixHours).find(row => row.id === lot.id).status, "active");
  assert.equal(shop(owner, now + sixHours).buying.usedLots, 0);
});

test("first sale has a 180-second floor, preserves the usual fee and waits for manual proceeds", () => {
  const owner = player(), lot = listing(owner), before = read(owner);
  assert.equal(economy.runDevNeighborTick(now + 179999), 0);
  assert.equal(economy.runDevNeighborTick(now + 180000), 1);
  assert.equal(economy.runDevNeighborTick(now + 180001), 0);
  const sold = mine(owner, now + 180000).find(row => row.id === lot.id);
  assert.equal(economyMarketListingSchema.safeParse(sold).success, true);
  assert.deepEqual(sold.sale, { buyerKind: "world_character", buyerCharacterId: "berest", buyerPublicId: null,
    buyerName: "Берест", buyerAvatarUrl: null, proceedsCoins: 28, claimedAt: null });
  assert.equal(read(owner, now + 180000).wallet.coins, before.wallet.coins);
  const claim = { requestId: crypto.randomUUID(), ownerPublicId: owner.me.user.publicId, expectedRevision: read(owner, now + 180000).revision,
    action: "claim_sale", targetId: lot.id, quantity: 1, totalPrice: 0 };
  const result = economy.commandDevEconomyMarket(owner.token, claim, now + 180000);
  assert.equal(result.state.wallet.coins, before.wallet.coins + 28);
  assert.equal(economy.commandDevEconomyMarket(owner.token, claim, now + 180001).replayed, true);
});

test("after the first trade normal six-hour eligibility and two-lot daily cap apply", () => {
  const owner = player(); listing(owner); listing(owner); listing(owner);
  assert.equal(economy.runDevNeighborTick(now + 180000), 1);
  assert.equal(economy.runDevNeighborTick(now + sixHours - 1), 0);
  assert.equal(economy.runDevNeighborTick(now + sixHours), 1);
  assert.equal(economy.runDevNeighborTick(now + sixHours * 2), 0);
  assert.equal(shop(owner, now + sixHours).buying.usedLots, 2);
});

test("price ceilings and per-lot, daily and global subsidy caps are independent", () => {
  const owner = player();
  const overpriced = listing(owner, 1, 40), tooLarge = listing(owner, 6, 180);
  assert.equal(economy.buyDevNeighborListing(overpriced.id, { now: now + sixHours }), false);
  assert.equal(economy.buyDevNeighborListing(tooLarge.id, { now: now + sixHours }), false);
  configure({ dailyBudgetCoins: 100, maxLotCoins: 100 });
  listing(owner, 3, 90, now + 1); listing(owner, 1, 30, now + 2);
  assert.equal(economy.runDevNeighborTick(now + sixHours + 2), 1);
  assert.equal(shop(owner, now + sixHours + 2).buying.spentCoins, 90);
  identities.resetDevStoreForTests(); configure({ globalDailyBudgetCoins: 50 });
  const first = player(), second = player(); listing(first); listing(second);
  assert.equal(economy.runDevNeighborTick(now + sixHours), 1);
  assert.equal(neighborStore.devNeighborGlobalSpent(now + sixHours), 30);
});

test("shop goods cannot be sold back to the neighbor that day and normal resale never profits", () => {
  const owner = player(); configure({ allowedItemIds: ["wood"] });
  const offer = shop(owner).shop.offers[0]; buy(owner, offer);
  const lot = listing(owner);
  assert.equal(economy.buyDevNeighborListing(lot.id, { now: now + sixHours }), false);
  assert.ok(rules.neighborBuyPriceCeiling("wood", 1, settings()) <= offer.totalPrice);
  assert.ok(market.marketMinimumPrice("wood", 1) <= offer.totalPrice);
});

test("floor-rounded NPC buy quotes prevent split-lot arbitrage for 55-coin fish dishes", () => {
  const config = model.neighborSettingsSchema.parse(settings({ sellPriceBps: 10000, buyPriceBps: 10000, offerQuantity: 2, allowedItemIds: ["grilled_fish"] }));
  const purchase = rules.neighborOfferPrice("grilled_fish", 2, config);
  const singleBuyCap = rules.neighborBuyPriceCeiling("grilled_fish", 1, config);
  assert.equal(purchase, 110); assert.equal(singleBuyCap, 50);
  assert.ok(2 * (singleBuyCap - market.marketSaleFee(singleBuyCap, 500)) < purchase);
  for (const item of model.neighborStockItems) for (const quantity of [1, 2, 3, 5]) {
    const cost = rules.neighborOfferPrice(item.id, quantity, config);
    const splitProceeds = quantity * rules.neighborBuyPriceCeiling(item.id, 1, config);
    assert.ok(splitProceeds <= cost, `${item.id}: split stock cannot print coins`);
  }
});

test("reset retains consumed stock, subsidy usage, experience and accepted purchase receipts", () => {
  const owner = player(); configure({ allowedItemIds: ["wood"] });
  const offer = shop(owner).shop.offers[0], request = buyCommand(owner, offer);
  economy.commandDevEconomyNeighbor(owner.token, request, now);
  const lot = listing(owner);
  assert.equal(economy.buyDevNeighborListing(lot.id, { now: nextDay }), true);
  economy.removeDevEconomyOwner(owner.me.user.publicId);
  assert.equal(neighborStore.devNeighborExperienced(owner.me.user.publicId), true);
  assert.equal(neighborStore.devNeighborUsage(owner.me.user.publicId, nextDay).usedLots, 1);
  assert.equal(economy.commandDevEconomyNeighbor(owner.token, request, nextDay).replayed, true);
  assert.equal(neighborStore.devNeighborCycle(owner.me.user.publicId, now).offers[0].purchased, true);
});

test("account merge adds subsidy usage and consumption and preserves first-sale experience", () => {
  const first = player(), second = player(); configure({ allowedItemIds: ["wood"] });
  const source = shop(first).shop.offers[0]; buy(first, source); shop(second);
  neighborStore.markDevNeighborExperienced(first.me.user.publicId);
  neighborStore.recordDevNeighborSale({ id: crypto.randomUUID(), listingId: crypto.randomUUID(), sellerPublicId: first.me.user.publicId,
    itemId: "stone", quantity: 1, totalPrice: 40, proceedsCoins: 38, createdAt: new Date(now).toISOString(), source: "auto" }, now);
  neighborStore.mergeDevNeighborOwners(first.me.user.publicId, second.me.user.publicId, now);
  assert.equal(neighborStore.devNeighborExperienced(second.me.user.publicId), true);
  assert.equal(neighborStore.devNeighborUsage(second.me.user.publicId, now).spentCoins, 40);
  assert.deepEqual(neighborStore.devNeighborBoughtItems(second.me.user.publicId, now), ["wood"]);
  assert.equal(shop(second).shop.offers[0].purchased, true);
});

test("a real buyer or seller cancellation wins the same listing exactly once", () => {
  const seller = player(), buyer = player(), soldLot = listing(seller);
  economy.getDevEconomyMarket(buyer.token, {}, now);
  economy.commandDevEconomyMarket(buyer.token, { requestId: crypto.randomUUID(), ownerPublicId: buyer.me.user.publicId,
    expectedRevision: read(buyer).revision, action: "buy_listing", targetId: soldLot.id, quantity: soldLot.quantity, totalPrice: soldLot.totalPrice }, now);
  assert.equal(economy.buyDevNeighborListing(soldLot.id, { now: now + sixHours }), false);
  const cancelled = listing(seller);
  economy.commandDevEconomyMarket(seller.token, { requestId: crypto.randomUUID(), ownerPublicId: seller.me.user.publicId,
    expectedRevision: read(seller).revision, action: "cancel_listing", targetId: cancelled.id, quantity: 1, totalPrice: 0 }, now);
  assert.equal(economy.buyDevNeighborListing(cancelled.id, { now: now + sixHours }), false);
  assert.equal(neighborStore.devNeighborGlobalSpent(now), 0);
  assert.equal(neighborStore.devNeighborExperienced(seller.me.user.publicId), true);
});

test("manual purchase bypasses waiting only, while pause, hours, price and budgets still apply", () => {
  const owner = player(), lot = listing(owner);
  configure({ activeFromHourUtc: 10, activeUntilHourUtc: 12 });
  assert.equal(economy.buyDevNeighborListing(lot.id, { now, manual: true }), false);
  configure({ enabled: false });
  assert.equal(economy.buyDevNeighborListing(lot.id, { now, manual: true }), false);
  configure({});
  assert.equal(economy.buyDevNeighborListing(lot.id, { now, manual: true, expectedTotalPrice: 40 }), false);
  assert.equal(economy.buyDevNeighborListing(lot.id, { now, manual: true, expectedTotalPrice: 30, playerPublicId: owner.me.user.publicId }), true);
  assert.equal(economy.buyDevNeighborListing(lot.id, { now, manual: true }), false);
});

test("settings accept administrator tuning while preserving integral values known geometry and ordinary stock", () => {
  for (const change of [{ maxLotsPerDay: -1 }, { dailyBudgetCoins: -1 }, { maxLotCoins: -1 }, { globalDailyBudgetCoins: -1 },
    { firstDelaySeconds: -1 }, { staleAfterSeconds: -1 }, { maxLotCoins: 10000000001 },
    { dailyBudgetCoins: Number.MAX_SAFE_INTEGER + 1 }, { offerQuantity: 0 }, { allowedItemIds: ["ancient_core"] }, { allowedItemIds: ["fish_common"] },
    { buildings: { home: 99, bridge: 1 } }, { activeFromHourUtc: 9, activeUntilHourUtc: 9 },
    { equipment: { palette: "unknown", head: null, neck: null, rod: null } }])
    assert.equal(model.neighborSettingsSchema.safeParse(settings(change)).success, false, JSON.stringify(change));
  assert.equal(model.neighborSettingsSchema.safeParse(settings({ activeFromHourUtc: 22, activeUntilHourUtc: 6 })).success, true);
  const overnight = settings({ activeFromHourUtc: 22, activeUntilHourUtc: 6 });
  assert.equal(rules.neighborActiveHour(overnight, Date.parse("2026-10-23T23:00:00Z")), true);
  assert.equal(rules.neighborActiveHour(overnight, Date.parse("2026-10-23T05:00:00Z")), true);
  assert.equal(rules.neighborActiveHour(overnight, now), false);
});

test("a bounded background scan rotates past one hundred permanently ineligible listings", () => {
  for (let ownerIndex = 0; ownerIndex < 10; ownerIndex++) {
    const owner = player(); row(owner).state.marketSlots = 10;
    for (let lotIndex = 0; lotIndex < 10; lotIndex++) listing(owner, 1, 60);
  }
  const owner = player(), eligible = listing(owner, 1, 30, now + 1);
  assert.equal(economy.runDevNeighborTick(now + sixHours + 1000), 0);
  assert.equal(economy.runDevNeighborTick(now + sixHours + 1000), 1);
  assert.equal(mine(owner, now + sixHours + 1000).find(lot => lot.id === eligible.id).status, "sold");
});

test("a maximum purchase quote charges the frozen price and a reused request cannot change its payload", () => {
  const owner = player(), offer = shop(owner).shop.offers[0], before = read(owner).wallet.coins;
  const request = { ...buyCommand(owner, offer), totalPrice: offer.totalPrice + 100 };
  assert.equal(economy.commandDevEconomyNeighbor(owner.token, request, now).state.wallet.coins, before - offer.totalPrice);
  assert.throws(() => economy.commandDevEconomyNeighbor(owner.token, { ...request, totalPrice: offer.totalPrice }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
});

test("a prior human sale remains experienced after reset deletes its sold listing", () => {
  const seller = player(), buyer = player(), sold = listing(seller);
  economy.getDevEconomyMarket(buyer.token, {}, now);
  economy.commandDevEconomyMarket(buyer.token, { requestId: crypto.randomUUID(), ownerPublicId: buyer.me.user.publicId,
    expectedRevision: read(buyer).revision, action: "buy_listing", targetId: sold.id, quantity: sold.quantity, totalPrice: sold.totalPrice }, now);
  const claim = { requestId: crypto.randomUUID(), ownerPublicId: seller.me.user.publicId,
    expectedRevision: read(seller).revision, action: "claim_sale", targetId: sold.id, quantity: 1, totalPrice: 0 };
  economy.commandDevEconomyMarket(seller.token, claim, now);
  economy.removeDevEconomyOwner(seller.me.user.publicId);
  read(seller, now + 1);
  Object.assign(row(seller).state.buildings, { home: 2, bridge: 1, warehouse: 6 });
  row(seller).state.completedExplorations = 1; row(seller).state.inventory = { wood: 10 };
  const next = listing(seller, 1, 30, now + 1);
  assert.equal(economy.getDevConfirmedMarketSales(seller.me.user.publicId), 0, "reset has actually removed the historical sold listing");
  assert.equal(economy.buyDevNeighborListing(next.id, { now: now + 180001 }), false);
  assert.equal(economy.buyDevNeighborListing(next.id, { now: now + sixHours + 1 }), true);
});


test("admin tuning accepts large caps independent budgets zero delays and finite catalog-sized stock", () => {
  const owner = player(5);
  row(owner).state.unlockedItems = economyCatalog.items.map(item => item.id);
  configure({ offerSlots: Number.MAX_SAFE_INTEGER, offerQuantity: 6, maxLotsPerDay: 20, dailyBudgetCoins: 100000,
    maxLotCoins: 3000, globalDailyBudgetCoins: 1000000, firstDelaySeconds: 0, staleAfterSeconds: 0,
    allowedItemIds: model.neighborStockItems.map(item => item.id) });
  const view = shop(owner);
  assert.ok(view.shop.offers.length > 3);
  assert.ok(view.shop.offers.length <= model.neighborStockItems.length);
  assert.ok(view.shop.offers.every(offer => offer.quantity === 6));
  assert.equal(model.neighborViewSchema.safeParse(view).success, true);
  assert.equal(model.neighborSettingsSchema.safeParse(settings({ maxLotCoins: 3000, dailyBudgetCoins: 300 })).success, true);
  assert.equal(model.neighborSettingsSchema.safeParse(settings({ offerSlots: 0, allowedItemIds: [] })).success, true);
});

test("an intentionally free six-item offer commits once without debiting coins", () => {
  const owner = player(5, {});
  configure({ allowedItemIds: ["wood"], offerQuantity: 6, sellPriceBps: 0 });
  const offer = shop(owner).shop.offers[0], before = read(owner), request = buyCommand(owner, offer);
  assert.equal(offer.totalPrice, 0);
  assert.equal(model.neighborCommandSchema.safeParse(request).success, true);
  const result = economy.commandDevEconomyNeighbor(owner.token, request, now);
  assert.equal(result.state.wallet.coins, before.wallet.coins);
  assert.equal(result.state.inventory.wood, 6);
  assert.equal(economy.commandDevEconomyNeighbor(owner.token, request, now).replayed, true);
  assert.equal(read(owner).inventory.wood, 6);
});

test("extreme multipliers do not overflow or produce invalid public quotes", () => {
  const owner = player(5), extreme = settings({ sellPriceBps: Number.MAX_SAFE_INTEGER, buyPriceBps: Number.MAX_SAFE_INTEGER,
    offerQuantity: 1000000000, allowedItemIds: ["wood"] });
  neighborStore.configureDevNeighbor(extreme);
  assert.equal(rules.neighborOfferPrice("wood", extreme.offerQuantity, extreme), Infinity);
  assert.equal(rules.neighborBuyPriceCeiling("wood", extreme.offerQuantity, extreme), 10000000000);
  const view = shop(owner);
  assert.deepEqual(view.shop.offers, []);
  assert.equal(model.neighborViewSchema.safeParse(view).success, true);
  assert.equal(rules.neighborOfferPrice("wood", 1000000000, settings({ sellPriceBps: 0 })), 0);
});
