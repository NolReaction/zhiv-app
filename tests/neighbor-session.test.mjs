import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { getEconomyNeighbor, sendNeighborCommand } = await vite.ssrLoadModule("/features/economy/sync/api.ts");
const { neighborViewSchema, neighborDefaultSettings } = await vite.ssrLoadModule("/features/economy/domain/neighbor-model.ts");
const { neighborQuoteReason, createNeighborQuote } = await vite.ssrLoadModule("/features/economy/ui/neighbor/neighbor-quote.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", now = Date.parse("2026-10-23T12:00:00Z");
const offerId = "00000000-0000-4000-8000-000000000003", key = `zhiv:economy:pending:v1:${owner}`;
const flush = () => new Promise(resolve => setImmediate(resolve));
function state(revision = 0, ownerPublicId = owner) {
  return economyViewSchema.parse({ ownerPublicId, revision, serverTime: new Date(now).toISOString(), wallet: { coins: revision ? 970 : 1000, pearls: 0 },
    inventory: revision ? { wood: 3 } : {}, buildings: { home: 2, bridge: 1, warehouse: 1 },
    storage: { capacity: 50, used: revision ? 3 : 0, reserved: 0, available: revision ? 47 : 50, overflow: 0 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog) });
}
function neighbor(purchased = false, ownerPublicId = owner) {
  return neighborViewSchema.parse({ ownerPublicId, serverTime: new Date(now).toISOString(),
    character: { id: "berest", kind: "world_character", name: "Берест", description: "Лесной сосед", world: {
      buildings: neighborDefaultSettings.buildings, equipment: neighborDefaultSettings.equipment, jobs: [], gifts: [], hiddenGifts: [] } },
    shop: { available: true, reason: null, cycleId: "2026-10-23", refreshAt: "2026-10-24T00:00:00.000Z",
      offers: [{ id: offerId, itemId: "wood", quantity: 3, totalPrice: 30, purchased }] },
    buying: { enabled: true, firstDelaySeconds: 180, staleAfterSeconds: 21600, maxLotsPerDay: 2, dailyBudgetCoins: 300, maxLotCoins: 150, usedLots: 0, spentCoins: 0 } });
}
const result = (snapshot = state(1), replayed = false) => ({ state: snapshot, message: "Партия куплена", acceptedRevision: 1, replayed });
function transport(overrides = {}) { return { get: async () => state(), send: async () => result(),
  market: async () => ({ ownerPublicId: owner, listings: [], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() }),
  trade: async () => result(), neighbor: async () => neighbor(), neighborTrade: async () => result(), ...overrides }; }
function storage() { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }
const command = overrides => ({ requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0, action: "buy_offer", targetId: offerId, quantity: 3, totalPrice: 30, ...overrides });

test("neighbor purchase shares the economy mutex and recovers the exact receipt after a lost response and reload", async () => {
  const cache = storage(), sent = []; let latest = state(), purchased = false;
  const t = transport({ get: async () => latest, neighbor: async () => neighbor(purchased), neighborTrade: async input => {
    sent.push(structuredClone(input)); latest = state(1); purchased = true;
    if (sent.length === 1) throw Error("committed response lost"); return result(latest, true);
  }, trade: () => assert.fail("must not send NPC commands to the player market") });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh(); await first.refreshNeighbor(); assert.equal(first.actNeighbor(offerId, 3, 30), true); await flush();
  assert.equal(first.getSnapshot().uncertain, true); assert.equal(first.actNeighbor(offerId, 3, 30), false);
  assert.equal(first.actMarket("buy_listing", offerId, 3, 30), false); assert.equal(first.act("start_exploration", "forest"), false);
  assert.deepEqual(JSON.parse(cache.getItem(key)), { kind: "neighbor", command: sent[0] }); stop();
  const restored = createEconomySession(owner, t, () => assert.fail(), cache), deactivate = restored.activate();
  await restored.refresh(); await restored.refreshNeighbor(); await restored.retry(); await flush();
  assert.deepEqual(sent[1], sent[0]); assert.equal(restored.getSnapshot().snapshot.wallet.coins, 970);
  assert.equal(restored.getSnapshot().neighbor.shop.offers[0].purchased, true); assert.equal(restored.getSnapshot().uncertain, false);
  assert.equal(cache.data.size, 0); deactivate();
});

test("neighbor writes never credit optimistically, and a late ACK after account switch cannot change the active session", async () => {
  let done, signal, calls = 0; const wait = new Promise(resolve => { done = resolve; });
  const old = createEconomySession(owner, transport({ neighborTrade: (_input, requestSignal) => { calls++; signal = requestSignal; return wait; } }), () => assert.fail());
  const stop = old.activate(); await old.refresh(); assert.equal(old.actNeighbor(offerId, 3, 30), true);
  assert.equal(old.actNeighbor(offerId, 3, 30), false); assert.deepEqual(old.getSnapshot().snapshot.inventory, {}); stop();
  const active = createEconomySession(other, transport({ get: async () => state(0, other), neighbor: async () => neighbor(false, other) }), () => assert.fail()), deactivate = active.activate();
  await active.refresh(); await active.refreshNeighbor(); assert.equal(signal.aborted, true); done(result()); await flush();
  assert.equal(calls, 1); assert.equal(old.getSnapshot().snapshot.revision, 0); assert.equal(active.getSnapshot().snapshot.ownerPublicId, other);
  assert.equal(active.getSnapshot().snapshot.revision, 0); assert.equal(active.getSnapshot().neighbor.ownerPublicId, other); deactivate();
});

test("strict restored neighbor receipts reject foreign owners, altered actions, fake routes and unexpected fields", async () => {
  const valid = { kind: "neighbor", command: command() };
  for (const receipt of [{ ...valid, command: command({ ownerPublicId: other }) }, { ...valid, command: command({ action: "buy_listing" }) },
    { ...valid, command: command({ targetId: "../market" }) }, { ...valid, command: command({ quantity: 0 }) },
    { ...valid, command: { ...command(), circleId: crypto.randomUUID() } }, { ...valid, fake: true }]) {
    const cache = storage(); cache.setItem(key, JSON.stringify(receipt));
    const session = createEconomySession(owner, transport({ neighborTrade: () => assert.fail("must not send malformed receipt") }), () => assert.fail(), cache), stop = session.activate();
    await session.refresh(); await session.retry(); assert.equal(cache.data.size, 0); assert.equal(session.getSnapshot().uncertain, false); stop();
  }
});

test("expired offer conflicts clear the receipt, refresh the shop, and use the latest economy revision next time", async () => {
  const cache = storage(); let latest = state(), reads = 0;
  const session = createEconomySession(owner, transport({ get: async () => latest, neighbor: async () => { reads++; return neighbor(); },
    neighborTrade: async () => { latest = state(4); throw new ApiError("Предложение устарело", 409, { code: "NEIGHBOR_OFFER_EXPIRED", message: "Предложение устарело" }); } }), () => assert.fail(), cache), stop = session.activate();
  await session.refresh(); await session.refreshNeighbor(); session.actNeighbor(offerId, 3, 30); await flush();
  assert.equal(cache.data.size, 0); assert.equal(session.getSnapshot().uncertain, false); assert.equal(session.getSnapshot().snapshot.revision, 4); assert.equal(reads, 2); stop();
});

test("in-flight neighbor reads are invalidated before a purchase can mark its offer bought", async () => {
  let resolve; const stale = new Promise(done => { resolve = done; }); let count = 0;
  const session = createEconomySession(owner, transport({ neighbor: () => ++count === 1 ? Promise.resolve(neighbor()) : count === 2 ? stale : Promise.resolve(neighbor(true)) }), () => assert.fail()), stop = session.activate();
  await session.refresh(); await session.refreshNeighbor(); const reading = session.refreshNeighbor(); session.actNeighbor(offerId, 3, 30); await flush();
  assert.equal(session.getSnapshot().neighbor.shop.offers[0].purchased, true); resolve(neighbor(false)); await reading;
  assert.equal(session.getSnapshot().neighbor.shop.offers[0].purchased, true); stop();
});

test("neighbor quote rejects deadline, owner, revision, storage, price, stock, access and daily budget changes", () => {
  const controller = () => ({ snapshot: state(), snapshotConfirmed: true, now, retryAt: 0, directActionsAvailable: true, busy: false, uncertain: false });
  for (const invalidate of [e => { e.snapshot.ownerPublicId = other; }, e => { e.snapshot.revision++; }, e => { e.snapshot.storage.available = 1; },
    e => { e.snapshot.wallet.coins = 1; }, e => { e.snapshot.buildings.bridge = 0; }, e => { e.uncertain = true; }, e => { e.directActionsAvailable = false; }]) {
    const e = controller(), n = neighbor(), q = createNeighborQuote(e, n, n.shop.offers[0]); assert.equal(neighborQuoteReason(e, n, q), null); invalidate(e); assert.ok(neighborQuoteReason(e, n, q));
  }
  const e = controller(), n = neighbor(), q = createNeighborQuote(e, n, n.shop.offers[0]);
  assert.match(neighborQuoteReason(e, n, q, q.expiresAt), /устарело/);
  assert.match(neighborQuoteReason(e, n, { ...q, expiresAt: now + 86400000 }, Date.parse(n.shop.refreshAt)), /устарело/);
  n.shop.offers[0].totalPrice++; assert.match(neighborQuoteReason(e, n, q), /изменилось/); n.shop.offers[0].totalPrice--;
  n.shop.offers[0].purchased = true; assert.match(neighborQuoteReason(e, n, q), /уже куплена/); n.shop.offers[0].purchased = false;
  e.market = { ownerPublicId: owner, tradeBudget: { buysUsed: 100, limit: 100, resetsAt: new Date(now + 10000).toISOString() } };
  assert.match(neighborQuoteReason(e, n, q), /Дневной объём/);
});

test("neighbor API validates owner and exact command schema, keeping NPC requests on their own endpoint", async () => {
  const previous = globalThis.fetch, sent = []; let response = neighbor();
  globalThis.fetch = async (path, options) => { sent.push({ path, options }); return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } }); };
  try {
    await getEconomyNeighbor(owner); assert.equal(sent[0].path, "/api/v1/economy/neighbor");
    response = neighbor(false, other); await assert.rejects(getEconomyNeighbor(owner), error => error.status === 401);
    response = result(); const input = command(); await sendNeighborCommand(input);
    assert.equal(sent.at(-1).path, "/api/v1/economy/neighbor/commands"); assert.deepEqual(JSON.parse(sent.at(-1).options.body), input);
    assert.equal(sent.at(-1).options.credentials, "same-origin"); assert.equal(sent.at(-1).options.cache, "no-store");
    const count = sent.length; await assert.rejects(sendNeighborCommand(command({ action: "buy_listing" })), error => error.status === 400); assert.equal(sent.length, count);
    response = result(state(1, other)); await assert.rejects(sendNeighborCommand(input), error => error.status === 401);
  } finally { globalThis.fetch = previous; }
});
