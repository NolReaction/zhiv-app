import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCatalog: catalog, marketViewSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/market-rules.ts");
const now = Date.parse("2026-10-06T12:00:00Z"), tomorrow = Date.parse("2026-10-07T00:00:00Z");
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
const shelf = (p, at = now) => economy.getDevEconomyMarket(p.token, {}, at);
function player(home = 2, inventory = { berries: 100 }) {
  const p = identities.createDevIdentity("Лесник", crypto.randomUUID()); read(p);
  row(p).state.wallet.coins = 1000000; row(p).state.inventory = inventory;
  row(p).state.buildings.home = home; row(p).state.completedExplorations = 1;
  return p;
}
const command = (p, action, targetId, quantity = 1, totalPrice = 0, at = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p, at).revision, action, targetId, quantity, totalPrice });
const trade = (p, action, targetId, quantity = 1, totalPrice = 0, at = now) => economy.commandDevEconomyMarket(p.token, command(p, action, targetId, quantity, totalPrice, at), at);
const offer = (p, quantity = 1, multiplier = 1, at = now) => trade(p, "create_listing", "berries", quantity, quantity * 30 * multiplier, at).listing;
const buy = (p, lot, at = now) => trade(p, "buy_listing", lot.id, lot.quantity, lot.totalPrice, at);
const barter = (p, action, fields, at = now) => economy.commandDevEconomyBarter(p.token, { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p, at).revision, action, ...fields }, at);
const barterShelf = (p, at = now) => economy.getDevEconomyBarter(p.token, at);
const relics = { ancient_core: 3, moon_crystal: 3, living_resin: 3 };
const barterOffer = (p, at = now) => barter(p, "create_offer", { offeredItemId: "ancient_core", requestedItemId: "moon_crystal" }, at).offer;

test("invalid progression levels fail closed in the shared market helpers", () => {
  for (const home of [0, 1, 6, 2.5, NaN, Infinity]) {
    assert.equal(rules.marketDailyLimit(home), 0);
    assert.deepEqual(rules.marketHomeBand(home), { min: 1, max: 1 });
    assert.equal(rules.marketSameHomeBand(home, 2), false);
    assert.equal(rules.marketSameHomeBand(2, home), false);
  }
});

test("current house bands allow 2–3 and 4–5 while blocking both cross-band directions", () => {
  assert.deepEqual(catalog.market.dailyTradeValueByHome, [0, 2400, 4800, 9600, 14400]);
  for (const [sellerHome, buyerHome, visible] of [[2, 3, true], [3, 2, true], [4, 5, true], [5, 4, true], [5, 2, false], [2, 5, false]]) {
    identities.resetDevStoreForTests();
    const seller = player(sellerHome), buyer = player(buyerHome, {}), lot = offer(seller);
    assert.equal(shelf(buyer).listings.some(item => item.id === lot.id), visible);
    if (visible) assert.equal(buy(buyer, lot).state.inventory.berries, 1);
    else {
      // Even an injected/old showcase cannot bypass the authoritative purchase check.
      globalThis.__zhivDevEconomyStore.showcases.get(buyer.me.user.publicId).ids = [lot.id];
      const before = [read(seller), read(buyer)];
      assert.throws(() => buy(buyer, lot), { code: "ECONOMY_MARKET_HOME_BAND" });
      assert.deepEqual([read(seller), read(buyer)], before);
    }
  }
});

test("seller or buyer upgrading across a band cannot spend an already selected lot", () => {
  for (const changing of ["seller", "buyer"]) {
    identities.resetDevStoreForTests();
    const seller = player(3), buyer = player(3, {}), lot = offer(seller); shelf(buyer);
    row(changing === "seller" ? seller : buyer).state.buildings.home = 4;
    assert.equal(shelf(buyer).listings.length, 0);
    const before = [read(seller), read(buyer)];
    assert.throws(() => buy(buyer, lot), { code: "ECONOMY_MARKET_HOME_BAND" });
    assert.deepEqual([read(seller), read(buyer)], before);
    assert.equal(trade(seller, "cancel_listing", lot.id).state.inventory.berries, 100);
  }
});

test("buyer daily volume uses catalog value, not a chosen price; replay and F5 do not replenish it", () => {
  const sellers = [player(), player(), player()], buyer = player(2, {});
  const lots = [offer(sellers[0], 40, 2), offer(sellers[1], 40), offer(sellers[2])];
  shelf(buyer);
  const request = command(buyer, "buy_listing", lots[0].id, lots[0].quantity, lots[0].totalPrice);
  economy.commandDevEconomyMarket(buyer.token, request, now); buy(buyer, lots[1]);
  const used = shelf(buyer).tradeBudget;
  assert.equal(used.buysUsed, 2400); assert.equal(used.salesUsed, 0); assert.equal(used.limit, 2400);
  assert.equal(used.resetsAt, new Date(tomorrow).toISOString());
  assert.equal(marketViewSchema.safeParse(shelf(buyer)).success, true);
  const before = [read(buyer), read(sellers[2])];
  assert.throws(() => buy(buyer, lots[2]), { code: "ECONOMY_MARKET_DAILY_LIMIT" });
  assert.deepEqual([read(buyer), read(sellers[2])], before);
  assert.equal(economy.commandDevEconomyMarket(buyer.token, request, tomorrow).replayed, true);
  assert.equal(shelf(buyer, tomorrow).tradeBudget.buysUsed, 0, "old receipt does not spend tomorrow's quota");
  buy(buyer, lots[2], tomorrow);
  assert.equal(shelf(buyer, tomorrow).tradeBudget.buysUsed, 30);
});

test("one seller shares a daily sales budget across different buyers, independently of purchases", () => {
  const seller = player(), buyers = [player(2, {}), player(2, {}), player(2, {})];
  const lots = [offer(seller, 40), offer(seller, 40), offer(seller)];
  for (let i = 0; i < buyers.length; i++) {
    const selected = shelf(buyers[i]);
    // A persisted subset models three separately scheduled viewers, each legitimately selected.
    globalThis.__zhivDevEconomyStore.showcases.get(buyers[i].me.user.publicId).ids = [lots[i].id];
    assert.ok(selected);
  }
  buy(buyers[0], lots[0]); buy(buyers[1], lots[1]);
  assert.equal(shelf(seller).tradeBudget.salesUsed, 2400);
  const before = [read(seller), read(buyers[2])];
  assert.throws(() => buy(buyers[2], lots[2]), { code: "ECONOMY_MARKET_SELLER_DAILY_LIMIT" });
  assert.deepEqual([read(seller), read(buyers[2])], before);
  const otherSeller = player(), incoming = offer(otherSeller);
  globalThis.__zhivDevEconomyStore.showcases.get(seller.me.user.publicId).ids = [incoming.id];
  buy(seller, incoming);
  assert.equal(shelf(seller).tradeBudget.buysUsed, 30);
  assert.equal(shelf(seller).tradeBudget.salesUsed, 2400);
});

test("fee is charged once, rounded upward, and does not disappear through lot splitting", () => {
  const seller = player(), buyer = player(2, {}), lot = offer(seller);
  assert.equal(lot.feeBps, 500); shelf(buyer);
  const before = read(seller).wallet.coins + read(buyer).wallet.coins;
  buy(buyer, lot);
  assert.equal(read(seller).wallet.coins, 1000028);
  assert.equal(read(seller).wallet.coins + read(buyer).wallet.coins, before - 2);
  for (let quantity = 1; quantity <= 99; quantity++)
    assert.ok(rules.marketSaleFee(30, 500) * quantity >= rules.marketSaleFee(30 * quantity, 500));
});

test("legacy zero-fee quotes survive, over-ceiling quotes are kept refundable but cannot trade", () => {
  const seller = player(), buyer = player(2, {}), fair = offer(seller), overpriced = offer(seller);
  const saved = globalThis.__zhivDevEconomyStore.listings;
  saved.get(fair.id).feeBps = 0; saved.get(overpriced.id).totalPrice = 150;
  assert.deepEqual(shelf(buyer).listings.map(item => item.id), [fair.id]);
  buy(buyer, fair); assert.equal(read(seller).wallet.coins, 1000030);
  globalThis.__zhivDevEconomyStore.showcases.get(buyer.me.user.publicId).ids = [overpriced.id];
  assert.throws(() => buy(buyer, { ...overpriced, totalPrice: 150 }), { code: "ECONOMY_MARKET_ITEM_LOCKED" });
  assert.equal(shelf(seller).mine[0].totalPrice, 150);
  assert.equal(trade(seller, "cancel_listing", overpriced.id).state.inventory.berries, 99);
});

test("an unfillable new lot is refused without escrow and a higher-house daily budget permits it", () => {
  const low = player(), before = read(low);
  assert.throws(() => offer(low, 81), { code: "ECONOMY_MARKET_DAILY_LOT_LIMIT" });
  assert.deepEqual(read(low), before);
  assert.equal(offer(low, 80).quantity, 80);
  const high = player(3); assert.equal(offer(high, 99).quantity, 99);
});

test("failed funds or capacity validation does not consume either daily budget", () => {
  const seller = player(), buyer = player(2, {}), lot = offer(seller, 2); shelf(buyer);
  row(buyer).state.wallet.coins = 0;
  assert.throws(() => buy(buyer, lot), { code: "ECONOMY_RESOURCES" });
  row(buyer).state.wallet.coins = 10000; row(buyer).state.inventory = { wood: 200 };
  assert.throws(() => buy(buyer, lot), { code: "ECONOMY_STORAGE_FULL" });
  assert.equal(shelf(buyer).tradeBudget.buysUsed, 0); assert.equal(shelf(seller).tradeBudget.salesUsed, 0);
  assert.equal(globalThis.__zhivDevEconomyStore.listings.get(lot.id).status, "active");
});

test("profile reset does not refund daily volume and a house upgrade only changes the cap", () => {
  const seller = player(), buyer = player(2, {}), lot = offer(seller, 80); shelf(buyer); buy(buyer, lot);
  row(buyer).state.buildings.home = 3;
  assert.equal(shelf(buyer).tradeBudget.buysUsed, 2400); assert.equal(shelf(buyer).tradeBudget.limit, 4800);
  economy.removeDevEconomyOwner(buyer.me.user.publicId); read(buyer);
  row(buyer).state.buildings.home = 2; row(buyer).state.completedExplorations = 1;
  assert.equal(shelf(buyer).tradeBudget.buysUsed, 2400);
});

test("relic trade uses current house bands and remains refundable after a seller upgrade", () => {
  const seller = player(3, { ...relics }), buyer = player(3, { ...relics }), high = player(4, { ...relics });
  const lot = barterOffer(seller);
  assert.equal(barterShelf(high).offers.length, 0);
  assert.equal(barterShelf(buyer).offers[0].id, lot.id);
  row(seller).state.buildings.home = 4;
  assert.equal(barterShelf(buyer).offers.length, 0);
  const before = [read(seller), read(buyer)];
  assert.throws(() => barter(buyer, "accept_offer", { offerId: lot.id }), { code: "ECONOMY_BARTER_HOME_BAND" });
  assert.deepEqual([read(seller), read(buyer)], before);
  assert.equal(barter(seller, "cancel_offer", { offerId: lot.id }).state.inventory.ancient_core, 3);
});

test("one successful relic exchange counts for both sides and prevents switching roles or replay for more quota", () => {
  const seller = player(3, { ...relics }), buyer = player(3, { ...relics }), third = player(3, { ...relics });
  const lot = barterOffer(seller); barterShelf(buyer);
  const request = { requestId: crypto.randomUUID(), ownerPublicId: buyer.me.user.publicId, expectedRevision: read(buyer).revision, action: "accept_offer", offerId: lot.id };
  economy.commandDevEconomyBarter(buyer.token, request, now);
  assert.equal(barterShelf(buyer).dailyLimit.used, 1); assert.equal(barterShelf(seller).dailyLimit.used, 1);
  assert.equal(economy.commandDevEconomyBarter(buyer.token, request, now).replayed, true);
  const second = barterOffer(buyer); barterShelf(third);
  const before = [read(buyer), read(third)];
  assert.throws(() => barter(third, "accept_offer", { offerId: second.id }), { code: "ECONOMY_BARTER_DAILY_LIMIT" });
  assert.deepEqual([read(buyer), read(third)], before);
  assert.equal(barterShelf(third).dailyLimit.used, 0);
  assert.equal(economy.commandDevEconomyBarter(buyer.token, request, tomorrow).replayed, true);
  barterShelf(third, tomorrow); barter(third, "accept_offer", { offerId: second.id }, tomorrow);
  assert.equal(barterShelf(buyer, tomorrow).dailyLimit.used, 1);
});
