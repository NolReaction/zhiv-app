import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { barterViewSchema, barterResultSchema } = await vite.ssrLoadModule("/features/economy/domain/barter-model.ts");
const now = Date.parse("2026-10-05T12:00:00Z"), windowMs = 1800_000;
const core = "ancient_core", resin = "living_resin", crystal = "moon_crystal";
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const shelf = (p, at = now) => economy.getDevEconomyBarter(p.token, at);
function player(inventory = { [core]: 5, [resin]: 5, [crystal]: 5 }, home = 3) {
  const p = identities.createDevIdentity("Лесник", crypto.randomUUID()); read(p);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.inventory = inventory; row.state.buildings.home = home; row.state.completedExplorations = 1;
  row.state.wallet = { coins: 100, pearls: 5 };
  return p;
}
const command = (p, fields, at = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision, ...fields });
const send = (p, body, at = now) => economy.commandDevEconomyBarter(p.token, body, at);
const offer = (p, offeredItemId = core, requestedItemId = resin, at = now) => send(p, command(p, { action: "create_offer", offeredItemId, requestedItemId }, at), at).offer;
const accept = (p, row, at = now) => send(p, command(p, { action: "accept_offer", offerId: row.id }, at), at);
const cancel = (p, row, at = now) => send(p, command(p, { action: "cancel_offer", offerId: row.id }, at), at);

test("barter swaps exactly one material each, keeps currencies and occupied warehouse space", () => {
  const a = player({ [core]: 1 }), b = player({ [resin]: 1 });
  const aBefore = read(a), bBefore = read(b), row = offer(a);
  assert.equal(read(a).storage.reserved, 1); assert.equal(read(a).inventory[core], 0);
  assert.equal(read(a).storage.available, aBefore.storage.available);
  assert.equal(barterViewSchema.safeParse(shelf(b)).success, true);
  const result = accept(b, row);
  assert.equal(barterResultSchema.safeParse(result).success, true);
  assert.equal(result.offer.status, "exchanged");
  assert.equal(read(a).inventory[resin], 1); assert.equal(read(b).inventory[core], 1);
  assert.equal(read(b).inventory[resin], 0); assert.equal(read(a).storage.reserved, 0);
  assert.deepEqual(read(a).wallet, aBefore.wallet); assert.deepEqual(read(b).wallet, bBefore.wallet);
  assert.equal(read(a).storage.available, aBefore.storage.available); assert.equal(read(b).storage.available, bBefore.storage.available);
});

test("receipt survives later cancellation and returns immutable offer with fresh state", () => {
  const p = player(), body = command(p, { action: "create_offer", offeredItemId: core, requestedItemId: resin });
  const created = send(p, body); cancel(p, created.offer);
  const before = read(p), replay = send(p, body);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, created.acceptedRevision);
  assert.equal(replay.offer.status, "active"); assert.deepEqual(replay.state, before); assert.equal(shelf(p).mine.length, 0);
  assert.throws(() => send(p, { ...body, requestedItemId: crystal }), { code: "ECONOMY_REQUEST_CONFLICT" });
});

test("an accepted request retries once; a second buyer cannot spend or receive anything", () => {
  const seller = player(), buyer = player(), other = player(), row = offer(seller);
  shelf(buyer); shelf(other);
  const body = command(buyer, { action: "accept_offer", offerId: row.id });
  send(buyer, body); const a = read(seller), b = read(buyer), c = read(other);
  assert.equal(send(buyer, body).replayed, true);
  assert.deepEqual(read(seller), a); assert.deepEqual(read(buyer), b);
  assert.throws(() => accept(other, row), { code: "ECONOMY_BARTER_NOT_ACTIVE" }); assert.deepEqual(read(other), c);
});

test("a resource failure leaves both accounts, offer, and receipt unused", () => {
  const seller = player(), buyer = player({}), row = offer(seller); shelf(buyer);
  const a = read(seller), b = read(buyer), body = command(buyer, { action: "accept_offer", offerId: row.id });
  assert.throws(() => send(buyer, body), { code: "ECONOMY_RESOURCES" });
  assert.deepEqual(read(seller), a); assert.deepEqual(read(buyer), b); assert.equal(shelf(buyer).offers[0].status, "active");
  assert.equal(globalThis.__zhivDevEconomyStore.barterReceipts.get(buyer.me.user.publicId)?.has(body.requestId) ?? false, false);
});

test("a full or already overflowing warehouse can exchange or cancel reserved goods without loss", () => {
  const seller = player({ wood: 250, [core]: 1 }), buyer = player({ wood: 250, [resin]: 1 });
  const original = read(seller).storage, row = offer(seller); shelf(buyer); accept(buyer, row);
  assert.deepEqual(read(seller).storage, original); assert.equal(read(buyer).storage.overflow, 51);
  const next = offer(seller, resin, core); cancel(seller, next);
  assert.deepEqual(read(seller).storage, original); assert.equal(read(seller).inventory[resin], 1);
});

test("new ordinary production cannot use space held by a barter offer", () => {
  const seller = player({ wood: 199, [core]: 1 }); offer(seller);
  const body = command(seller, { action: "start_exploration", targetId: "forest", quantity: 1, totalPrice: 0 });
  const job = economy.commandDevEconomy(seller.token, body, now).state.jobs[0];
  const at = Date.parse(job.finishesAt), before = read(seller, at);
  assert.throws(() => economy.commandDevEconomy(seller.token, command(seller, { action: "claim_job", targetId: job.id, quantity: 1, totalPrice: 0 }, at), at), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(seller, at), before);
});

test("home gate, item whitelist, different materials, no price extras, and own shelf limits", () => {
  const locked = player(undefined, 2); assert.throws(() => offer(locked), { code: "ECONOMY_BARTER_LOCKED" });
  const p = player(); assert.throws(() => offer(p, "wood"), { code: "ECONOMY_BARTER_ITEM" });
  assert.throws(() => offer(p, core, core), { code: "INVALID_ECONOMY_COMMAND" });
  assert.throws(() => send(p, command(p, { action: "create_offer", offeredItemId: core, requestedItemId: resin, totalPrice: 10 })), { code: "INVALID_ECONOMY_COMMAND" });
  offer(p); offer(p); offer(p); assert.throws(() => offer(p), { code: "ECONOMY_BARTER_LIMIT" });
  assert.equal(shelf(p).mine.length, 3);
});

test("six offers, one per seller, fixed half-hour window without refilling consumed slots", () => {
  for (let i = 0; i < 8; i++) { const p = player(); offer(p); offer(p); }
  const buyer = player(), first = shelf(buyer);
  assert.equal(first.offers.length, 6); assert.equal(new Set(first.offers.map(row => row.sellerPublicId)).size, 6);
  assert.deepEqual(shelf(buyer, now + 1000).offers, first.offers);
  accept(buyer, first.offers[0]); assert.equal(shelf(buyer, now + 1000).offers.length, 5);
  assert.throws(() => accept(buyer, first.offers[1], now + windowMs), { code: "ECONOMY_BARTER_SHOWCASE_CHANGED" });
  assert.equal(shelf(buyer, now + windowMs).offers.length, 6);
});

test("offers outside selected window, self acceptance, and someone else's cancellation fail", () => {
  const a = player(), b = player(), row = offer(a);
  assert.throws(() => accept(b, row), { code: "ECONOMY_BARTER_SHOWCASE_CHANGED" });
  assert.throws(() => accept(a, row), { code: "ECONOMY_BARTER_SELF_TRADE" });
  assert.throws(() => cancel(b, row), { code: "ECONOMY_BARTER_OWNER" });
});

test("relics cannot be sold to NPC or bought through a coin listing", () => {
  const p = player();
  assert.throws(() => economy.commandDevEconomyMarket(p.token, command(p, { action: "create_listing", targetId: core, quantity: 1, totalPrice: 1 }), now), { code: "ECONOMY_MARKET_ITEM" });
  assert.throws(() => economy.commandDevEconomy(p.token, command(p, { action: "sell", targetId: core, quantity: 1, totalPrice: 0 }), now));
  assert.equal(read(p).inventory[core], 5); assert.equal(read(p).wallet.coins, 100);
});

test("UUID fence covers ordinary economy and coin market in both directions", () => {
  const p = player({ wood: 5, [core]: 5, [resin]: 5 });
  const body = command(p, { action: "create_offer", offeredItemId: core, requestedItemId: resin }); send(p, body);
  const reused = command(p, { requestId: body.requestId, action: "sell", targetId: "wood", quantity: 1, totalPrice: 0 });
  assert.throws(() => economy.commandDevEconomy(p.token, reused, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => economy.commandDevEconomyMarket(p.token, { ...reused, action: "create_listing", totalPrice: 2 }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  const sold = command(p, { action: "sell", targetId: "wood", quantity: 1, totalPrice: 0 }); economy.commandDevEconomy(p.token, sold, now);
  assert.throws(() => send(p, { ...command(p, { action: "create_offer", offeredItemId: core, requestedItemId: resin }), requestId: sold.requestId }), { code: "ECONOMY_REQUEST_CONFLICT" });
});

test("account switch and stale revision cannot mutate a proposed exchange", () => {
  const a = player(), b = player(), body = command(a, { action: "create_offer", offeredItemId: core, requestedItemId: resin });
  assert.throws(() => send(b, body), { code: "ECONOMY_OWNER_CHANGED" }); offer(a);
  assert.throws(() => send(a, body), { code: "ECONOMY_REVISION_CONFLICT" });
});
