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

const sale = (id = lot) => ({ id, sellerPublicId: owner, sellerName: "Продавец", itemId: "wood", quantity: 1, totalPrice: 40,
  status: "sold", owned: true, feeBps: 500, createdAt: new Date(now - 1000).toISOString(), closedAt: new Date(now).toISOString(),
  sale: { buyerPublicId: other, buyerName: "Natasha", buyerAvatarUrl: null, proceedsCoins: 38, claimedAt: null } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("a newly sold lot refreshes its seller revision before the first collection command", async () => {
  let current = state(), shelf = market(), profileReads = 0; const commands = [], observedRevisions = [];
  const session = createEconomySession(owner, transport({ get: async () => { profileReads++; return current; },
    market: async () => shelf, trade: async command => {
      commands.push(command);
      if (command.expectedRevision !== current.revision) throw new ApiError("Состояние изменилось", 409, { code: "ECONOMY_REVISION" });
      current = state(current.revision + 1, current.wallet.coins + 38); shelf = market(); return result(current);
    },
  }), () => assert.fail());
  const stop = session.activate(); await session.refresh(); await session.refreshMarket();
  assert.equal(profileReads, 1, "an ordinary market read does not request another profile");
  current = state(1); shelf = { ...market(), mine: [sale()] };
  const unsubscribe = session.subscribe(() => { if (session.getSnapshot().market?.mine.length) observedRevisions.push(session.getSnapshot().snapshot.revision); });
  await session.refreshMarket();
  assert.equal(profileReads, 2);
  assert.deepEqual(observedRevisions, [1], "the collection button never observes the pre-purchase seller revision");
  assert.equal(session.getSnapshot().snapshot.wallet.coins, 100, "reading the receipt does not credit its coins");
  assert.equal(session.actMarket("claim_sale", lot), true); await flush(); await flush();
  assert.equal(commands.length, 1); assert.equal(commands[0].expectedRevision, 1);
  assert.equal(session.getSnapshot().error, null); assert.equal(session.getSnapshot().snapshot.wallet.coins, 138);
  unsubscribe(); stop();
});

test("a new pending receipt stays hidden while its authoritative profile read is in flight", async () => {
  const profile = deferred(); let reads = 0;
  const session = createEconomySession(owner, transport({ get: async () => ++reads === 1 ? state() : profile.promise,
    market: async () => ({ ...market(), mine: [sale()] }),
  }), () => assert.fail());
  const stop = session.activate(); await session.refresh(); const loading = session.refreshMarket(); await flush();
  assert.equal(reads, 2); assert.equal(session.getSnapshot().market, null);
  assert.equal(session.getSnapshot().snapshot.revision, 0);
  profile.resolve(state(7, 111)); await loading;
  assert.equal(session.getSnapshot().market.mine[0].id, lot);
  assert.equal(session.getSnapshot().snapshot.revision, 7); assert.equal(session.getSnapshot().snapshot.wallet.coins, 111);
  assert.deepEqual(session.getSnapshot().inventoryGains, [], "polling creates no synthetic collection rewards");
  stop();
});

test("known pending receipts do not cause extra profile reads until a different sale arrives", async () => {
  let reads = 0, shelf = { ...market(), mine: [sale()] };
  const session = createEconomySession(owner, transport({ get: async () => { reads++; return state(reads); }, market: async () => shelf }), () => assert.fail());
  const stop = session.activate(); await session.refresh(); await session.refreshMarket();
  assert.equal(reads, 2);
  await session.refreshMarket(); assert.equal(reads, 2);
  shelf = { ...market(), mine: [sale(), sale(crypto.randomUUID())] };
  await session.refreshMarket(); assert.equal(reads, 3); assert.equal(session.getSnapshot().market.mine.length, 2);
  stop();
});

test("a failed seller profile confirmation keeps the new collection button unavailable", async () => {
  let reads = 0;
  const session = createEconomySession(owner, transport({ get: async () => { if (++reads === 1) return state(); throw new ApiError("Сервер временно недоступен", 503); },
    market: async () => ({ ...market(), mine: [sale()] }),
  }), () => assert.fail());
  const stop = session.activate(); await session.refresh(); await session.refreshMarket();
  assert.equal(session.getSnapshot().market, null); assert.equal(session.getSnapshot().snapshot.revision, 0);
  assert.equal(session.getSnapshot().marketError, "Сервер временно недоступен");
  assert.equal(session.getSnapshot().marketSyncError, "Сервер временно недоступен");
  assert.equal(session.getSnapshot().uncertain, false, "a failed read never manufactures a pending write receipt");
  stop();
});

test("foreign market or profile owners never expose a pending receipt or replace the current snapshot", async () => {
  for (const mismatch of ["market", "profile", "session"]) {
    let reads = 0, lost = 0;
    const session = createEconomySession(owner, transport({ get: async () => {
      if (++reads === 1) return state();
      if (mismatch === "session") throw new ApiError("Сессия закончилась", 401);
      return state(2, 999, other);
    }, market: async () => ({ ...market(), ownerPublicId: mismatch === "market" ? other : owner, mine: [sale()] }) }), () => { lost++; });
    const stop = session.activate(); await session.refresh(); await session.refreshMarket();
    assert.equal(lost, 1); assert.equal(session.getSnapshot().market, null);
    assert.equal(session.getSnapshot().snapshot.ownerPublicId, owner); assert.equal(session.getSnapshot().snapshot.wallet.coins, 100);
    assert.equal(reads, mismatch === "market" ? 1 : 2); stop();
  }
});

test("offline suspension and deactivation discard a delayed sale profile confirmation", async () => {
  for (const suspend of [session => session.setAvailable(false), (_session, stop) => stop()]) {
    const profile = deferred(); let reads = 0, signal;
    const session = createEconomySession(owner, transport({ get: async currentSignal => { if (++reads === 1) return state(); signal = currentSignal; return profile.promise; },
      market: async () => ({ ...market(), mine: [sale()] }),
    }), () => assert.fail());
    const stop = session.activate(); await session.refresh(); const loading = session.refreshMarket(); await flush();
    suspend(session, stop); assert.equal(signal.aborted, true);
    profile.resolve(state(9, 900)); await loading;
    assert.equal(session.getSnapshot().market, null); assert.equal(session.getSnapshot().snapshot.revision, 0);
    assert.equal(session.getSnapshot().snapshot.wallet.coins, 100); stop();
  }
});

test("a command supersedes a delayed sale profile confirmation and its old market response", async () => {
  const profile = deferred(); let reads = 0, shelf = { ...market(), mine: [sale()] };
  const session = createEconomySession(owner, transport({ get: async () => ++reads === 1 ? state() : profile.promise,
    market: async () => shelf, send: async () => { shelf = market(); return result(state(3, 222)); },
  }), () => assert.fail());
  const stop = session.activate(); await session.refresh(); const loading = session.refreshMarket(); await flush();
  assert.equal(session.act("start_exploration", "forest"), true); await flush();
  profile.resolve(state(2, 111)); await loading;
  assert.equal(session.getSnapshot().snapshot.revision, 3); assert.equal(session.getSnapshot().snapshot.wallet.coins, 222);
  assert.equal(session.getSnapshot().market, null, "the invalidated pre-command shelf is not republished");
  stop();
});

test("a concurrent newer profile cannot be rolled back by the market's sale confirmation read", async () => {
  const profile = deferred(); let reads = 0;
  const session = createEconomySession(owner, transport({ get: async () => { reads++; return reads === 1 ? state() : reads === 2 ? profile.promise : state(9, 900); },
    market: async () => ({ ...market(), mine: [sale()] }),
  }), () => assert.fail());
  const stop = session.activate(); await session.refresh(); const loading = session.refreshMarket(); await flush();
  await session.refresh(); assert.equal(session.getSnapshot().snapshot.revision, 9);
  profile.resolve(state(7, 700)); await loading;
  assert.equal(session.getSnapshot().snapshot.revision, 9); assert.equal(session.getSnapshot().snapshot.wallet.coins, 900);
  assert.equal(session.getSnapshot().market.mine[0].id, lot); stop();
});
