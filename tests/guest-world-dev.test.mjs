import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const social = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const world = await vite.ssrLoadModule("/lib/dev/world-store.ts");
const { guestWorldSchema } = await vite.ssrLoadModule("/features/people/guest-world-model.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { marketMinimumPrice } = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const now = Date.parse("2026-10-19T12:00:00Z");
const key = () => crypto.randomUUID();
const ok = result => { assert.equal(result.kind, "ok"); return result.value; };
const identity = () => social.createDevIdentity("Сосед", key());
const read = player => economy.getDevEconomy(player.token, now);
const row = player => globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
const visit = (player, circle) => ok(social.getDevGuestWorld(player.token, circle, now));
function connect(a, b) {
  const request = ok(social.sendDevDirectRequest(a.token, b.me.user.publicId, key()));
  return ok(social.actOnDevDirectRequest(b.token, request.request.requestId, "ACCEPTED")).person.circleId;
}
function player(home = 2, inventory = { wood: 100 }) {
  const player = identity(); read(player);
  Object.assign(row(player).state, { inventory, wallet: { coins: 1000000, pearls: 1000 }, completedExplorations: 1,
    unlockedItems: ["wood", "fish_common"], itemUnlockVersion: 1 });
  Object.assign(row(player).state.buildings, { home, warehouse: 6, bridge: 1, woodlot: 1 });
  return player;
}
const command = (player, action, targetId, quantity = 1, totalPrice = 0) => ({ requestId: key(), ownerPublicId: player.me.user.publicId,
  expectedRevision: read(player).revision, action, targetId, quantity, totalPrice });
const offer = (player, quantity = 1, itemId = "wood") => economy.commandDevEconomyMarket(player.token,
  command(player, "create_listing", itemId, quantity, Math.ceil(marketMinimumPrice(itemId, quantity) / 10) * 10), now).listing;
const buyCommand = (player, listing) => command(player, "buy_listing", listing.id, listing.quantity, listing.totalPrice);
const buy = (player, circle, listing) => economy.commandDevGuestWorldMarket(player.token, circle, buyCommand(player, listing), now);
const snapshot = () => structuredClone({ economy: globalThis.__zhivDevEconomyStore, world: globalThis.__zhivDevWorldStore });
beforeEach(() => social.resetDevStoreForTests());
after(() => vite.close());

test("a visit never initializes either player's game and preserves legacy building progress", () => {
  const guest = identity(), host = identity(), circle = connect(guest, host), initial = snapshot();
  const result = visit(guest, circle);
  assert.equal(result.world.buildings.home, 1); assert.equal(result.world.equipment.palette, "moss");
  assert.equal(result.market.reason, "buyer_locked"); assert.deepEqual(result.world.jobs, []);
  assert.equal(guestWorldSchema.safeParse(result).success, true); assert.deepEqual(snapshot(), initial);
  world.getDevWorld(host.token, now);
  const legacy = globalThis.__zhivDevWorldStore.get(host.me.user.publicId);
  legacy.state.houseLevel = 4; legacy.state.workshop = true; legacy.state.workshopLevel = 3;
  globalThis.__zhivDevEconomyStore.profiles.delete(host.me.user.publicId);
  const before = snapshot(), fallback = visit(guest, circle);
  assert.equal(fallback.world.buildings.home, 4); assert.equal(fallback.world.buildings.workshop, 3);
  assert.deepEqual(snapshot(), before);
});

test("actual buildings clothing decorations and job clocks are projected without private rewards or seeds", () => {
  const guest = player(), host = player(3), circle = connect(guest, host);
  const hostWorld = world.getDevWorld(host.token, now);
  const savedWorld = globalThis.__zhivDevWorldStore.get(host.me.user.publicId);
  savedWorld.state.inventory.push("rain_hood");
  world.commandDevWorld(host.token, { requestId: key(), ownerPublicId: host.me.user.publicId, expectedRevision: hostWorld.revision,
    action: "equip", target: "rain_hood" }, now);
  savedWorld.state.hiddenGifts = ["leaf_bed"];
  const stamp = new Date(now).toISOString(), end = new Date(now + 60000).toISOString();
  row(host).state.jobs = [{ id: key(), kind: "production", targetId: "garden", recipeId: "raspberry", targetLevel: null,
    startedAt: stamp, finishesAt: end, actorId: null, rewards: { raspberry: 999 }, cost: { coins: 888, items: {} },
    collection: { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null, batchId: key() },
    fishing: { fishId: "private-fish" }, rareDrop: { itemId: "private-find" }, catalogVersion: 11 }];
  row(host).state.fishingCastSeed = "private-seed";
  const before = snapshot(), result = visit(guest, circle);
  assert.equal(result.ownerPublicId, guest.me.user.publicId); assert.equal(result.user.publicId, host.me.user.publicId);
  assert.equal(result.world.buildings.home, 3); assert.equal(result.world.equipment.head, "rain_hood");
  assert.deepEqual(result.world.hiddenGifts, ["leaf_bed"]);
  assert.equal(result.world.jobs[0].finishesAt, end);
  assert.deepEqual(result.world.jobs[0].collection, { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null });
  assert.equal(guestWorldSchema.safeParse(result).success, true);
  for (const secret of ["inventory", "wallet", "rewards", "cost", "rareDrop", "fishingCastSeed", "private-seed", "private-fish", "batchId"])
    assert.equal(JSON.stringify(result).includes(secret), false, secret);
  result.world.buildings.home = 1; result.world.equipment.head = null;
  assert.deepEqual(snapshot(), before); assert.equal(visit(guest, circle).world.equipment.head, "rain_hood");
});

test("accepted direct friendship and effective privacy apply to reads and purchases without revealing another seller", () => {
  const guest = player(), host = player(), stranger = player(), circle = connect(guest, host), listing = offer(host);
  assert.deepEqual(social.getDevGuestWorld(undefined, circle, now), { kind: "unauthorized" });
  for (const [token, id] of [[stranger.token, circle], [guest.token, key()], [guest.token, host.me.user.publicId]])
    assert.deepEqual(social.getDevGuestWorld(token, id, now), { kind: "not-found" });
  const pendingHost = player(); ok(social.sendDevDirectRequest(guest.token, pendingHost.me.user.publicId, key()));
  assert.deepEqual(social.getDevGuestWorld(guest.token, pendingHost.me.user.publicId, now), { kind: "not-found" });
  ok(social.updateDevSharing(guest.token, circle, "OFF")); visit(guest, circle);
  ok(social.updateDevSharing(host.token, circle, "OFF"));
  assert.deepEqual(social.getDevGuestWorld(guest.token, circle, now), { kind: "not-found" });
  assert.throws(() => buy(guest, circle, listing), { code: "GUEST_WORLD_UNAVAILABLE", status: 404 });
  ok(social.updateDevSharing(host.token, circle, "LATEST_ONLY")); visit(guest, circle);
  ok(social.removeDevPerson(guest.token, circle));
  assert.deepEqual(social.getDevGuestWorld(guest.token, circle, now), { kind: "not-found" });
  assert.throws(() => buy(guest, circle, listing), { code: "GUEST_WORLD_UNAVAILABLE" });
});

test("group privacy OFF cannot be bypassed through a direct friend's world", () => {
  const guest = player(), host = player(), circle = connect(guest, host);
  const group = ok(social.createDevGroup(host.token, "Друзья", null, [circle], key())).groupId;
  const invite = ok(social.listDevGroups(guest.token)).incomingInvites.find(invite => invite.groupId === group);
  ok(social.actOnDevGroupInvite(guest.token, invite.inviteId, "ACCEPTED")); visit(guest, circle);
  ok(social.updateDevGroupSharing(host.token, group, "OFF"));
  assert.deepEqual(social.getDevGuestWorld(guest.token, circle, now), { kind: "not-found" });
});

test("personal storefront contains only real active host listings and normalizes old quotes without persisting", () => {
  const guest = player(), host = player(), other = player(), circle = connect(guest, host);
  const first = offer(host), cancelled = offer(host), foreign = offer(other);
  economy.commandDevEconomyMarket(host.token, command(host, "cancel_listing", cancelled.id), now);
  const listings = globalThis.__zhivDevEconomyStore.listings;
  listings.get(first.id).totalPrice = 3; listings.get(first.id).currencyScale = 1;
  const before = snapshot(), result = visit(guest, circle);
  assert.deepEqual(result.market.listings.map(listing => listing.id), [first.id]);
  assert.equal(result.market.listings[0].totalPrice, 30); assert.equal(result.market.listings[0].owned, false);
  assert.equal(result.market.listings.some(listing => listing.id === foreign.id), false);
  assert.equal(guestWorldSchema.safeParse(result).success, true); assert.deepEqual(snapshot(), before);
  for (let index = 0; index < 12; index++) {
    const id = key(); listings.set(id, { ...listings.get(first.id), id, createdAt: new Date(now + index * 1000).toISOString() });
  }
  assert.equal(visit(guest, circle).market.listings.length, 10);
});

test("availability reports buyer and seller restoration gates while all houses 2 through 5 share one storefront pool", () => {
  const guest = player(), host = player(), circle = connect(guest, host), listing = offer(host);
  assert.deepEqual({ ...visit(guest, circle).market, listings: [] }, { listings: [], available: true, reason: null });
  for (const [owner, buildings, reason] of [[guest, { home: 1 }, "buyer_locked"], [host, { bridge: 0 }, "seller_locked"]]) {
    const previous = { ...row(owner).state.buildings }; Object.assign(row(owner).state.buildings, buildings);
    const market = visit(guest, circle).market;
    assert.equal(market.reason, reason); assert.equal(market.available, false); assert.equal(market.listings[0].id, listing.id);
    row(owner).state.buildings = previous;
  }
  row(host).state.buildings.home = 5;
  assert.equal(visit(guest, circle).market.available, true);
  assert.equal(visit(guest, circle).market.reason, null);
});

test("friend storefront purchases transfer common goods in both house 2 and house 5 directions", () => {
  for (const [buyerHome, sellerHome] of [[2, 5], [5, 2]]) {
    social.resetDevStoreForTests();
    const buyer = player(buyerHome, {}), seller = player(sellerHome), circle = connect(buyer, seller), listing = offer(seller);
    assert.equal(visit(buyer, circle).market.available, true);
    const sellerCoins = read(seller).wallet.coins;
    const result = economy.commandDevGuestWorldMarket(buyer.token, circle, buyCommand(buyer, listing), now);
    assert.equal(result.state.inventory.wood, 1);
    assert.equal(result.state.wallet.coins, 1000000 - listing.totalPrice);
    assert.equal(read(seller).wallet.coins, sellerCoins);
    assert.equal(economy.getDevEconomyMarket(seller.token, {}, now).mine[0].sale.proceedsCoins, 28);
  }
});

test("a friend buys outside the random showcase while the ordinary route still requires it", () => {
  const buyer = player(2, {}), seller = player(), circle = connect(buyer, seller), listing = offer(seller), request = buyCommand(buyer, listing);
  assert.throws(() => economy.commandDevEconomyMarket(buyer.token, request, now), { code: "ECONOMY_MARKET_SHOWCASE_CHANGED" });
  const sellerCoins = read(seller).wallet.coins;
  const result = economy.commandDevGuestWorldMarket(buyer.token, circle, request, now);
  assert.equal(result.replayed, false); assert.equal(result.state.inventory.wood, 1);
  assert.equal(result.state.wallet.coins, 1000000 - listing.totalPrice); assert.equal(read(seller).wallet.coins, sellerCoins);
  assert.equal(economy.getDevEconomyMarket(seller.token, {}, now).mine[0].sale.proceedsCoins, 28);
  assert.equal(visit(buyer, circle).market.listings.length, 0);
  assert.equal(globalThis.__zhivDevEconomyStore.showcases.has(buyer.me.user.publicId), false);
});

test("successful replay is exactly once and still bound to the same live friendship seller and buyer", () => {
  const buyer = player(2, {}), seller = player(), other = player(), circle = connect(buyer, seller), otherCircle = connect(buyer, other);
  const listing = offer(seller), request = buyCommand(buyer, listing), accepted = economy.commandDevGuestWorldMarket(buyer.token, circle, request, now);
  const before = snapshot();
  row(buyer).state.buildings.home = 1;
  const replay = economy.commandDevGuestWorldMarket(buyer.token, circle, request, now);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, accepted.acceptedRevision);
  row(buyer).state.buildings.home = 2;
  assert.deepEqual(snapshot(), before);
  assert.throws(() => economy.commandDevGuestWorldMarket(buyer.token, otherCircle, request, now), { code: "GUEST_WORLD_UNAVAILABLE" });
  assert.throws(() => economy.commandDevGuestWorldMarket(seller.token, circle, request, now), { code: "GUEST_WORLD_UNAVAILABLE" });
  assert.throws(() => economy.commandDevGuestWorldMarket(buyer.token, circle, { ...request, totalPrice: 40 }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  ok(social.updateDevSharing(seller.token, circle, "OFF"));
  assert.throws(() => economy.commandDevGuestWorldMarket(buyer.token, circle, request, now), { code: "GUEST_WORLD_UNAVAILABLE" });
});

test("a market receipt cannot replay between the general market and a friend's storefront in either direction", () => {
  for (const firstRoute of ["friend", "market"]) {
    social.resetDevStoreForTests();
    const buyer = player(2, {}), seller = player(), circle = connect(buyer, seller), listing = offer(seller);
    economy.getDevEconomyMarket(buyer.token, {}, now);
    const request = buyCommand(buyer, listing);
    const routes = { friend: () => economy.commandDevGuestWorldMarket(buyer.token, circle, request, now),
      market: () => economy.commandDevEconomyMarket(buyer.token, request, now) };
    const accepted = routes[firstRoute](), before = snapshot();
    assert.equal(accepted.replayed, false);
    assert.throws(routes[firstRoute === "friend" ? "market" : "friend"], { code: "ECONOMY_REQUEST_CONFLICT", status: 409 });
    assert.deepEqual(snapshot(), before);
    assert.equal(routes[firstRoute]().replayed, true); assert.deepEqual(snapshot(), before);
  }
});

test("reconnecting to the same friend cannot reuse the old friendship's purchase receipt", () => {
  const buyer = player(2, {}), seller = player(), oldCircle = connect(buyer, seller), listing = offer(seller), request = buyCommand(buyer, listing);
  economy.commandDevGuestWorldMarket(buyer.token, oldCircle, request, now);
  ok(social.removeDevPerson(buyer.token, oldCircle));
  const newCircle = connect(buyer, seller);
  assert.notEqual(newCircle, oldCircle); visit(buyer, newCircle);
  const before = snapshot();
  assert.throws(() => economy.commandDevGuestWorldMarket(buyer.token, newCircle, request, now),
    { code: "ECONOMY_REQUEST_CONFLICT", status: 409 });
  assert.throws(() => economy.commandDevGuestWorldMarket(buyer.token, oldCircle, request, now),
    { code: "GUEST_WORLD_UNAVAILABLE", status: 404 });
  assert.deepEqual(snapshot(), before);
});

test("friend purchases preserve revision owner quote resources capacity and eligibility checks atomically", () => {
  const cases = [
    ["ECONOMY_REVISION_CONFLICT", () => {}, request => ({ ...request, expectedRevision: request.expectedRevision + 1 })],
    ["ECONOMY_OWNER_CHANGED", () => {}, request => ({ ...request, ownerPublicId: "0000-0000-0000" })],
    ["ECONOMY_MARKET_QUOTE_CHANGED", () => {}, request => ({ ...request, totalPrice: 40 })],
    ["ECONOMY_RESOURCES", buyer => { row(buyer).state.wallet.coins = 0; }],
    ["ECONOMY_STORAGE_FULL", buyer => { row(buyer).state.inventory = { wood: 300 }; }],
    ["ECONOMY_MARKET_LOCKED", buyer => { row(buyer).state.buildings.bridge = 0; }],
    ["ECONOMY_MARKET_LOCKED", (_, seller) => { row(seller).state.buildings.bridge = 0; }],
    ["ECONOMY_MARKET_ITEM_LOCKED", () => { for (const listing of globalThis.__zhivDevEconomyStore.listings.values()) listing.totalPrice = 150; },
      request => ({ ...request, totalPrice: 150 })],
    ["ECONOMY_MARKET_DAILY_LIMIT", buyer => { globalThis.__zhivDevEconomyStore.turnover.set(buyer.me.user.publicId,
      { day: "2026-10-19", buysUsed: economyCatalog.market.dailyTradeValueByHome[1], salesUsed: 0, barterUsed: 0 }); }],
    ["ECONOMY_MARKET_SELLER_DAILY_LIMIT", (_, seller) => { globalThis.__zhivDevEconomyStore.turnover.set(seller.me.user.publicId,
      { day: "2026-10-19", buysUsed: 0, salesUsed: economyCatalog.market.dailyTradeValueByHome[1], barterUsed: 0 }); }],
  ];
  for (const [code, change, transform = request => request] of cases) {
    social.resetDevStoreForTests();
    const buyer = player(2, {}), seller = player(), circle = connect(buyer, seller), listing = offer(seller), request = buyCommand(buyer, listing);
    change(buyer, seller); const before = snapshot();
    assert.throws(() => economy.commandDevGuestWorldMarket(buyer.token, circle, transform(request), now), { code }, code);
    assert.deepEqual(snapshot(), before, code);
  }
});

test("visiting a higher-progress friend's storefront does not unlock undiscovered goods for the buyer", () => {
  const buyer = player(2, {}), seller = player(5, { fish_legendary: 1 }), circle = connect(buyer, seller);
  row(seller).state.unlockedItems.push("fish_legendary");
  const listing = offer(seller, 1, "fish_legendary"), request = buyCommand(buyer, listing), before = snapshot();
  assert.equal(visit(buyer, circle).market.listings[0].itemId, "fish_legendary");
  assert.throws(() => economy.commandDevGuestWorldMarket(buyer.token, circle, request, now), { code: "ECONOMY_MARKET_ITEM_LOCKED" });
  assert.deepEqual(snapshot(), before);
});

test("friend storefront does not allow create cancel or listings from a different host", () => {
  const buyer = player(), seller = player(), other = player(), circle = connect(buyer, seller), otherListing = offer(other);
  for (const action of ["create_listing", "cancel_listing"])
    assert.throws(() => economy.commandDevGuestWorldMarket(buyer.token, circle, command(buyer, action, otherListing.id, 1, 30), now),
      { code: "INVALID_ECONOMY_COMMAND", status: 400 });
  assert.throws(() => buy(buyer, circle, otherListing), { code: "GUEST_WORLD_UNAVAILABLE", status: 404 });
});

test("friend purchases preserve the real fish species in escrow without crediting catch discoveries", () => {
  const buyer = player(2, {}), seller = player(2, { fish_common: 2 }), circle = connect(buyer, seller);
  row(seller).state.fishing.stock = { fish_silverfin: 2 };
  const listing = offer(seller, 2, "fish_common");
  assert.deepEqual(row(seller).state.fishing.escrow[listing.id], { fish_silverfin: 2 });
  const result = buy(buyer, circle, listing);
  assert.equal(result.state.inventory.fish_common, 2); assert.deepEqual(result.state.fishing.stock, { fish_silverfin: 2 });
  assert.deepEqual(result.state.fishing.catches, {}); assert.equal(row(seller).state.fishing.escrow?.[listing.id], undefined);
  assert.equal(economyCatalog.market.feeBps, 500);
});
