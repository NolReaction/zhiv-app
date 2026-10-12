import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", now = Date.now();
const state = (revision = 0, ownerPublicId = owner) => ({ ownerPublicId, revision, serverTime: new Date(now).toISOString(), wallet: { coins: 100, pearls: 0 }, inventory: {},
  buildings: { home: 1, garden: 1, warehouse: 1, kiln: 0 }, storage: { capacity: 200, used: 0, reserved: 0, available: 200, overflow: 0 },
  jobs: [], migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog, completedExplorations: 0 });
const result = snapshot => ({ state: snapshot, message: "DEV: готово", acceptedRevision: snapshot.revision, replayed: false });
const transport = overrides => ({ get: async () => state(), send: async () => result(state(1)),
  market: async () => ({ listings: [], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() }), trade: async () => result(state(1)), ...overrides });
const flush = () => new Promise(resolve => setImmediate(resolve));
const receiptKey = id => `zhiv:economy:pending:v1:${id}`;
const receipt = (overrides = {}) => ({ kind: "dev", command: { requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0,
  action: "grant_currency", targetId: "coins", quantity: 1000, totalPrice: 0, ...overrides } });
function storage() { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data }; }

test("lost DEV grant response preserves the exact receipt across reload and never grants twice", async () => {
  const cache = storage(), sent = [], accepted = new Set(); let wallet = state(), grants = 0, ordinary = 0;
  const t = transport({ get: async () => wallet, send: async () => { ordinary++; return result(wallet); }, trade: async () => { ordinary++; return result(wallet); }, dev: async command => {
    sent.push(structuredClone(command));
    if (!accepted.has(command.requestId)) {
      accepted.add(command.requestId); grants++; wallet = state(1); wallet.wallet.coins += command.quantity;
      throw Error("Response lost after commit");
    }
    return { ...result(wallet), replayed: true };
  } });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh(); first.actDev("grant_currency", "coins", 1000); await flush();
  assert.equal(first.getSnapshot().uncertain, true); assert.equal(first.getSnapshot().snapshot.wallet.coins, 100);
  first.act("start_exploration", "forest"); first.actMarket("create_listing", "wood", 1, 4); first.actDev("grant_item", "wood", 10);
  assert.equal(ordinary, 0); assert.equal(sent.length, 1); assert.equal(cache.data.size, 1);
  stop();
  const next = createEconomySession(owner, t, () => assert.fail(), cache); next.activate(); await next.refresh();
  assert.equal(next.getSnapshot().snapshot.revision, 1); assert.equal(next.getSnapshot().uncertain, true);
  await next.retry();
  assert.deepEqual(sent[1], sent[0]); assert.equal(sent[1].expectedRevision, 0);
  assert.equal(grants, 1); assert.equal(next.getSnapshot().snapshot.wallet.coins, 1100);
  assert.equal(next.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
});

test("DEV commands use the same in-flight write lock and wait for confirmed server state", async () => {
  let complete, calls = 0, ordinary = 0;
  const delayed = new Promise(resolve => { complete = resolve; });
  const session = createEconomySession(owner, transport({ dev: async () => { calls++; return delayed; },
    send: async () => { ordinary++; return result(state(1)); } }), () => assert.fail());
  session.activate(); await session.refresh(); session.actDev("finish_jobs", "all");
  assert.equal(session.getSnapshot().busy, true); assert.equal(session.getSnapshot().snapshot.revision, 0);
  session.act("start_exploration", "forest"); session.actDev("grant_currency", "coins", 10); await session.retry();
  assert.equal(calls, 1); assert.equal(ordinary, 0);
  complete(result(state(1))); await flush();
  assert.equal(session.getSnapshot().busy, false); assert.equal(session.getSnapshot().snapshot.revision, 1);
  session.act("start_exploration", "forest"); await flush(); assert.equal(ordinary, 1);
});

test("without DEV capability stale DEV receipts are removed and ordinary play remains available", async () => {
  const cache = storage(), pending = receipt(); let sends = 0;
  cache.setItem(receiptKey(owner), JSON.stringify(pending));
  const session = createEconomySession(owner, transport({ send: async command => { sends++; assert.notEqual(command.requestId, pending.command.requestId); return result(state(1)); } }), () => assert.fail(), cache);
  session.activate(); await session.refresh();
  assert.equal(session.devAvailable, false); assert.equal(session.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
  session.actDev("grant_currency", "coins", 1000); await session.retry(); assert.equal(sends, 0);
  session.act("start_exploration", "forest"); await flush(); assert.equal(sends, 1);
});

test("DEV receipts remain account-scoped and cannot be restored under a different owner", async () => {
  const cache = storage(), pending = receipt(); let sent = 0;
  cache.setItem(receiptKey(owner), JSON.stringify(pending));
  const t = transport({ get: async () => state(0, other), dev: async () => { sent++; return result(state(1, other)); } });
  const clean = createEconomySession(other, t, () => assert.fail(), cache); clean.activate(); await clean.refresh(); await clean.retry();
  assert.equal(clean.getSnapshot().uncertain, false); assert.equal(sent, 0); assert.ok(cache.getItem(receiptKey(owner)));
  cache.setItem(receiptKey(other), JSON.stringify(pending));
  const copied = createEconomySession(other, t, () => assert.fail(), cache); copied.activate(); await copied.refresh(); await copied.retry();
  assert.equal(copied.getSnapshot().uncertain, false); assert.equal(sent, 0); assert.equal(cache.getItem(receiptKey(other)), null);
});

test("definitive DEV rejection clears the receipt and refreshes revision before the next action", async () => {
  const cache = storage(), sent = []; let current = state();
  const session = createEconomySession(owner, transport({ get: async () => current, dev: async command => {
    sent.push(command);
    if (sent.length === 1) { current = state(4); throw new ApiError("Обновите хозяйство", 409); }
    return result(state(5));
  } }), () => assert.fail(), cache);
  session.activate(); await session.refresh(); session.actDev("grant_upgrade_cost", "home"); await flush();
  assert.equal(session.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0); assert.equal(session.getSnapshot().snapshot.revision, 4);
  session.actDev("grant_upgrade_cost", "home"); await flush();
  assert.notEqual(sent[1].requestId, sent[0].requestId); assert.equal(sent[1].expectedRevision, 4); assert.equal(session.getSnapshot().snapshot.revision, 5);
});

test("throttled DEV writes retain one receipt and obey the shared retry deadline", async () => {
  const cache = storage(); let sent = 0;
  const session = createEconomySession(owner, transport({ dev: async () => { sent++; throw new ApiError("Подождите", 429, undefined, undefined, 60_000); } }), () => assert.fail(), cache);
  session.activate(); await session.refresh(); session.actDev("grant_item", "wood", 20); await flush();
  for (let i = 0; i < 5; i++) { await session.retry(); session.actDev("finish_jobs", "all"); }
  assert.equal(sent, 1); assert.equal(session.getSnapshot().uncertain, true); assert.ok(session.getSnapshot().retryAt > now + 55_000);
  assert.equal(JSON.parse(cache.getItem(receiptKey(owner))).command.quantity, 20);
});

test("DEV validates quantities before storing a receipt and permits resetting an optional building to zero", async () => {
  const cache = storage(), sent = [];
  const session = createEconomySession(owner, transport({ dev: async command => { sent.push(command); return result(state(1)); } }), () => assert.fail(), cache);
  session.activate(); await session.refresh();
  session.actDev("grant_currency", "coins", NaN); session.actDev("grant_item", "wood", -1); session.actDev("grant_currency", "unknown", 100);
  assert.equal(sent.length, 0); assert.equal(cache.data.size, 0);
  session.actDev("set_building_level", "kiln", 0); await flush();
  assert.equal(sent.length, 1); assert.equal(sent[0].quantity, 0); assert.equal(session.getSnapshot().uncertain, false);
});
