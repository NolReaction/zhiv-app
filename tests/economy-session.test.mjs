import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/session.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", now = Date.now();
const state = (revision = 0, ownerPublicId = owner) => ({ ownerPublicId, revision, serverTime: new Date(now).toISOString(), wallet: { coins: 100, pearls: 0 }, inventory: {},
  buildings: { home: 1, garden: 1, warehouse: 1, kiln: 0 }, storage: { capacity: 200, used: 0, reserved: 0, available: 200, overflow: 0 },
  jobs: [], migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog, completedExplorations: 0 });
const market = () => ({ listings: [], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() });
const result = snapshot => ({ state: snapshot, message: "Готово", acceptedRevision: snapshot.revision, replayed: false });
const transport = overrides => ({ get: async () => state(), send: async () => result(state(1)), market: async () => market(), trade: async () => result(state(1)), ...overrides });
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function storage() { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data }; }

test("uncertain purchase uses same receipt, blocks other writes and survives session recreation", async () => {
  const cache = storage(), sent = []; let wallet = state();
  const t = transport({ trade: async command => {
    sent.push(structuredClone(command));
    if (sent.length === 1) { wallet = state(1); wallet.wallet.coins = 70; throw Error("Response lost after commit"); }
    return { ...result(wallet), replayed: true };
  }, get: async () => wallet });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh();
  first.actMarket("buy_listing", crypto.randomUUID(), 6, 30); await flush();
  assert.equal(first.getSnapshot().uncertain, true); assert.equal(cache.data.size, 1);
  first.act("start_exploration", "forest"); first.actMarket("create_listing", "wood", 1, 4);
  assert.equal(sent.length, 1);
  stop();
  const next = createEconomySession(owner, t, () => assert.fail(), cache); next.activate(); await next.refresh();
  assert.equal(next.getSnapshot().uncertain, true);
  await next.retry();
  assert.deepEqual(sent[0], sent[1]); assert.equal(next.getSnapshot().snapshot.wallet.coins, 70);
  assert.equal(next.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
});

test("definitive conflict refreshes balance and permits a deliberate new command", async () => {
  let sent = 0, latest = state();
  const session = createEconomySession(owner, transport({ get: async () => latest, send: async () => {
    sent++; if (sent === 1) { latest = state(5); throw new ApiError("Обновите хозяйство", 409); }
    return result(state(6));
  } }), () => assert.fail());
  session.activate(); await session.refresh(); session.act("start_exploration", "forest"); await flush();
  assert.equal(session.getSnapshot().uncertain, false); assert.equal(session.getSnapshot().snapshot.revision, 5);
  session.act("start_exploration", "forest"); await flush(); assert.equal(sent, 2); assert.equal(session.getSnapshot().snapshot.revision, 6);
});

test("429 writes retain command and respect Retry-After rather than resending rapidly", async () => {
  let sends = 0, gets = 0;
  const session = createEconomySession(owner, transport({ get: async () => { gets++; return state(); }, send: async () => {
    sends++; throw new ApiError("Подождите", 429, undefined, undefined, 60_000);
  } }), () => assert.fail());
  session.activate(); await session.refresh(); session.act("start_production", "grow_berries"); await flush();
  for (let i = 0; i < 10; i++) { await session.retry(); await session.refresh(); }
  assert.equal(sends, 1); assert.equal(gets, 1); assert.equal(session.getSnapshot().uncertain, true);
  assert.ok(session.getSnapshot().retryAt > now + 55_000);
});

test("late GET cannot overwrite a newer command and lower revision cannot roll back wallet", async () => {
  const stale = deferred(); let gets = 0;
  const session = createEconomySession(owner, transport({ get: async () => ++gets === 1 ? state() : stale.promise, send: async () => result(state(3)) }), () => assert.fail());
  session.activate(); await session.refresh(); const oldRead = session.refresh();
  session.act("start_production", "grow_berries"); await flush(); stale.resolve(state(1)); await oldRead;
  assert.equal(session.getSnapshot().snapshot.revision, 3);
  await session.refresh(); assert.equal(session.getSnapshot().snapshot.revision, 3);
});

test("owner changes discard in-flight responses and never replay another account's pending command", async () => {
  const wait = deferred(), cache = storage(); let lost = 0, sends = 0;
  const session = createEconomySession(owner, transport({ get: () => wait.promise }), () => lost++, cache);
  const stop = session.activate(), read = session.refresh(); stop();
  const next = createEconomySession(other, transport({ get: async () => state(0, other), send: async () => { sends++; return result(state(1, other)); } }), () => lost++, cache);
  next.activate(); await next.refresh(); wait.resolve(state(10)); await read;
  assert.equal(session.getSnapshot().snapshot, null); assert.equal(next.getSnapshot().snapshot.ownerPublicId, other);
  assert.equal(lost, 0); assert.equal(sends, 0);
});

test("unauthorized read calls sessionLost and a foreign-owner view is never published", async () => {
  let lost = 0;
  const denied = createEconomySession(owner, transport({ get: async () => { throw new ApiError("Войдите", 401); } }), () => lost++);
  denied.activate(); await denied.refresh(); assert.equal(lost, 1);
  const mismatch = createEconomySession(owner, transport({ get: async () => state(0, other) }), () => lost++);
  mismatch.activate(); await mismatch.refresh(); assert.equal(lost, 2); assert.equal(mismatch.getSnapshot().snapshot, null);
});

test("read polling is coalesced, throttled and never grants timer results locally", async () => {
  let gets = 0;
  const session = createEconomySession(owner, transport({ get: async () => { gets++; return state(); } }), () => assert.fail());
  session.activate(); await Promise.all(Array.from({ length: 50 }, () => session.refreshSoft()));
  await session.refreshSoft(); assert.equal(gets, 1); assert.deepEqual(session.getSnapshot().snapshot.inventory, {});
  assert.ok(Number.isFinite(session.now()));
});

test("market page append deduplicates lots; new refresh drops closed stale listings", async () => {
  let calls = 0;
  const first = { id: "a" }, second = { id: "b" };
  const session = createEconomySession(owner, transport({ market: async () => ({ ...market(), listings: ++calls === 1 ? [first] : calls === 2 ? [first, second] : [] }) }), () => assert.fail());
  session.activate(); await session.refreshMarket(); await session.refreshMarket("cursor");
  assert.deepEqual(session.getSnapshot().market.listings.map(lot => lot.id), ["a", "b"]);
  await session.refreshMarket(); assert.equal(session.getSnapshot().market.listings.length, 0);
});

test("a trade refreshes market even while an invalidated old page is still loading", async () => {
  const stale = deferred(); let reads = 0;
  const session = createEconomySession(owner, transport({ market: () => ++reads === 1 ? stale.promise : Promise.resolve(market()) }), () => assert.fail());
  session.activate(); await session.refresh(); const oldRead = session.refreshMarket();
  session.actMarket("buy_listing", crypto.randomUUID(), 1, 4); await flush();
  assert.equal(reads, 2); assert.deepEqual(session.getSnapshot().market.listings, []);
  stale.resolve({ ...market(), listings: [{ id: "already-sold" }] }); await oldRead;
  assert.deepEqual(session.getSnapshot().market.listings, []);
});

test("construction speedup sends the approved pearl quote once and waits for server balance", async () => {
  const wait = deferred(), sent = [];
  const initial = state(); initial.wallet.pearls = 7;
  const session = createEconomySession(owner, transport({ get: async () => initial, send: command => {
    sent.push(structuredClone(command)); return wait.promise;
  } }), () => assert.fail());
  session.activate(); await session.refresh();
  const jobId = crypto.randomUUID();
  session.act("speedup_construction", jobId, 1, 3);
  session.act("speedup_construction", jobId, 1, 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "speedup_construction");
  assert.equal(sent[0].targetId, jobId);
  assert.equal(sent[0].totalPrice, 3);
  assert.equal(session.getSnapshot().snapshot.wallet.pearls, 7);
  assert.equal(session.getSnapshot().snapshot.buildings.home, 1);
  const confirmed = state(1); confirmed.wallet.pearls = 4; confirmed.buildings.home = 2;
  wait.resolve(result(confirmed)); await flush();
  assert.equal(session.getSnapshot().snapshot.wallet.pearls, 4);
  assert.equal(session.getSnapshot().snapshot.buildings.home, 2);
});

test("uncertain pearl speedup restores the exact maximum price and request ID", async () => {
  const cache = storage(), sent = [];
  let wallet = state(); wallet.wallet.pearls = 7;
  const t = transport({ get: async () => wallet, send: async command => {
    sent.push(structuredClone(command));
    if (sent.length === 1) { wallet = state(1); wallet.wallet.pearls = 4; wallet.buildings.home = 2; throw Error("Lost response"); }
    return { ...result(wallet), replayed: true };
  } });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh(); first.act("speedup_construction", crypto.randomUUID(), 1, 3); await flush();
  assert.equal(first.getSnapshot().uncertain, true);
  first.act("speedup_construction", crypto.randomUUID(), 1, 8);
  assert.equal(sent.length, 1); stop();
  const next = createEconomySession(owner, t, () => assert.fail(), cache); next.activate(); await next.refresh();
  assert.equal(next.getSnapshot().uncertain, true);
  await next.retry();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[1].totalPrice, 3);
  assert.equal(next.getSnapshot().snapshot.wallet.pearls, 4);
  assert.equal(next.getSnapshot().uncertain, false);
  assert.equal(cache.data.size, 0);
});
