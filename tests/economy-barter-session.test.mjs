import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/session.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const { barterCommandSchema, barterViewSchema, barterResultSchema } = await vite.ssrLoadModule("/features/economy/barter-model.ts");
const { getEconomyBarter, sendBarterCommand } = await vite.ssrLoadModule("/features/economy/barter-api.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", now = Date.parse("2026-10-05T16:00:00Z");
const offerId = "00000000-0000-4000-8000-000000000001";
const createIntent = { action: "create_offer", offeredItemId: "ancient_core", requestedItemId: "moon_crystal" };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function state(revision = 0, ownerPublicId = owner) {
  return economyViewSchema.parse({ ownerPublicId, revision, serverTime: new Date(now).toISOString(), wallet: { coins: 50, pearls: 0 },
    inventory: { ancient_core: 1, moon_crystal: 1, living_resin: 1 }, buildings: { home: 3, warehouse: 3 },
    storage: { capacity: 300, used: 3, reserved: 0, available: 297, overflow: 0 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog) });
}
function offer(status = "active", owned = true) {
  return { id: offerId, sellerPublicId: owned ? owner : other, sellerName: "Лесной сосед", offeredItemId: "ancient_core", requestedItemId: "moon_crystal", status,
    createdAt: new Date(now - 1000).toISOString(), closedAt: status === "active" ? null : new Date(now).toISOString(), owned };
}
function shelf(ownerPublicId = owner) {
  return { ownerPublicId, offers: [], mine: [], serverTime: new Date(now).toISOString(), showcase: { refreshAt: new Date(now + 1800_000).toISOString(), slots: 6, maxPerSeller: 1, refreshSeconds: 1800 } };
}
const result = (snapshot = state(1), replayed = false) => ({ state: snapshot, message: "Предложение сохранено", acceptedRevision: 1, replayed, offer: offer() });
function transport(overrides = {}) {
  return { get: async () => state(), send: async () => ({ ...result(), listing: null }), market: async () => ({ listings: [], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() }),
    trade: async () => result(), barter: async () => shelf(), barterTrade: async () => result(), ...overrides };
}
function storage() { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }

test("barter schemas reject extra price/quantity, same material and noncanonical offer IDs", () => {
  const base = { requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0 };
  assert.equal(barterCommandSchema.safeParse({ ...base, ...createIntent }).success, true);
  for (const malformed of [{ ...createIntent, quantity: 1 }, { ...createIntent, totalPrice: 0 }, { ...createIntent, requestedItemId: "ancient_core" },
    { action: "accept_offer", offerId, offeredItemId: "ancient_core" }, { action: "accept_offer", offerId: "00000000-0000-1000-8000-000000000001" },
    { action: "exchange", offerId }, { action: "cancel_offer", offerId, requestedItemId: "moon_crystal" }]) {
    assert.equal(barterCommandSchema.safeParse({ ...base, ...malformed }).success, false);
  }
  assert.equal(barterViewSchema.safeParse(shelf()).success, true);
  const missingOwner = shelf(); delete missingOwner.ownerPublicId;
  assert.equal(barterViewSchema.safeParse(missingOwner).success, false);
  const missingOffer = result(); delete missingOffer.offer;
  assert.equal(barterResultSchema.safeParse(missingOffer).success, false);
  assert.equal(barterResultSchema.safeParse(result(state(2), true)).success, true, "replayed original offer may remain active while state is fresh");
});

test("uncertain barter shares the durable economy lock and replays one exact receipt after closing", async () => {
  const cache = storage(), commands = []; let latest = state(), reads = 0, shelves = 0, otherWrites = 0;
  const t = transport({ get: async () => { reads++; return latest; }, barter: async () => { shelves++; return { ...shelf(), mine: [offer()] }; },
    send: async () => { otherWrites++; return result(); }, trade: async () => { otherWrites++; return result(); },
    barterTrade: async command => { commands.push(structuredClone(command)); latest = state(1); latest.inventory.ancient_core = 0;
      if (commands.length === 1) throw new Error("Response lost after commit"); return result(latest, true); } });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh(); first.actBarter(createIntent); await flush();
  assert.equal(first.getSnapshot().uncertain, true); assert.equal(cache.data.size, 1);
  first.act("start_exploration", "forest"); first.actMarket("create_listing", "wood", 1, 3); first.actBarter(createIntent);
  assert.equal(commands.length, 1); assert.equal(otherWrites, 0);
  stop();
  const next = createEconomySession(owner, t, () => assert.fail(), cache); next.activate(); await next.refresh();
  assert.equal(next.getSnapshot().uncertain, true);
  await next.retry(); await flush();
  assert.deepEqual(commands[1], commands[0]); assert.equal(cache.data.size, 0); assert.equal(next.getSnapshot().uncertain, false);
  assert.equal(next.getSnapshot().snapshot.inventory.ancient_core, 0); assert.equal(next.getSnapshot().barter.mine.length, 1);
  assert.ok(reads >= 3, "confirmed command refreshes authoritative economy as well as barter"); assert.equal(shelves, 1);
});

test("a double submit waits for confirmation and a late shelf read cannot overwrite it", async () => {
  const old = deferred(), pending = deferred(); let reads = 0, sends = 0;
  const session = createEconomySession(owner, transport({ barter: () => ++reads === 1 ? old.promise : Promise.resolve({ ...shelf(), mine: [offer()] }),
    barterTrade: () => { sends++; return pending.promise; }, get: async () => state(1) }), () => assert.fail());
  session.activate(); await session.refresh(); const oldRead = session.refreshBarter();
  session.actBarter(createIntent); session.actBarter(createIntent); assert.equal(sends, 1);
  assert.equal(session.getSnapshot().snapshot.inventory.ancient_core, 1, "no optimistic inventory debit");
  pending.resolve(result()); await flush(); old.resolve(shelf()); await oldRead; await flush();
  assert.equal(session.getSnapshot().barter.mine.length, 1);
});

test("definitive conflict clears the receipt and a deliberate retry takes the new revision", async () => {
  const commands = [], cache = storage(); let latest = state();
  const session = createEconomySession(owner, transport({ get: async () => latest,
    barterTrade: async command => { commands.push(command); latest = state(4); throw new ApiError("Запасы изменились", 409, { code: "ECONOMY_REVISION_CONFLICT", message: "Запасы изменились" }); } }), () => assert.fail(), cache);
  session.activate(); await session.refresh(); session.actBarter(createIntent); await flush();
  assert.equal(session.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0); assert.equal(session.getSnapshot().snapshot.revision, 4);
  session.actBarter(createIntent); await flush();
  assert.equal(commands[1].expectedRevision, 4); assert.notEqual(commands[1].requestId, commands[0].requestId);
});

test("rate limiting keeps the exact barter intent and prevents automatic retry storms", async () => {
  let sends = 0;
  const session = createEconomySession(owner, transport({ barterTrade: async () => { sends++; throw new ApiError("Подождите", 429, undefined, undefined, 60_000); } }), () => assert.fail());
  session.activate(); await session.refresh(); session.actBarter(createIntent); await flush();
  for (let index = 0; index < 10; index++) await session.retry();
  assert.equal(sends, 1); assert.equal(session.getSnapshot().uncertain, true); assert.ok(session.getSnapshot().retryAt >= now + 59_000);
});

test("foreign accounts and inactive late responses never publish a shelf or send another owner's receipt", async () => {
  const cache = storage(), wait = deferred(); let lost = 0, sends = 0;
  cache.setItem(`zhiv:economy:pending:v1:${other}`, JSON.stringify({ kind: "barter", command: { ...createIntent, requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0 } }));
  const session = createEconomySession(other, transport({ get: async () => state(0, other), barter: async () => shelf(owner), barterTrade: async () => { sends++; return result(); } }), () => lost++, cache);
  session.activate(); await session.refresh(); await session.refreshBarter(); await session.retry();
  assert.equal(session.getSnapshot().barter, null); assert.equal(lost, 1); assert.equal(sends, 0); assert.equal(cache.data.size, 0);
  const old = createEconomySession(owner, transport({ barter: () => wait.promise }), () => lost++); const stop = old.activate();
  const read = old.refreshBarter(); stop(); wait.resolve(shelf()); await read;
  assert.equal(old.getSnapshot().barter, null);
});

test("malformed restored barter and original replay offers cannot fabricate current shelf entries", async () => {
  const cache = storage(); cache.setItem(`zhiv:economy:pending:v1:${owner}`, JSON.stringify({ kind: "barter", command: { ...createIntent, requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0, quantity: 10 } }));
  const session = createEconomySession(owner, transport({ get: async () => state(2), barter: async () => shelf(), barterTrade: async () => result(state(2), true) }), () => assert.fail(), cache);
  session.activate(); await session.refresh(); assert.equal(session.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
  session.actBarter(createIntent); await flush();
  assert.deepEqual(session.getSnapshot().barter.mine, [], "the receipt's old active offer is not added to a fresh empty shelf");
});

test("barter API sends strict JSON and rejects another owner or missing mandatory receipt offer", async () => {
  const previous = globalThis.fetch, requests = []; let response = shelf();
  globalThis.fetch = async (path, options) => { requests.push({ path, options }); return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } }); };
  try {
    await getEconomyBarter(owner); assert.equal(requests[0].path, "/api/v1/economy/barter");
    assert.equal(requests[0].options.cache, "no-store"); assert.equal(requests[0].options.credentials, "same-origin");
    const command = { ...createIntent, requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0 };
    response = result(); await sendBarterCommand(command);
    assert.deepEqual(JSON.parse(requests[1].options.body), command); assert.equal(requests[1].options.method, "POST");
    response = shelf(other); await assert.rejects(getEconomyBarter(owner), error => error instanceof ApiError && error.status === 401);
    response = result(state(1, other)); await assert.rejects(sendBarterCommand(command), error => error instanceof ApiError && error.status === 401);
    response = result(); delete response.offer; await assert.rejects(sendBarterCommand(command), error => error instanceof ApiError && error.status === 502);
  } finally { globalThis.fetch = previous; }
});
