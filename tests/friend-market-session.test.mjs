import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { sendFriendMarketCommand } = await vite.ssrLoadModule("/features/economy/sync/api.ts");
const { setGamePresence } = await vite.ssrLoadModule("/features/activity/transport-state.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002";
const circle = "00000000-0000-4000-8000-000000000001", otherCircle = "00000000-0000-4000-8000-000000000002";
const listingId = "00000000-0000-4000-8000-000000000003", now = Date.parse("2026-10-18T21:00:00Z");
const storageKey = `zhiv:economy:pending:v1:${owner}`;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const listing = status => ({ id: listingId, sellerPublicId: other, sellerName: "Сосед", itemId: "wood", quantity: 3, totalPrice: 10,
  status, createdAt: new Date(now - 1000).toISOString(), closedAt: status === "active" ? null : new Date(now).toISOString(), owned: false });
function state(revision = 0, ownerPublicId = owner) {
  return economyViewSchema.parse({ ownerPublicId, revision, serverTime: new Date(now).toISOString(), wallet: { coins: revision ? 990 : 1000, pearls: 0 },
    inventory: revision ? { wood: 3 } : {}, buildings: { home: 2, bridge: 1, warehouse: 1 },
    storage: { capacity: 50, used: revision ? 3 : 0, reserved: 0, available: revision ? 47 : 50, overflow: 0 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog) });
}
const result = (snapshot = state(1), replayed = false) => ({ state: snapshot, message: "Покупка готова", acceptedRevision: 1, replayed, listing: listing("sold") });
function transport(overrides = {}) {
  return { get: async () => state(), send: async () => result(),
    market: async () => ({ ownerPublicId: owner, listings: [], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() }),
    trade: async () => result(), friendTrade: async () => result(), ...overrides };
}
function storage() { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }
const command = overrides => ({ requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0,
  action: "buy_listing", targetId: listingId, quantity: 3, totalPrice: 10, ...overrides });

test("a lost friend purchase retains its circle and exact receipt across a reload, sharing the economy mutex", async () => {
  const cache = storage(), sent = []; let latest = state(), otherWrites = 0;
  const t = transport({ get: async () => latest, send: async () => { otherWrites++; return result(); }, trade: async () => { otherWrites++; return result(); },
    friendTrade: async (circleId, input) => {
      sent.push({ circleId, command: structuredClone(input) }); latest = state(1);
      if (sent.length === 1) throw Error("Committed purchase response lost");
      return result(latest, true);
    } });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh();
  assert.equal(first.actFriendMarket(circle, listingId, 3, 10), true); await flush();
  assert.equal(first.getSnapshot().uncertain, true);
  assert.deepEqual(JSON.parse(cache.getItem(storageKey)), { kind: "friend_market", ...sent[0] });
  assert.equal(first.actFriendMarket(otherCircle, listingId, 3, 10), false);
  assert.equal(first.actMarket("buy_listing", listingId, 3, 10), false);
  assert.equal(first.act("start_exploration", "forest"), false);
  assert.equal(sent.length, 1); assert.equal(otherWrites, 0); stop();
  const restored = createEconomySession(owner, t, () => assert.fail(), cache), deactivate = restored.activate();
  await restored.refresh(); assert.equal(restored.getSnapshot().uncertain, true);
  await restored.retry(); await flush();
  assert.deepEqual(sent[1], sent[0], "circle, request ID, expected revision, quantity and price all survive restoration");
  assert.equal(sent[1].circleId, circle); assert.equal(otherWrites, 0, "a friend receipt must never fall through to the public market");
  assert.equal(restored.getSnapshot().snapshot.wallet.coins, 990);
  assert.equal(restored.getSnapshot().snapshot.inventory.wood, 3);
  assert.equal(restored.getSnapshot().inventoryGains.length, 0, "an already applied purchase cannot repeat its feedback on reload");
  assert.equal(restored.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0); deactivate();
});

test("a confirmed local purchase publishes the buyer's actual stock and one purchase gain, while double taps wait", async () => {
  const wait = deferred(), sent = [];
  const session = createEconomySession(owner, transport({ friendTrade: (circleId, input) => { sent.push({ circleId, input }); return wait.promise; } }), () => assert.fail());
  const stop = session.activate(); await session.refresh();
  assert.equal(session.actFriendMarket(circle, listingId, 3, 10), true);
  assert.equal(session.actFriendMarket(circle, listingId, 3, 10), false);
  assert.deepEqual(session.getSnapshot().snapshot.inventory, {}, "the client never grants a purchase optimistically");
  wait.resolve(result()); await flush();
  assert.equal(sent.length, 1); assert.equal(session.getSnapshot().snapshot.wallet.coins, 990);
  assert.deepEqual(session.getSnapshot().inventoryGains[0].items, [{ itemId: "wood", quantity: 3 }]);
  assert.equal(session.getSnapshot().inventoryGains[0].source, "purchase");
  await session.retry(); assert.equal(session.getSnapshot().inventoryGains.length, 1); stop();
});

test("ordinary pending commands and account availability also block friend purchases", async () => {
  const wait = deferred(); let sends = 0;
  const session = createEconomySession(owner, transport({ send: () => wait.promise, friendTrade: async () => { sends++; return result(); } }), () => assert.fail());
  assert.equal(session.actFriendMarket(circle, listingId, 3, 10), false);
  const stop = session.activate(); await session.refresh();
  for (const [setter, value] of [["setDirectActionsAvailable", false], ["setLocalActionsAvailable", false], ["setAvailable", false]]) {
    session[setter](value); assert.equal(session.actFriendMarket(circle, listingId, 3, 10), false); session[setter](true);
  }
  for (const args of [["../market", listingId, 3, 10], [circle, "not-a-listing", 3, 10], [circle, listingId, 0, 10], [circle, listingId, 3, -1]]) {
    assert.equal(session.actFriendMarket(...args), false);
  }
  assert.equal(session.act("start_exploration", "forest"), true);
  assert.equal(session.actFriendMarket(circle, listingId, 3, 10), false);
  wait.resolve(result()); await flush(); assert.equal(sends, 0); stop();
});

test("restored friend receipts reject a missing circle, changed action, foreign owner and unexpected fields", async () => {
  const valid = { kind: "friend_market", circleId: circle, command: command() };
  const malformed = [
    { ...valid, circleId: undefined }, { ...valid, circleId: "../market" },
    { ...valid, command: command({ action: "create_listing" }) }, { ...valid, command: command({ action: "cancel_listing" }) },
    { ...valid, command: command({ ownerPublicId: other }) }, { ...valid, command: command({ targetId: "wood" }) },
    { ...valid, extra: "ignored circle" }, { ...valid, command: { ...command(), extra: 1 } },
    { ...valid, command: command({ fishSelection: { fish: 3 } }) },
  ];
  for (const receipt of malformed) {
    const cache = storage(); cache.setItem(storageKey, JSON.stringify(receipt)); let sends = 0;
    const session = createEconomySession(owner, transport({ trade: async () => { sends++; return result(); }, friendTrade: async () => { sends++; return result(); } }), () => assert.fail(), cache);
    const stop = session.activate(); await session.refresh(); await session.retry();
    assert.equal(sends, 0); assert.equal(cache.data.size, 0); assert.equal(session.getSnapshot().uncertain, false); stop();
  }
  const cache = storage(); cache.setItem(storageKey, JSON.stringify(valid));
  const unsupported = createEconomySession(owner, transport({ friendTrade: undefined }), () => assert.fail(), cache), stop = unsupported.activate();
  await unsupported.refresh(); assert.equal(unsupported.actFriendMarket(circle, listingId, 3, 10), false); assert.equal(cache.data.size, 0); stop();
});

test("a definitive sold-out conflict clears only that purchase and uses the refreshed revision for the next attempt", async () => {
  const cache = storage(), sent = []; let latest = state();
  const session = createEconomySession(owner, transport({ get: async () => latest, friendTrade: async (circleId, input) => {
    sent.push({ circleId, input }); latest = state(4);
    throw new ApiError("Товар уже купили", 409, { code: "MARKET_LISTING_UNAVAILABLE", message: "Товар уже купили" });
  } }), () => assert.fail(), cache);
  const stop = session.activate(); await session.refresh(); session.actFriendMarket(circle, listingId, 3, 10); await flush();
  assert.equal(cache.data.size, 0); assert.equal(session.getSnapshot().uncertain, false); assert.equal(session.getSnapshot().snapshot.revision, 4);
  session.actFriendMarket(otherCircle, listingId, 3, 10); await flush();
  assert.equal(sent[1].circleId, otherCircle); assert.equal(sent[1].input.expectedRevision, 4);
  assert.notEqual(sent[1].input.requestId, sent[0].input.requestId); stop();
});

test("foreign buyer receipts and late inactive responses never replace the local economy", async () => {
  const cache = storage(); let lost = 0;
  const session = createEconomySession(owner, transport({ friendTrade: async () => result(state(1, other)) }), () => lost++, cache);
  const stop = session.activate(); await session.refresh(); session.actFriendMarket(circle, listingId, 3, 10); await flush();
  assert.equal(lost, 1); assert.equal(session.getSnapshot().snapshot.ownerPublicId, owner);
  assert.equal(session.getSnapshot().snapshot.revision, 0); assert.equal(cache.data.size, 1); stop();
  const wait = deferred(); let signal;
  const inactive = createEconomySession(owner, transport({ friendTrade: (_circleId, _input, requestSignal) => { signal = requestSignal; return wait.promise; } }), () => assert.fail());
  const deactivate = inactive.activate(); await inactive.refresh(); inactive.actFriendMarket(circle, listingId, 3, 10); deactivate();
  assert.equal(signal.aborted, true); wait.resolve(result()); await flush();
  assert.equal(inactive.getSnapshot().snapshot.revision, 0); assert.equal(inactive.getSnapshot().inventoryGains.length, 0);
});

test("friend market rate limits retain one receipt and cannot start an automatic retry storm", async () => {
  const cache = storage(); let sends = 0;
  const session = createEconomySession(owner, transport({ friendTrade: async () => { sends++; throw new ApiError("Подождите", 429, undefined, undefined, 60_000); } }), () => assert.fail(), cache);
  const stop = session.activate(); await session.refresh(); session.actFriendMarket(circle, listingId, 3, 10); await flush();
  for (let attempt = 0; attempt < 5; attempt++) await session.retry();
  assert.equal(sends, 1); assert.equal(session.getSnapshot().uncertain, true); assert.equal(cache.data.size, 1);
  assert.ok(session.getSnapshot().retryAt >= now + 59_000); stop();
});

test("friend purchase API uses presence, strict JSON and the relationship-scoped endpoint with owner validation", async () => {
  const previous = globalThis.fetch, requests = []; let answer = result();
  globalThis.fetch = async (path, options) => { requests.push({ path, options }); return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } }); };
  setGamePresence(circle);
  try {
    const input = command(), signal = new AbortController().signal;
    await sendFriendMarketCommand(circle, input, signal);
    assert.equal(requests[0].path, `/api/v1/people/${circle}/world/market/commands`);
    assert.equal(requests[0].options.method, "POST"); assert.equal(requests[0].options.cache, "no-store"); assert.equal(requests[0].options.credentials, "same-origin");
    assert.equal(requests[0].options.headers["X-Game-Presence"], circle);
    assert.deepEqual(JSON.parse(requests[0].options.body), input); assert.ok(requests[0].options.signal instanceof AbortSignal);
    answer = result(state(1, other)); await assert.rejects(sendFriendMarketCommand(circle, input), error => error instanceof ApiError && error.status === 401);
    answer = { state: { ownerPublicId: owner } }; await assert.rejects(sendFriendMarketCommand(circle, input), error => error instanceof ApiError && error.status === 502);
    const beforeInvalid = requests.length;
    await assert.rejects(sendFriendMarketCommand("../economy", input), error => error instanceof ApiError && error.status === 400);
    await assert.rejects(sendFriendMarketCommand(circle, command({ action: "create_listing" })), error => error instanceof ApiError && error.status === 400);
    assert.equal(requests.length, beforeInvalid, "invalid route and non-purchase intent never reach the network");
  } finally { setGamePresence(null); globalThis.fetch = previous; }
});
