import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const market = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const now = Date.parse("2026-10-14T09:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const read = p => economy.getDevEconomy(p.token, now);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
function player() {
  const p = identities.createDevIdentity("Расширение лавки", crypto.randomUUID()); read(p);
  Object.assign(row(p).state.buildings, { home: 2, bridge: 1, woodlot: 1, warehouse: 1 });
  row(p).state.completedExplorations = 1; row(p).state.wallet = { coins: 1000, pearls: 2000 };
  row(p).state.inventory = { wood: 20 };
  return p;
}
const request = (p, action = "buy_market_slot", targetId = "market:6", totalPrice = 100, extra = {}) => ({
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p).revision,
  action, targetId, quantity: 1, totalPrice, ...extra,
});
const send = (p, ...args) => economy.commandDevEconomy(p.token, request(p, ...args), now);
const trade = (p, action, targetId, quantity = 1, totalPrice = 0) => economy.commandDevEconomyMarket(p.token,
  request(p, action, targetId, totalPrice, { quantity }), now);

test("market expansion quotes are read-only and the five purchases debit exact authored pearl prices sequentially", () => {
  const p = player(), stored = structuredClone(row(p).state), before = read(p);
  assert.equal(before.marketSlots, 5); assert.equal(model.economyCatalog.market.baseSlots, 5);
  assert.deepEqual(model.economyCatalog.market.slotPricesPearls, [100, 160, 240, 360, 500]);
  assert.deepEqual(market.marketSlotOffer(before), { slots: 6, targetId: "market:6", pricePearls: 100 });
  assert.deepEqual(row(p).state, stored);
  let paid = 0;
  for (const [index, price] of [100, 160, 240, 360, 500].entries()) {
    const current = read(p), offer = market.marketSlotOffer(current), result = send(p, "buy_market_slot", offer.targetId, price);
    paid += price;
    assert.equal(result.state.marketSlots, 6 + index); assert.equal(row(p).state.marketSlots, 6 + index);
    assert.equal(result.state.wallet.pearls, 2000 - paid); assert.equal(result.state.wallet.coins, before.wallet.coins);
    assert.deepEqual(result.state.inventory, before.inventory); assert.deepEqual(result.state.storage, before.storage);
    assert.equal(result.state.revision, current.revision + 1);
  }
  assert.equal(paid, 1360); assert.equal(market.marketSlotOffer(read(p)), null);
  const final = read(p); assert.throws(() => send(p, "buy_market_slot", "market:11", 100), { code: "MARKET_SLOTS_MAX" });
  assert.deepEqual(read(p), final);
});

test("skipped places, stale price, wrong owner, racing revisions and insufficient pearls never buy capacity", () => {
  const p = player(), other = player(), before = read(p), cmd = request(p);
  assert.throws(() => send(p, "buy_market_slot", "market:10", 500), { code: "MARKET_SLOT_CHANGED" });
  for (const price of [0, 99, 102])
    assert.throws(() => send(p, "buy_market_slot", "market:6", price), { code: "MARKET_SLOT_PRICE_CHANGED" });
  assert.throws(() => send(p, "buy_market_slot", "market:6", 100, { quantity: 2 }), { code: "INVALID_ECONOMY_COMMAND" });
  assert.throws(() => economy.commandDevEconomy(other.token, cmd, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.deepEqual(read(p), before); assert.equal(read(other).marketSlots, 5);
  row(p).state.wallet.pearls = 98;
  const poor = read(p); assert.throws(() => send(p), { code: "ECONOMY_PEARLS" }); assert.deepEqual(read(p), poor);
  row(p).state.wallet.pearls = 2000;
  const first = request(p), racing = request(p); economy.commandDevEconomy(p.token, first, now);
  assert.throws(() => economy.commandDevEconomy(p.token, racing, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.equal(read(p).marketSlots, 6); assert.equal(read(p).wallet.pearls, 1900);
});

test("an accepted expansion receipt replays before current market eligibility and never repeats its debit", () => {
  const p = player(), cmd = request(p), accepted = economy.commandDevEconomy(p.token, cmd, now);
  row(p).state.buildings.home = 1; row(p).state.completedExplorations = 0;
  const latest = read(p), replay = economy.commandDevEconomy(p.token, cmd, now + 86400000);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, accepted.acceptedRevision);
  assert.equal(replay.state.marketSlots, 6); assert.deepEqual(replay.state.wallet, latest.wallet);
  assert.deepEqual(replay.state.inventory, latest.inventory);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cmd, totalPrice: 0 }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  const blocked = read(p); assert.throws(() => send(p, "buy_market_slot", "market:7", 160), { code: "ECONOMY_MARKET_LOCKED" });
  assert.deepEqual(read(p), blocked);
});

test("legacy six-to-ten listings stay in the owner's view and remain refundable without implicitly gifting market places", () => {
  const p = player(), saved = globalThis.__zhivDevEconomyStore.listings;
  row(p).state.inventory = { wood: 1 };
  const ids = [];
  for (let index = 0; index < 10; index++) {
    const id = crypto.randomUUID(); ids.push(id);
    saved.set(id, { id, sellerPublicId: p.me.user.publicId, itemId: "wood", quantity: 1, totalPrice: 30,
      currencyScale: 10, feeBps: 500, status: "active", createdAt: new Date(now - index * 1000).toISOString(), closedAt: null });
  }
  const shelf = () => economy.getDevEconomyMarket(p.token, {}, now);
  assert.equal(shelf().mine.length, 10); assert.equal(read(p).marketSlots, 5);
  const before = read(p); assert.throws(() => trade(p, "create_listing", "wood", 1, 30), { code: "ECONOMY_MARKET_LIMIT" });
  assert.deepEqual(read(p), before);
  row(p).state.buildings.home = 1; row(p).state.completedExplorations = 0;
  for (const id of ids.slice(0, 6)) trade(p, "cancel_listing", id);
  assert.equal(shelf().mine.length, 4); assert.equal(read(p).marketSlots, 5);
  assert.deepEqual(read(p).inventory, { wood: 7 }); assert.equal(read(p).storage.reserved, 4);
  row(p).state.buildings.home = 2; row(p).state.completedExplorations = 1;
  trade(p, "create_listing", "wood", 1, 30); assert.equal(shelf().mine.length, 5);
  assert.throws(() => trade(p, "create_listing", "wood", 1, 30), { code: "ECONOMY_MARKET_LIMIT" });
});
