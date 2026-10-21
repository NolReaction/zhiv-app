import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { ECONOMY_MAX_BALANCE, marketViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { marketSaleFee } = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const now = Date.parse("2026-10-19T12:00:00Z"), tomorrow = now + 86400000;
const ok = result => { assert.equal(result.kind, "ok"); return result.value; };
const read = (player, at = now) => economy.getDevEconomy(player.token, at);
const row = player => globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
const market = (player, at = now) => economy.getDevEconomyMarket(player.token, {}, at);
function player(name, inventory = { wood: 100 }) {
  const player = identities.createDevIdentity(name, crypto.randomUUID()); read(player);
  Object.assign(row(player).state, { inventory, completedExplorations: 1, wallet: { coins: 100000, pearls: 1000 } });
  Object.assign(row(player).state.buildings, { home: 2, bridge: 1, woodlot: 1, warehouse: 6 });
  return player;
}
function connect(buyer, seller) {
  const request = ok(identities.sendDevDirectRequest(buyer.token, seller.me.user.publicId, crypto.randomUUID()));
  return ok(identities.actOnDevDirectRequest(seller.token, request.request.requestId, "ACCEPTED")).person.circleId;
}
const command = (player, action, targetId, quantity = 1, totalPrice = 0, at = now) => ({ requestId: crypto.randomUUID(),
  ownerPublicId: player.me.user.publicId, expectedRevision: read(player, at).revision, action, targetId, quantity, totalPrice });
const trade = (player, action, targetId, quantity = 1, totalPrice = 0, at = now) =>
  economy.commandDevEconomyMarket(player.token, command(player, action, targetId, quantity, totalPrice, at), at);
const offer = seller => trade(seller, "create_listing", "wood", 1, 30).listing;
const buy = (buyer, circleId, listing, input = command(buyer, "buy_listing", listing.id, listing.quantity, listing.totalPrice)) =>
  economy.commandDevGuestWorldMarket(buyer.token, circleId, input, now);
const snapshot = () => structuredClone(globalThis.__zhivDevEconomyStore);
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());

test("a real purchase delivers goods while fixed net revenue and buyer identity wait on the seller's shelf", () => {
  const seller = player("Продавец"), buyer = player("Natasha", {}), circleId = connect(buyer, seller), listing = offer(seller);
  const identity = [...globalThis.__zhivDevStore.users.values()].find(user => user.publicId === buyer.me.user.publicId);
  identity.avatarUrl = "https://example.test/avatar/natasha.png";
  const beforeSeller = read(seller), beforeBuyer = read(buyer), result = buy(buyer, circleId, listing);
  assert.equal(result.state.wallet.coins, beforeBuyer.wallet.coins - 30); assert.equal(result.state.inventory.wood, 1);
  assert.equal(read(seller).wallet.coins, beforeSeller.wallet.coins); assert.equal(read(seller).storage.reserved, 0);
  const pending = market(seller).mine[0];
  assert.equal(pending.status, "sold"); assert.equal(pending.owned, true);
  assert.deepEqual(pending.sale, { buyerPublicId: buyer.me.user.publicId, buyerName: "Natasha",
    buyerAvatarUrl: "https://example.test/avatar/natasha.png", proceedsCoins: 30 - marketSaleFee(30, listing.feeBps), claimedAt: null });
  assert.equal(marketViewSchema.safeParse(market(seller)).success, true);
  identity.displayName = "Новое имя"; identity.avatarUrl = null;
  assert.equal(market(seller).mine[0].sale.buyerName, "Natasha", "sale identity is the purchase-time snapshot");
  assert.equal(result.listing.sale, null, "a buyer response cannot expose the seller-only sale record");
  assert.equal(ok(identities.getDevGuestWorld(buyer.token, circleId, now)).market.listings.length, 0);
  assert.equal(market(buyer).listings.length, 0);
});

test("buy and claim replay exactly once; claiming on another day does not spend that day's trade quota", () => {
  const seller = player("Продавец"), buyer = player("Natasha", {}), circleId = connect(buyer, seller), listing = offer(seller);
  const purchase = command(buyer, "buy_listing", listing.id, 1, 30), before = read(seller).wallet.coins;
  buy(buyer, circleId, listing, purchase); assert.equal(buy(buyer, circleId, listing, purchase).replayed, true);
  const claim = command(seller, "claim_sale", listing.id, 1, 0, tomorrow);
  const collected = economy.commandDevEconomyMarket(seller.token, claim, tomorrow);
  assert.equal(collected.state.wallet.coins, before + 28); assert.equal(collected.listing.sale.claimedAt, new Date(tomorrow).toISOString());
  assert.equal(market(seller, tomorrow).mine.length, 0); assert.equal(market(seller, tomorrow).tradeBudget.salesUsed, 0);
  assert.equal(economy.commandDevEconomyMarket(seller.token, claim, tomorrow + 1000).replayed, true);
  assert.equal(read(seller, tomorrow).wallet.coins, before + 28);
  assert.throws(() => trade(seller, "claim_sale", listing.id, 1, 0, tomorrow), { code: "ECONOMY_MARKET_NOT_PENDING" });
  assert.equal(read(seller, tomorrow).wallet.coins, before + 28);
});

test("sold goods continue to occupy a market slot until their revenue is collected", () => {
  const seller = player("Продавец"), buyer = player("Покупатель", {}), circleId = connect(buyer, seller);
  const lots = Array.from({ length: 5 }, () => offer(seller));
  buy(buyer, circleId, lots[0]);
  assert.equal(market(seller).mine.length, 5); assert.equal(read(seller).storage.reserved, 4);
  const before = snapshot(); assert.throws(() => offer(seller), { code: "ECONOMY_MARKET_LIMIT" }); assert.deepEqual(snapshot(), before);
  trade(seller, "claim_sale", lots[0].id); assert.equal(market(seller).mine.length, 4);
  assert.equal(offer(seller).status, "active"); assert.equal(market(seller).mine.length, 5);
});

test("wallet overflow postpones collection without blocking a buyer or losing the pending amount", () => {
  const seller = player("Продавец"), buyer = player("Покупатель", {}), circleId = connect(buyer, seller), listing = offer(seller);
  row(seller).state.wallet.coins = ECONOMY_MAX_BALANCE;
  buy(buyer, circleId, listing); const claim = command(seller, "claim_sale", listing.id), before = snapshot();
  assert.throws(() => economy.commandDevEconomyMarket(seller.token, claim, now), { code: "ECONOMY_CAPACITY" }); assert.deepEqual(snapshot(), before);
  assert.equal(market(seller).mine[0].sale.claimedAt, null);
  row(seller).state.wallet.coins = ECONOMY_MAX_BALANCE - 28;
  assert.equal(economy.commandDevEconomyMarket(seller.token, claim, now).state.wallet.coins, ECONOMY_MAX_BALANCE);
});

test("only the seller can collect a sold lot, including after their market becomes locked", () => {
  const seller = player("Продавец"), buyer = player("Покупатель", {}), stranger = player("Чужой"), circleId = connect(buyer, seller), listing = offer(seller);
  buy(buyer, circleId, listing); const before = snapshot();
  assert.throws(() => trade(stranger, "claim_sale", listing.id), { code: "ECONOMY_MARKET_OWNER", status: 403 }); assert.deepEqual(snapshot(), before);
  assert.throws(() => trade(seller, "claim_sale", listing.id, 2), { code: "INVALID_ECONOMY_COMMAND", status: 400 });
  assert.throws(() => trade(seller, "claim_sale", listing.id, 1, 30), { code: "INVALID_ECONOMY_COMMAND", status: 400 });
  assert.throws(() => economy.commandDevGuestWorldMarket(buyer.token, circleId, command(buyer, "claim_sale", listing.id), now), { code: "INVALID_ECONOMY_COMMAND", status: 400 });
  Object.assign(row(seller).state.buildings, { home: 1, bridge: 0 }); row(seller).state.completedExplorations = 0;
  const coins = read(seller).wallet.coins; assert.equal(trade(seller, "claim_sale", listing.id).state.wallet.coins, coins + 28);
});

test("pre-upgrade DEV sales without a payout marker are never credited again", () => {
  const seller = player("Продавец"), buyer = player("Покупатель", {}), circleId = connect(buyer, seller), listing = offer(seller);
  buy(buyer, circleId, listing);
  delete globalThis.__zhivDevEconomyStore.listings.get(listing.id).sale;
  row(seller).state.wallet.coins += 28;
  assert.equal(market(seller).mine.length, 0); const before = snapshot();
  assert.throws(() => trade(seller, "claim_sale", listing.id), { code: "ECONOMY_MARKET_NOT_PENDING" }); assert.deepEqual(snapshot(), before);
});

test("profile reset preserves pending sales and settled receipts without restoring already collected money", () => {
  const seller = player("Продавец"), buyer = player("Покупатель", {}), circleId = connect(buyer, seller), settled = offer(seller), pending = offer(seller);
  buy(buyer, circleId, settled); buy(buyer, circleId, pending);
  const claim = command(seller, "claim_sale", settled.id); const result = economy.commandDevEconomyMarket(seller.token, claim, now);
  economy.removeDevEconomyOwner(seller.me.user.publicId);
  const reset = read(seller); assert.ok(reset.revision > result.state.revision); assert.equal(reset.buildings.home, 1);
  assert.deepEqual(market(seller).mine.map(listing => listing.id), [pending.id]);
  const replay = economy.commandDevEconomyMarket(seller.token, claim, now);
  assert.equal(replay.replayed, true); assert.equal(replay.state.wallet.coins, reset.wallet.coins);
  assert.equal(trade(seller, "claim_sale", pending.id).state.wallet.coins, reset.wallet.coins + 28);
  economy.removeDevEconomyOwner(seller.me.user.publicId, { deleteHistory: true });
  assert.equal(market(seller).mine.length, 0); assert.equal(globalThis.__zhivDevEconomyStore.resetMarketReceipts.has(seller.me.user.publicId), false);
});

test("the general showcase uses the same deferred sale and private buyer snapshot pipeline", () => {
  const seller = player("Продавец"), buyer = player("Общий покупатель", {}), listing = offer(seller), coins = read(seller).wallet.coins;
  assert.equal(market(buyer).listings[0].sale, null);
  const result = trade(buyer, "buy_listing", listing.id, listing.quantity, listing.totalPrice);
  assert.equal(result.state.inventory.wood, 1); assert.equal(result.listing.sale, null); assert.equal(read(seller).wallet.coins, coins);
  assert.equal(market(seller).mine[0].sale.buyerName, "Общий покупатель");
  assert.equal(trade(seller, "claim_sale", listing.id).state.wallet.coins, coins + 28);
});
