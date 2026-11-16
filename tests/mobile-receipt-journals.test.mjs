import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldSession } = await vite.ssrLoadModule("/features/world/state/session.ts");
const { createGameRewardsSession } = await vite.ssrLoadModule("/features/game/game-rewards-session.ts");
const { createCheckInJournal } = await vite.ssrLoadModule("/features/check-in/check-in-journal.ts");
const { newWorldState } = await vite.ssrLoadModule("/features/world/domain/model.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002";
const at = "2026-11-14T12:00:00.000Z";
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const cache = () => {
  const rows = new Map();
  return { rows, getItem: key => rows.get(key) ?? null, getKeys: () => [...rows.keys()],
    setItem: (key, value) => { rows.set(key, value); }, removeItem: key => { rows.delete(key); } };
};
const durable = () => {
  const storage = cache();
  return { ...storage, setItem: async (key, value) => { storage.setItem(key, value); }, removeItem: async key => { storage.removeItem(key); } };
};
const worldSnapshot = (revision = 0) => ({ ownerPublicId: owner, revision, serverTime: at, state: newWorldState(), gifts: [], dailySparksEarned: 0, catalogVersion: 1 });
const reward = { coins: 10, pearls: 0, items: {} };
const rewardsSnapshot = (claimable = true) => ({ ownerPublicId: owner, serverTime: at, catalogVersion: 9,
  daily: { step: 1, completed: false, claimable, nextClaimAt: at, lastClaimAt: null, lastClaimDate: null, reward, cycle: [{ step: 1, reward }] }, achievementRewards: [] });
const adapters = [
  { name: "world", key: `zhiv:world:pending:v1:${owner}`,
    create: (port, wire, legacy) => createWorldSession(owner, wire, () => assert.fail("unexpected account loss"), legacy, port),
    snapshot: () => worldSnapshot(),
    reply: () => ({ snapshot: worldSnapshot(1), message: "Готово" }),
    act: session => session.act("equip", "amber_scarf"),
    body: () => ({ requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0, action: "equip", target: "amber_scarf" }),
    confirmed: session => Boolean(session.getSnapshot().notice),
  },
  { name: "rewards", key: `zhiv:game-rewards:pending:v1:${owner}`,
    create: (port, wire, legacy) => createGameRewardsSession(owner, wire, legacy, port),
    snapshot: () => rewardsSnapshot(),
    reply: command => ({ requestId: command.requestId, rewards: rewardsSnapshot(false), economy: { ownerPublicId: owner, revision: 1 },
      acceptedRevision: 1, replayed: false, claim: { kind: "daily", step: 1, reward, claimedAt: at }, message: "Награда получена" }),
    act: session => session.claimDaily(),
    body: () => ({ requestId: crypto.randomUUID(), ownerPublicId: owner, kind: "daily" }),
    confirmed: session => Boolean(session.getSnapshot().result),
  },
];

for (const adapter of adapters) {
  const setup = async (port, send, legacy, get) => {
    const session = adapter.create(port, { get: get ?? (async () => adapter.snapshot()), send }, legacy);
    const stop = session.activate(); await session.refresh();
    return { session, stop };
  };
  test(`${adapter.name}: network and confirmation wait for native commit`, async () => {
    const port = durable(), commit = deferred(), calls = [];
    port.setItem = async (key, raw) => { await commit.promise; port.rows.set(key, raw); };
    const { session, stop } = await setup(port, async body => { calls.push(body); return adapter.reply(body); });
    adapter.act(session); await tick();
    assert.equal(calls.length, 0); assert.equal(adapter.confirmed(session), false);
    assert.equal(session.getSnapshot().busy, true);
    commit.resolve(); await tick();
    assert.equal(calls.length, 1); assert.equal(adapter.confirmed(session), true); assert.equal(port.rows.size, 0);
    stop();
  });
  test(`${adapter.name}: failed commit never falls back to a network-only action`, async () => {
    const port = durable(); let sent = 0;
    port.setItem = async () => { throw Error("SQLite commit unknown"); };
    const { session, stop } = await setup(port, async body => { sent++; return adapter.reply(body); });
    adapter.act(session); await tick(); await session.retry(); adapter.act(session); await tick();
    assert.equal(sent, 0); assert.match(session.getSnapshot().error, /не отправлен|не отправлен|Запрос не отправлен/i);
    assert.equal(session.getSnapshot().busy, false); stop();
  });
  test(`${adapter.name}: a closed session cannot send after delayed commit; next session recovers exact receipt`, async () => {
    const port = durable(), commit = deferred(), calls = [];
    port.setItem = async (key, raw) => { await commit.promise; port.rows.set(key, raw); };
    const send = async body => { calls.push(structuredClone(body)); return adapter.reply(body); };
    const first = await setup(port, send); adapter.act(first.session); await tick(); first.stop();
    commit.resolve(); await tick(); assert.equal(calls.length, 0);
    const persisted = JSON.parse(port.getItem(adapter.key));
    const next = await setup(port, send); await next.session.retry();
    assert.deepEqual(calls, [persisted]); assert.equal(port.rows.size, 0); next.stop();
  });
  test(`${adapter.name}: server response loss retries identical idempotency key across relaunch`, async () => {
    const port = durable(), calls = [];
    const send = async body => { calls.push(structuredClone(body)); if (calls.length === 1) throw Error("response lost after server commit"); return adapter.reply(body); };
    const first = await setup(port, send); adapter.act(first.session); await tick(); first.stop();
    assert.equal(port.rows.size, 1);
    const next = await setup(port, send); adapter.act(next.session); await tick(); assert.equal(calls.length, 1);
    await next.session.retry(); assert.deepEqual(calls, [calls[0], calls[0]]); assert.equal(port.rows.size, 0); next.stop();
  });
  test(`${adapter.name}: failed cleanup preserves exact receipt and blocks a new command`, async () => {
    const port = durable(), calls = [];
    port.removeItem = async () => { throw Error("delete ACK lost"); };
    const { session, stop } = await setup(port, async body => { calls.push(body); return adapter.reply(body); });
    adapter.act(session); await tick(); await session.retry(); adapter.act(session); await tick();
    assert.equal(calls.length, 1); assert.equal(port.rows.size, 1); assert.match(session.getSnapshot().error, /Перезапустите/); stop();
  });
  test(`${adapter.name}: malformed native receipt remains blocked even after failed refresh`, async () => {
    const port = durable(); port.rows.set(adapter.key, "{"); let sent = 0;
    const { session, stop } = await setup(port, async body => { sent++; return adapter.reply(body); }, undefined, async () => { throw Error("offline"); });
    await session.retry(); adapter.act(session); await tick();
    assert.equal(sent, 0); assert.match(session.getSnapshot().error, /Перезапустите/); assert.equal(port.getItem(adapter.key), "{"); stop();
  });
  test(`${adapter.name}: migration keeps legacy receipt until native commit and recovers through blocked legacy cache`, async () => {
    const port = durable(), legacy = cache(), commit = deferred(), calls = [];
    const body = adapter.body(), raw = JSON.stringify(body); legacy.setItem(adapter.key, raw);
    port.setItem = async (key, value) => { await commit.promise; port.rows.set(key, value); };
    const { session, stop } = await setup(port, async value => { calls.push(value); throw Error("offline"); }, legacy);
    const task = session.retry(); await tick(); assert.equal(legacy.getItem(adapter.key), raw); assert.equal(calls.length, 0);
    commit.resolve(); await task; assert.equal(legacy.getItem(adapter.key), null); assert.equal(port.getItem(adapter.key), raw); stop();
    const blocked = { getItem() { throw Error("WebView disabled"); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
    const next = await setup(port, async value => { calls.push(value); return adapter.reply(value); }, blocked);
    await next.session.retry(); assert.equal(calls.length, 2); assert.deepEqual(calls[1], body); next.stop();
  });
  test(`${adapter.name}: reactivation while a commit is pending cannot overlap writes or accept stale confirmation`, async () => {
    const port = durable(), commit = deferred(); let writes = 0, sends = 0;
    port.setItem = async (key, raw) => { writes++; await commit.promise; port.rows.set(key, raw); };
    const { session, stop } = await setup(port, async body => { sends++; return adapter.reply(body); });
    adapter.act(session); await tick(); stop(); const stopAgain = session.activate();
    await session.retry(); assert.equal(writes, 1); commit.resolve(); await tick();
    assert.equal(sends, 0); assert.equal(adapter.confirmed(session), false);
    await session.retry(); assert.equal(sends, 1); stopAgain();
  });
  test(`${adapter.name}: cleanup ACK after reactivation unlocks recovery without a stale success announcement`, async () => {
    const port = durable(), remove = deferred();
    port.removeItem = async key => { await remove.promise; port.rows.delete(key); };
    const { session, stop } = await setup(port, async body => adapter.reply(body));
    adapter.act(session); await tick(); assert.equal(port.rows.size, 1);
    stop(); const stopAgain = session.activate(); assert.equal(session.getSnapshot().uncertain, true);
    remove.resolve(); await tick(); await session.refresh();
    assert.equal(port.rows.size, 0); assert.equal(session.getSnapshot().uncertain, false);
    assert.equal(adapter.confirmed(session), false); stopAgain();
  });
}

const checkIn = () => ({ version: 2, kind: "check-in", idempotencyKey: crypto.randomUUID(), ownerPublicId: owner,
  previousLastCheckInAt: null, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000 });
const checkInKey = `zhiv:check-in:pending:v1:${owner}`;
test("check-in migration and cleanup serialize behind real native acknowledgement", async () => {
  const port = durable(), legacy = cache(), commit = deferred(), body = checkIn(), raw = JSON.stringify(body);
  legacy.setItem("zhiv.pending-check-in.v2", raw);
  port.setItem = async (key, value) => { await commit.promise; port.rows.set(key, value); };
  const journal = createCheckInJournal(owner, port, legacy);
  assert.deepEqual(journal.read(), body);
  const saved = journal.save(body); const cleared = journal.clear(); await tick();
  assert.equal(legacy.getItem("zhiv.pending-check-in.v2"), raw); assert.equal(port.rows.size, 0);
  commit.resolve(); await saved; await cleared; await journal.settled();
  assert.equal(port.rows.size, 0); assert.equal(legacy.rows.size, 0);
});
test("check-in unknown commit freezes all later sends until fresh journal rehydrates exact key", async () => {
  const port = durable(), body = checkIn(); let writes = 0;
  port.setItem = async (key, raw) => { writes++; port.rows.set(key, raw); throw Error("ACK lost"); };
  const journal = createCheckInJournal(owner, port);
  await assert.rejects(journal.save(body)); await assert.rejects(journal.settled()); await assert.rejects(journal.clear());
  await assert.rejects(journal.save(checkIn())); assert.equal(writes, 1);
  assert.deepEqual(createCheckInJournal(owner, port).read(), body);
});
test("check-in cannot import or clear another account's shared legacy receipt", async () => {
  const port = durable(), legacy = cache(), body = { ...checkIn(), ownerPublicId: other };
  legacy.setItem("zhiv.pending-check-in.v2", JSON.stringify(body));
  const journal = createCheckInJournal(owner, port, legacy);
  assert.equal(journal.read(), null); await journal.clear(); assert.equal(legacy.rows.size, 1);
  assert.throws(() => journal.save(body), /owner mismatch/);
});
test("check-in invalid native data fails closed; optional broken WebView data does not", async () => {
  const port = durable(); port.rows.set(checkInKey, "{}");
  const journal = createCheckInJournal(owner, port); assert.throws(() => journal.read()); await assert.rejects(journal.settled());
  port.rows.clear();
  const blocked = { getItem() { throw Error("WebView unavailable"); }, removeItem() { throw Error(); } };
  const next = createCheckInJournal(owner, port, blocked); assert.equal(next.read(), null);
  await next.save(checkIn()); assert.equal(port.rows.size, 1);
});
test("check-in expiry cleanup cannot erase a newer receipt queued immediately afterwards", async () => {
  const port = durable(), remove = deferred(), expired = { ...checkIn(), createdAt: 1, expiresAt: 2 };
  port.rows.set(checkInKey, JSON.stringify(expired)); port.removeItem = async key => { await remove.promise; port.rows.delete(key); };
  const journal = createCheckInJournal(owner, port); assert.equal(journal.read(), null);
  const body = checkIn(), saved = journal.save(body); await tick(); remove.resolve(); await saved;
  assert.deepEqual(JSON.parse(port.getItem(checkInKey)), body);
});
