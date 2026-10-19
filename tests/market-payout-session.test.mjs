import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", lot = crypto.randomUUID(), now = Date.now();
const state = (revision = 0, coins = 100, ownerPublicId = owner) => ({ ownerPublicId, revision, serverTime: new Date(now).toISOString(),
  wallet: { coins, pearls: 0 }, inventory: {}, buildings: { home: 1, warehouse: 1 }, jobs: [], completedExplorations: 0,
  storage: { capacity: 50, used: 0, reserved: 0, available: 50, overflow: 0 },
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog });
const result = (snapshot, replayed = false) => ({ state: snapshot, message: "Выручка получена", acceptedRevision: snapshot.revision, replayed });
const market = () => ({ ownerPublicId: owner, listings: [], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() });
const flush = () => new Promise(resolve => setImmediate(resolve));
function storage() { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k), data }; }
function transport(overrides) { return { get: async () => state(), market: async () => market(), send: async () => assert.fail("claim must use market transport"), trade: async () => result(state(1, 138)), ...overrides }; }

test("claiming sale proceeds keeps the same receipt across reload and grants once without inventory rewards", async () => {
  const cache = storage(), seen = new Set(), calls = []; let current = state(), credited = 0;
  const t = transport({ get: async () => current, trade: async command => {
    calls.push(structuredClone(command));
    if (!seen.has(command.requestId)) { seen.add(command.requestId); credited++; current = state(1, 138); throw Error("ACK lost after payout"); }
    return result(current, true);
  } });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate(); await first.refresh();
  first.actMarket("claim_sale", lot); await flush();
  assert.equal(first.getSnapshot().uncertain, true); assert.equal(first.getSnapshot().snapshot.wallet.coins, 100);
  first.actMarket("claim_sale", lot); assert.equal(calls.length, 1); stop();
  const next = createEconomySession(owner, t, () => assert.fail(), cache); next.activate(); await next.refresh();
  assert.equal(next.getSnapshot().uncertain, true); assert.equal(next.getSnapshot().snapshot.wallet.coins, 138);
  await next.retry();
  assert.deepEqual(calls[1], calls[0]); assert.equal(calls[0].action, "claim_sale");
  assert.equal(calls[0].quantity, 1); assert.equal(calls[0].totalPrice, 0); assert.equal(credited, 1);
  assert.equal(next.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
  assert.deepEqual(next.getSnapshot().inventoryGains, []);
});

test("sale collection is a market action even after home reset and shares the normal write lock", async () => {
  let complete, reads = 0; const commands = [];
  const session = createEconomySession(owner, transport({ market: async () => { reads++; return market(); },
    trade: command => { commands.push(command); return new Promise(resolve => { complete = () => resolve(result(state(1, 138))); }); },
  }), () => assert.fail());
  session.activate(); await session.refresh();
  assert.equal(session.getSnapshot().snapshot.buildings.home, 1);
  session.actMarket("claim_sale", lot); session.actMarket("claim_sale", lot); session.act("start_exploration", "forest");
  assert.equal(commands.length, 1); assert.equal(session.getSnapshot().busy, true);
  complete(); await flush(); await flush();
  assert.equal(session.getSnapshot().snapshot.wallet.coins, 138); assert.equal(session.getSnapshot().busy, false);
  assert.ok(reads >= 1, "receipt completion reloads the seller's occupied places");
});

test("a definitive rejected sale claim clears only that receipt and never changes the wallet", async () => {
  const cache = storage(); let commands = 0;
  const session = createEconomySession(owner, transport({ trade: async () => { commands++; throw new ApiError("Это не ваша продажа", 404); } }), () => assert.fail(), cache);
  session.activate(); await session.refresh(); session.actMarket("claim_sale", lot); await flush(); await flush();
  assert.equal(session.getSnapshot().snapshot.wallet.coins, 100); assert.equal(session.getSnapshot().uncertain, false);
  assert.equal(cache.data.size, 0); assert.equal(commands, 1);
});

test("a recovered payout request cannot run as another player", async () => {
  const cache = storage(), key = `zhiv:economy:pending:v1:${other}`; let calls = 0;
  cache.setItem(key, JSON.stringify({ kind: "market", command: { ownerPublicId: owner, requestId: crypto.randomUUID(), expectedRevision: 0,
    action: "claim_sale", targetId: lot, quantity: 1, totalPrice: 0 } }));
  const session = createEconomySession(other, transport({ get: async () => state(0, 100, other), trade: async () => { calls++; return result(state(1, 138, other)); } }), () => assert.fail(), cache);
  session.activate(); await session.refresh(); await session.retry();
  assert.equal(calls, 0); assert.equal(cache.getItem(key), null); assert.equal(session.getSnapshot().snapshot.wallet.coins, 100);
});
