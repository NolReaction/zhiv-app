import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCatalog: catalog, marketViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const { economyLocalSellPrice } = await vite.ssrLoadModule("/features/economy/domain/local-sale.ts");
const now = Date.parse("2026-10-05T12:00:00Z"), windowMs = catalog.market.showcaseRefreshSeconds * 1000;
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const market = (p, at = now, options = {}) => economy.getDevEconomyMarket(p.token, options, at);
function player(home = 2, inventory = { berries: 100 }, unlockedItems = Object.keys(inventory)) {
  const p = identities.createDevIdentity("Лесник", crypto.randomUUID()); read(p);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.wallet.coins = 1000000; row.state.inventory = inventory; row.state.buildings.home = home; row.state.completedExplorations = 1;
  row.state.unlockedItems = [...unlockedItems]; row.state.itemUnlockVersion = 1;
  return p;
}
const command = (p, action, targetId, quantity = 1, totalPrice = 0, at = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p, at).revision, action, targetId, quantity, totalPrice });
const trade = (p, action, target, quantity = 1, price = 0, at = now) => economy.commandDevEconomyMarket(p.token, command(p, action, target, quantity, price, at), at);
const offer = (p, item = "berries", quantity = 1, price = rules.marketMinimumPrice(item, quantity), at = now) => trade(p, "create_listing", item, quantity, price, at).listing;
const buy = (p, lot, at = now) => trade(p, "buy_listing", lot.id, lot.quantity, lot.totalPrice, at);

test("catalog source tiers describe items while permanent discovery controls actual trade access", () => {
  for (const item of catalog.items.filter(item => item.tradable)) assert.ok(Number.isFinite(rules.marketRequiredHomeLevel(item.id)), item.id);
  assert.equal(rules.marketRequiredHomeLevel("charcoal"), 2, "kiln construction gate dominates recipe home 1");
  assert.equal(rules.marketRequiredHomeLevel("resin"), 3, "old forest is an earlier source");
  assert.equal(rules.marketRequiredHomeLevel("tools"), 4);
  assert.equal(rules.marketRequiredHomeLevel("reinforced_parts"), 4);
  assert.equal(rules.marketRequiredHomeLevel("fish_rare"), 1);
  for (const bait of catalog.fishing.baits) assert.equal(rules.marketRequiredHomeLevel(bait.itemId), bait.requiredHomeLevel);
  assert.equal(rules.marketRequiredHomeLevel("fish_legendary"), 4);
  assert.equal(rules.marketItemUnlocked({ buildings: { home: 4, workshop: 0 }, catalog }, "tools"), false,
    "a high home without the source does not open tools");
  assert.equal(rules.marketItemUnlocked({ buildings: { home: 3, workshop: 5 } }, "tools"), false);
  assert.equal(rules.marketItemUnlocked({ buildings: { home: 3, workshop: 0 }, catalog, unlockedItems: ["tools"] }, "tools"), true,
    "permanent access survives a later unavailable source");
  assert.equal(rules.marketRequiredHomeLevel("pearls"), Infinity);
});

test("unknown gift stock cannot bypass bait or legendary tackle discovery, including direct stale purchases", () => {
  for (const [itemId, home] of [["firefly_bait", 3], ["fish_legendary", 4]]) {
    const low = player(home, { [itemId]: 1 }, []), beforeLow = read(low);
    assert.throws(() => offer(low, itemId), { code: "ECONOMY_MARKET_ITEM_LOCKED" });
    assert.deepEqual(read(low), beforeLow, "new gift stock stays owned; rejection cannot consume or open it");
    const seller = player(home, { [itemId]: 2 }), lot = offer(seller, itemId);
    assert.ok(!market(low).listings.some(item => item.id === lot.id));
    assert.throws(() => buy(low, lot), { code: "ECONOMY_MARKET_SHOWCASE_CHANGED" });

    const high = player(home, {}, [itemId]), row = globalThis.__zhivDevEconomyStore.profiles.get(high.me.user.publicId);
    assert.ok(market(high).listings.some(item => item.id === lot.id));
    row.state.unlockedItems = [];
    const denied = read(high);
    assert.throws(() => buy(high, lot), { code: "ECONOMY_MARKET_ITEM_LOCKED" });
    assert.deepEqual(read(high), denied);
    row.state.unlockedItems = [itemId];
    const paid = buy(high, lot).state;
    assert.equal(paid.inventory[itemId], 1);
    assert.deepEqual(paid.fishing.catches, {}, "buying class stock does not open a species discovery");

    const cancel = offer(seller, itemId);
    const sellerRow = globalThis.__zhivDevEconomyStore.profiles.get(seller.me.user.publicId);
    sellerRow.state.buildings.home = home - 1; sellerRow.state.unlockedItems = [];
    assert.equal(trade(seller, "cancel_listing", cancel.id).state.inventory[itemId], 1,
      "an old listing stays refundable after its source becomes unavailable");
  }
});

test("whole-lot floor prevents immediate NPC arbitrage for every item and preserves the maximum", () => {
  for (const item of catalog.items.filter(item => item.tradable)) {
    const seller = player(5, { [item.id]: 2 });
    const floor = rules.marketMinimumPrice(item.id, 2);
    assert.throws(() => offer(seller, item.id, 2, floor - 1), { code: "ECONOMY_MARKET_PRICE" }, item.id);
    const npc = catalog.fishing.classes.some(group => group.itemId === item.id) ? item.baseSellPrice * 2 : economyLocalSellPrice(item.baseSellPrice, 2, catalog.localBuyer, item.id);
    assert.ok(floor >= npc, item.id);
    const legalBase = Math.ceil(item.baseSellPrice / 10) * 10;
    if (legalBase !== item.baseSellPrice) assert.throws(() => offer(seller, item.id, 1, item.baseSellPrice), { code: "ECONOMY_MARKET_PRICE" });
    assert.equal(offer(seller, item.id, 1, legalBase).totalPrice, legalBase);
    assert.equal(offer(seller, item.id, 1, item.baseSellPrice * catalog.market.maxPriceMultiplier).totalPrice, item.baseSellPrice * catalog.market.maxPriceMultiplier);
  }
});

test("persisted showcase limits diversity, blocks ID/cursor bypass and never refills bought slots", () => {
  const sellers = Array.from({ length: 8 }, () => player());
  const lots = sellers.flatMap(seller => Array.from({ length: 4 }, () => offer(seller)));
  const buyer = player(2, {}), first = market(buyer);
  assert.equal(marketViewSchema.safeParse(first).success, true);
  assert.equal(first.listings.length, 12); assert.equal(first.nextCursor, null);
  for (const seller of sellers) assert.ok(first.listings.filter(lot => lot.sellerPublicId === seller.me.user.publicId).length <= 2);
  assert.deepEqual(market(buyer, now + 1).listings, first.listings);
  assert.throws(() => market(buyer, now, { cursor: "anything" }), { code: "INVALID_ECONOMY_QUERY" });
  assert.throws(() => market(buyer, now, { limit: 13 }), { code: "INVALID_ECONOMY_QUERY" });
  const hidden = lots.find(lot => !first.listings.some(item => item.id === lot.id));
  const before = read(buyer);
  assert.throws(() => buy(buyer, hidden), { code: "ECONOMY_MARKET_SHOWCASE_CHANGED" });
  assert.deepEqual(read(buyer), before);
  for (const lot of first.listings) buy(buyer, lot);
  assert.equal(market(buyer, now + 2).listings.length, 0);
  assert.equal(market(buyer, now + windowMs - 1).listings.length, 0);
  assert.ok(market(buyer, now + windowMs).listings.length > 0);
});

test("empty snapshot remains empty until refresh and a stale unopened quote cannot be bought", () => {
  const seller = player(), buyer = player(2, {}), empty = market(buyer);
  const lot = offer(seller);
  assert.deepEqual(market(buyer, now + 1).listings, []);
  assert.equal(market(buyer, now + 1).showcase.refreshAt, empty.showcase.refreshAt);
  assert.throws(() => buy(buyer, lot, now + windowMs), { code: "ECONOMY_MARKET_SHOWCASE_CHANGED" });
  assert.equal(market(buyer, now + windowMs).listings[0].id, lot.id);
  buy(buyer, lot, now + windowMs);
});

test("direct buys require a snapshot; receipt replay survives expiry and new catalog checks", () => {
  const seller = player(), buyer = player(2, {}), lot = offer(seller);
  assert.throws(() => buy(buyer, lot), { code: "ECONOMY_MARKET_SHOWCASE_CHANGED" });
  market(buyer);
  const request = command(buyer, "buy_listing", lot.id, lot.quantity, lot.totalPrice);
  const first = economy.commandDevEconomyMarket(buyer.token, request, now);
  const replay = economy.commandDevEconomyMarket(buyer.token, request, now + windowMs * 3);
  assert.equal(replay.replayed, true); assert.equal(replay.state.wallet.coins, first.state.wallet.coins);
  assert.equal(replay.state.inventory.berries, 1);
});

test("high home alone cannot discover tools, while opened tools survive an unavailable workshop", () => {
  const seller = player(4, { tools: 3 }), low = player(4, {}), high = player(4, {}, ["tools"]), lot = offer(seller, "tools");
  assert.equal(market(low).listings.length, 0);
  assert.throws(() => buy(low, lot), { code: "ECONOMY_MARKET_SHOWCASE_CHANGED" });
  assert.equal(market(high).listings[0].id, lot.id);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(high.me.user.publicId);
  row.state.unlockedItems = [];
  assert.throws(() => buy(high, lot), { code: "ECONOMY_MARKET_ITEM_LOCKED" });
  row.state.unlockedItems = ["tools"];
  assert.equal(buy(high, lot).state.inventory.tools, 1);
  assert.equal(read(high).buildings.workshop, 0);
});

test("historical cheap lots remain immutable and cancellable but cannot enter a showcase", () => {
  const seller = player(), buyer = player(2, {}), lot = offer(seller);
  const saved = globalThis.__zhivDevEconomyStore.listings.get(lot.id); saved.totalPrice = 5;
  const snapshot = structuredClone(saved);
  assert.equal(market(buyer).listings.length, 0); assert.equal(market(seller).mine[0].totalPrice, 5);
  assert.deepEqual(saved, snapshot);
  assert.throws(() => buy(buyer, saved), { code: "ECONOMY_MARKET_SHOWCASE_CHANGED" });
  assert.equal(trade(seller, "cancel_listing", lot.id).state.inventory.berries, 100);
});

// Development servers retain global state while modules are replaced.
test("hot reload adds showcases without replacing old profiles or paid listings", () => {
  const seller = player(), buyer = player(2, {}), lot = offer(seller);
  const before = read(seller);
  delete globalThis.__zhivDevEconomyStore.showcases;
  assert.equal(market(buyer).listings[0].id, lot.id);
  assert.deepEqual(read(seller), before);
  assert.equal(buy(buyer, lot).state.inventory.berries, 1);
});
