import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-10-14T15:30:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
function player(home = 2, bridge = 1, inventory = { berries: 10 }) {
  const p = identities.createDevIdentity("Житель у моста", crypto.randomUUID()); read(p);
  Object.assign(row(p).state.buildings, { home, bridge });
  row(p).state.completedExplorations = 0;
  row(p).state.inventory = inventory; row(p).state.wallet = { coins: 10000, pearls: 2000 };
  return p;
}
const command = (p, action, targetId, quantity = 1, totalPrice = 0, at = now) => ({
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision,
  action, targetId, quantity, totalPrice,
});
const trade = (p, action, target, quantity = 1, price = 0, at = now) => economy.commandDevEconomyMarket(p.token,
  command(p, action, target, quantity, price, at), at);
const send = (p, action, target, at = now) => economy.commandDevEconomy(p.token, command(p, action, target, 1, 0, at), at);
const shelf = (p, at = now) => economy.getDevEconomyMarket(p.token, {}, at);
const offer = p => trade(p, "create_listing", "berries", 1, 10).listing;
const buy = (p, lot, at = now) => trade(p, "buy_listing", lot.id, lot.quantity, lot.totalPrice, at);
const barterCommand = (p, action, fields) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p).revision, action, ...fields });
const barter = (p, action, fields) => economy.commandDevEconomyBarter(p.token, barterCommand(p, action, fields), now);
const barterShelf = p => economy.getDevEconomyBarter(p.token, now);

test("bridge opens trade only after construction is claimed and no exploration count substitutes for it", () => {
  const seller = player(), lot = offer(seller), buyer = player(2, 0);
  row(buyer).state.completedExplorations = 999;
  assert.deepEqual(shelf(buyer).listings, []);
  assert.throws(() => buy(buyer, lot), { code: "ECONOMY_MARKET_LOCKED" });
  const upgrade = catalog.buildings.find(building => building.id === "bridge").levels[0];
  Object.assign(row(buyer).state.buildings, upgrade.requiredBuildings);
  row(buyer).state.inventory = { ...upgrade.cost.items, berries: 1 };
  const started = send(buyer, "start_construction", "bridge").state;
  const job = started.jobs.find(job => job.targetId === "bridge"), readyAt = Date.parse(job.finishesAt);
  assert.equal(started.buildings.bridge, 0);
  assert.equal(read(buyer, readyAt).buildings.bridge, 0, "A ready job is not a completed restoration");
  assert.deepEqual(shelf(buyer, readyAt).listings, []);
  assert.throws(() => buy(buyer, lot, readyAt), { code: "ECONOMY_MARKET_LOCKED" });
  const claimed = send(buyer, "claim_job", job.id, readyAt).state;
  assert.equal(claimed.buildings.bridge, 1);
  row(buyer).state.completedExplorations = 0;
  assert.equal(shelf(buyer, readyAt).listings[0].id, lot.id);
  assert.equal(buy(buyer, lot, readyAt).state.inventory.berries, 2);
});

test("cached showcase cannot bypass a missing bridge on either seller or buyer and never debits either account", () => {
  for (const changing of ["seller", "buyer"]) {
    identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests();
    const seller = player(), buyer = player(2, 1, {}), lot = offer(seller);
    assert.equal(shelf(buyer).listings[0].id, lot.id);
    delete row(changing === "seller" ? seller : buyer).state.buildings.bridge;
    assert.deepEqual(shelf(buyer).listings, []);
    const before = [read(seller), read(buyer)];
    assert.throws(() => buy(buyer, lot), { code: "ECONOMY_MARKET_LOCKED" });
    assert.deepEqual([read(seller), read(buyer)], before);
    assert.equal(globalThis.__zhivDevEconomyStore.listings.get(lot.id).status, "active");
    assert.equal(shelf(seller).mine[0].id, lot.id);
  }
});

test("old paid places and held goods survive a locked bridge while cancellation and committed receipts remain usable", () => {
  const seller = player(), request = command(seller, "create_listing", "berries", 1, 10);
  const created = economy.commandDevEconomyMarket(seller.token, request, now), lot = created.listing;
  row(seller).state.marketSlots = 10; row(seller).state.buildings.bridge = 0;
  const before = read(seller);
  const replay = economy.commandDevEconomyMarket(seller.token, request, now);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.wallet, before.wallet);
  assert.equal(replay.state.marketSlots, 10); assert.equal(shelf(seller).mine[0].id, lot.id);
  assert.throws(() => offer(seller), { code: "ECONOMY_MARKET_LOCKED" });
  assert.throws(() => economy.commandDevEconomy(seller.token,
    command(seller, "buy_market_slot", "market:11", 1, 500), now), { code: "ECONOMY_MARKET_LOCKED" });
  const cancellation = command(seller, "cancel_listing", lot.id);
  const cancelled = economy.commandDevEconomyMarket(seller.token, cancellation, now).state;
  assert.equal(cancelled.inventory.berries, 10); assert.equal(cancelled.marketSlots, 10);
  assert.equal(cancelled.storage.reserved, 0); assert.deepEqual(cancelled.wallet, before.wallet);
  assert.equal(economy.commandDevEconomyMarket(seller.token, cancellation, now).replayed, true);
  assert.equal(read(seller).inventory.berries, 10);
});

test("bridge also gates relic exchange on both sides without trapping old escrow or create receipts", () => {
  for (const changing of ["seller", "buyer"]) {
    identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests();
    const seller = player(3, 1, { ancient_core: 1 }), buyer = player(3, 1, { moon_crystal: 1 });
    const request = barterCommand(seller, "create_offer", { offeredItemId: "ancient_core", requestedItemId: "moon_crystal" });
    const offer = economy.commandDevEconomyBarter(seller.token, request, now).offer;
    assert.equal(barterShelf(buyer).offers[0].id, offer.id);
    row(changing === "seller" ? seller : buyer).state.buildings.bridge = 0;
    assert.deepEqual(barterShelf(buyer).offers, []);
    const before = [read(seller), read(buyer)];
    assert.throws(() => barter(buyer, "accept_offer", { offerId: offer.id }), { code: "ECONOMY_BARTER_LOCKED" });
    assert.deepEqual([read(seller), read(buyer)], before);
    assert.equal(economy.commandDevEconomyBarter(seller.token, request, now).replayed, true);
    barter(seller, "cancel_offer", { offerId: offer.id });
    assert.equal(read(seller).inventory.ancient_core, 1);
  }
});

test("a restored bridge still hides unseen berries until their garden source is actually open", () => {
  const seller = player(2, 1, { blueberries: 1 }), buyer = player(2, 1, { blueberries: 1 });
  row(seller).state.buildings.garden = 2;
  const price = catalog.items.find(item => item.id === "blueberries").baseSellPrice;
  const lot = trade(seller, "create_listing", "blueberries", 1, price).listing;
  assert.equal(read(buyer).unlockedItems.includes("blueberries"), false, "An arbitrary gift does not teach a new berry");
  assert.deepEqual(shelf(buyer).listings, []);
  globalThis.__zhivDevEconomyStore.showcases.get(buyer.me.user.publicId).ids = [lot.id];
  const before = read(buyer);
  assert.throws(() => buy(buyer, lot), { code: "ECONOMY_MARKET_ITEM_LOCKED" });
  assert.deepEqual(read(buyer), before);
  row(buyer).state.buildings.garden = 2;
  assert.equal(shelf(buyer).listings[0].id, lot.id);
  assert.equal(buy(buyer, lot).state.inventory.blueberries, 2);
});
