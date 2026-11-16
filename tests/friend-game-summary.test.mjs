import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const social = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { marketMinimumPrice } = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const { getPeople } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const originalFetch = globalThis.fetch;
const now = Date.parse("2026-11-01T12:00:00Z"), key = () => crypto.randomUUID();
const ok = result => { assert.equal(result.kind, "ok"); return result.value; };
const identity = () => social.createDevIdentity("Друг", key());
const read = player => economy.getDevEconomy(player.token, now);
const row = player => globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
const people = player => ok(social.listDevPeople(player.token));
function connect(a, b) {
  const request = ok(social.sendDevDirectRequest(a.token, b.me.user.publicId, key()));
  return ok(social.actOnDevDirectRequest(b.token, request.request.requestId, "ACCEPTED")).person.circleId;
}
function player() {
  const value = identity(); read(value);
  Object.assign(row(value).state, { inventory: { wood: 100, metal_parts: 5 }, wallet: { coins: 100000, pearls: 0 },
    completedExplorations: 1, unlockedItems: ["wood"], itemUnlockVersion: 1 });
  Object.assign(row(value).state.buildings, { home: 2, bridge: 1, warehouse: 6 });
  return value;
}
function offer(owner, itemId = "wood") {
  return economy.commandDevEconomyMarket(owner.token, { requestId: key(), ownerPublicId: owner.me.user.publicId,
    expectedRevision: read(owner).revision, action: "create_listing", targetId: itemId, quantity: 1,
    totalPrice: Math.ceil(marketMinimumPrice(itemId, 1) / 10) * 10 }, now).listing;
}
beforeEach(() => social.resetDevStoreForTests());
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => vite.close());

test("friend levels come from XP and unopened games remain read-only", () => {
  const buyer = identity(), seller = identity(); connect(buyer, seller);
  const before = structuredClone(globalThis.__zhivDevEconomyStore);
  const summary = people(buyer).people[0].gameSummary;
  assert.equal(summary.level, 1); assert.equal(typeof summary.level, "number");
  assert.deepEqual(summary.market, { available: false, reason: "buyer_locked", count: 0, listings: [] });
  assert.deepEqual(globalThis.__zhivDevEconomyStore, before);
  read(seller); row(seller).state.progression.player = { xp: 480 };
  row(seller).state.buildings.home = 2;
  assert.equal(people(buyer).people[0].gameSummary.level, 5);
  assert.deepEqual(Object.keys(people(buyer).people[0].gameSummary).sort(), ["level", "market"]);
});

test("preview counts only visible active lots then limits the newest first list to three", () => {
  const buyer = player(), seller = player(); connect(buyer, seller);
  row(seller).state.unlockedItems.push("metal_parts");
  const wood = Array.from({ length: 4 }, () => offer(seller));
  offer(seller, "metal_parts");
  const before = structuredClone(globalThis.__zhivDevEconomyStore);
  const summary = people(buyer).people[0].gameSummary;
  assert.equal(summary.market.available, true); assert.equal(summary.market.reason, null);
  assert.equal(summary.market.count, 4); assert.equal(summary.market.listings.length, 3);
  assert.deepEqual(summary.market.listings.map(lot => lot.id), wood.map(lot => lot.id).sort().reverse().slice(0, 3));
  assert(summary.market.listings.every(lot => lot.itemId === "wood" && lot.totalPrice === marketMinimumPrice("wood", 1)));
  assert.deepEqual(Object.keys(summary.market.listings[0]).sort(), ["id", "itemId", "quantity", "totalPrice"]);
  assert.deepEqual(globalThis.__zhivDevEconomyStore, before);
  globalThis.__zhivDevEconomyStore.listings.get(wood[0].id).status = "cancelled";
  assert.equal(people(buyer).people[0].gameSummary.market.count, 3);
});

test("world OFF hides offers while the existing safe friend level remains visible", () => {
  const buyer = player(), seller = player(), circle = connect(buyer, seller); offer(seller);
  row(seller).state.progression.player = { xp: 480 };
  ok(social.updateDevSharing(seller.token, circle, "OFF"));
  assert.deepEqual(people(buyer).people[0].gameSummary, { level: 5,
    market: { available: false, reason: "world_hidden", count: 0, listings: [] } });
  ok(social.updateDevSharing(seller.token, circle, "LATEST_ONLY"));
  assert.equal(people(buyer).people[0].gameSummary.market.count, 1);
  ok(social.removeDevPerson(buyer.token, circle)); assert.deepEqual(people(buyer).people, []);
  assert.deepEqual(social.listDevPeople(undefined), { kind: "unauthorized" });
});

test("group privacy and missing confirmed market gates hide previews", () => {
  const buyer = player(), seller = player(), circle = connect(buyer, seller); offer(seller);
  const group = ok(social.createDevGroup(seller.token, "Группа", null, [circle], key())).groupId;
  const invite = ok(social.listDevGroups(buyer.token)).incomingInvites.find(invite => invite.groupId === group);
  ok(social.actOnDevGroupInvite(buyer.token, invite.inviteId, "ACCEPTED"));
  ok(social.updateDevGroupSharing(seller.token, group, "OFF"));
  assert.equal(people(buyer).people[0].gameSummary.market.reason, "world_hidden");
  ok(social.updateDevGroupSharing(seller.token, group, "LATEST_ONLY"));
  row(buyer).state.buildings.bridge = 0;
  assert.equal(people(buyer).people[0].gameSummary.market.reason, "buyer_locked");
  row(buyer).state.buildings.bridge = 1; row(seller).state.buildings.bridge = 0;
  assert.equal(people(buyer).people[0].gameSummary.market.reason, "seller_locked");
});

test("legacy currency is normalized before current-price eligibility and no pending request leaks a summary", () => {
  const buyer = player(), seller = player();
  ok(social.sendDevDirectRequest(buyer.token, seller.me.user.publicId, key()));
  assert.deepEqual(people(buyer).people, []);
  const request = people(seller).incomingRequests[0];
  ok(social.actOnDevDirectRequest(seller.token, request.requestId, "ACCEPTED"));
  const listing = offer(seller), saved = globalThis.__zhivDevEconomyStore.listings.get(listing.id);
  saved.totalPrice = listing.totalPrice / 10; saved.currencyScale = 1;
  assert.equal(people(buyer).people[0].gameSummary.market.listings[0].totalPrice, listing.totalPrice);
  saved.totalPrice = 0;
  assert.equal(people(buyer).people[0].gameSummary.market.count, 0);
});

test("people parser preserves the optional safe summary and accepts older responses without it", async () => {
  const buyer = player(), seller = player(); connect(buyer, seller); offer(seller);
  const response = people(buyer);
  globalThis.fetch = async () => Response.json(response);
  assert.deepEqual((await getPeople()).people[0].gameSummary, response.people[0].gameSummary);
  delete response.people[0].gameSummary;
  assert.equal((await getPeople()).people[0].gameSummary, undefined);
});

test("people parser rejects private fields, unbounded previews and inconsistent availability", async () => {
  const buyer = player(), seller = player(); connect(buyer, seller); offer(seller);
  const response = people(buyer);
  for (const mutate of [
    summary => { summary.level = { level: 5 }; },
    summary => { summary.wallet = { coins: 999 }; },
    summary => { summary.market.listings[0].sellerPublicId = seller.me.user.publicId; },
    summary => { summary.market.count = 11; },
    summary => { summary.market.listings.push(...Array(3).fill(summary.market.listings[0])); },
    summary => { summary.market.available = false; summary.market.reason = "world_hidden"; },
  ]) {
    const value = structuredClone(response); mutate(value.people[0].gameSummary);
    globalThis.fetch = async () => Response.json(value);
    await assert.rejects(getPeople(), undefined, mutate.toString());
  }
});
