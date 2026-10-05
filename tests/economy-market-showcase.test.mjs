import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCatalog: catalog, marketViewSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/market-rules.ts");
const now = Date.parse("2026-10-05T12:00:00Z"), windowMs = catalog.market.showcaseRefreshSeconds * 1000;
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const market = (p, at = now, options = {}) => economy.getDevEconomyMarket(p.token, options, at);
function player(home = 2, inventory = { berries: 100 }) {
  const p = identities.createDevIdentity("Лесник", crypto.randomUUID()); read(p);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.wallet.coins = 1000000; row.state.inventory = inventory; row.state.buildings.home = home; row.state.completedExplorations = 1;
  return p;
}
const command = (p, action, targetId, quantity = 1, totalPrice = 0, at = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p, at).revision, action, targetId, quantity, totalPrice });
const trade = (p, action, target, quantity = 1, price = 0, at = now) => economy.commandDevEconomyMarket(p.token, command(p, action, target, quantity, price, at), at);
const offer = (p, item = "berries", quantity = 1, price = rules.marketMinimumPrice(item, quantity), at = now) => trade(p, "create_listing", item, quantity, price, at).listing;
const buy = (p, lot, at = now) => trade(p, "buy_listing", lot.id, lot.quantity, lot.totalPrice, at);

test("every tradable item has a finite home tier; workshop ownership is unnecessary", () => {
  for (const item of catalog.items.filter(item => item.tradable)) assert.ok(Number.isFinite(rules.marketRequiredHomeLevel(item.id)), item.id);
  assert.equal(rules.marketRequiredHomeLevel("charcoal"), 2, "kiln construction gate dominates recipe home 1");
  assert.equal(rules.marketRequiredHomeLevel("resin"), 3, "old forest is an earlier source");
  assert.equal(rules.marketRequiredHomeLevel("tools"), 4);
  assert.equal(rules.marketRequiredHomeLevel("reinforced_parts"), 4);
  assert.equal(rules.marketRequiredHomeLevel("fish_mooncarp"), 1);
  assert.equal(rules.marketItemUnlocked({ buildings: { home: 4, workshop: 0 } }, "tools"), true);
  assert.equal(rules.marketItemUnlocked({ buildings: { home: 3, workshop: 5 } }, "tools"), false);
  assert.equal(rules.marketRequiredHomeLevel("pearls"), Infinity);
});

test("whole-lot floor prevents immediate NPC arbitrage for every item and preserves the maximum", () => {
  for (const item of catalog.items.filter(item => item.tradable)) {
    const seller = player(5, { [item.id]: 2 });
    const floor = rules.marketMinimumPrice(item.id, 2);
    assert.throws(() => offer(seller, item.id, 2, floor - 1), { code: "ECONOMY_MARKET_PRICE" }, item.id);
    const npc = catalog.fishing.fish.some(fish => fish.itemId === item.id) ? item.baseSellPrice * 2 : Math.floor(item.baseSellPrice * 2 * catalog.localBuyer.payoutBps / 10000);
    assert.ok(floor >= npc, item.id);
    assert.equal(offer(seller, item.id, 1, item.baseSellPrice).totalPrice, item.baseSellPrice);
    assert.equal(offer(seller, item.id, 1, item.baseSellPrice * 5).totalPrice, item.baseSellPrice * 5);
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

test("home gate applies to discovery and to a selected item after a level change", () => {
  const seller = player(4, { tools: 3 }), low = player(2, {}), high = player(4, {}), lot = offer(seller, "tools");
  assert.equal(market(low).listings.length, 0);
  assert.throws(() => buy(low, lot), { code: "ECONOMY_MARKET_SHOWCASE_CHANGED" });
  assert.equal(market(high).listings[0].id, lot.id);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(high.me.user.publicId);
  row.state.buildings.home = 3;
  assert.throws(() => buy(high, lot), { code: "ECONOMY_MARKET_ITEM_LOCKED" });
  row.state.buildings.home = 4;
  assert.equal(buy(high, lot).state.inventory.tools, 1);
  assert.equal(read(high).buildings.workshop, 0);
});

test("historical cheap lots remain immutable and cancellable but cannot enter a showcase", () => {
  const seller = player(), buyer = player(2, {}), lot = offer(seller);
  const saved = globalThis.__zhivDevEconomyStore.listings.get(lot.id); saved.totalPrice = 10;
  const snapshot = structuredClone(saved);
  assert.equal(market(buyer).listings.length, 0); assert.equal(market(seller).mine[0].totalPrice, 10);
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
