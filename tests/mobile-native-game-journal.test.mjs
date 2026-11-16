import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createNativeGameSync } = await vite.ssrLoadModule("/features/game/native-game-sync.ts");
const owner = "7K3P-2Q9M-W8ZR", other = "7K3P-2Q9M-W8ZX";
const run = "4a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const key = `zhiv:game-outbox:v1:${owner}`;
const epoch = Date.parse("2026-11-14T10:00:00Z");
const settle = () => new Promise(resolve => setImmediate(resolve));
function browserStore() {
  const rows = new Map();
  return { rows, get length() { return rows.size; }, key: i => [...rows.keys()][i] ?? null,
    getItem: k => rows.get(k) ?? null, setItem: (k, v) => { rows.set(k, v); }, removeItem: k => { rows.delete(k); } };
}
function fixture() {
  const values = new Map(), calls = [], snapshots = [], receipts = new Map(), sessions = new Map();
  let clock = epoch, total = 0, blocked = false, invalidated = false, lost = false, sessionLost = 0;
  let rejectWrite = () => false;
  const waiting = [];
  const storage = {
    getItem: k => { if (invalidated) throw new Error("Owner changed"); return values.get(k) ?? null; },
    getKeys: () => [...values.keys()],
    async setItem(k, raw) {
      const saved = JSON.parse(raw);
      if (blocked) await new Promise(resolve => waiting.push(resolve));
      if (invalidated || rejectWrite(saved)) throw new Error("SQLite transaction failed");
      values.set(k, raw);
    },
    async removeItem(k) { if (invalidated) throw new Error("Owner changed"); values.delete(k); },
  };
  const progress = () => ({ ownerPublicId: owner, items: [], lifetimeTaps: total, bestSeries: total,
    month: "2026-11", monthlyTaps: total, leaderboardOptIn: false, visibilityVersion: 0, serverTime: new Date(clock).toISOString() });
  const api = {
    progress: async () => progress(),
    session: async body => {
      assert.deepEqual(JSON.parse(values.get(key)).startRequest, body, "session request must be committed before sending");
      calls.push({ kind: "session", body: structuredClone(body) });
      if (!sessions.has(body.requestId)) sessions.set(body.requestId, { sessionId: crypto.randomUUID(), nextSequence: 1,
        startedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 900000).toISOString(), progress: progress() });
      return structuredClone(sessions.get(body.requestId));
    },
    batch: async body => {
      assert.deepEqual(JSON.parse(values.get(key)).pendingBatch, body, "exact session/sequence/body must be committed before dispatch");
      calls.push({ kind: "batch", body: structuredClone(body) });
      const receiptKey = `${body.sessionId}:${body.sequence}`;
      if (receipts.has(receiptKey)) return { ...structuredClone(receipts.get(receiptKey)), replayed: true, progress: progress() };
      total += body.tapCount;
      const result = { sessionId: body.sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, rejectedTaps: 0,
        runTaps: total, replayed: false, progress: progress() };
      receipts.set(receiptKey, structuredClone(result));
      if (lost) { lost = false; throw new Error("Response lost after commit"); }
      return result;
    },
  };
  const open = (online = false, legacy, overrides = {}) => createNativeGameSync(owner, storage, {
    online, legacy, changed: s => snapshots.push(s), sessionLost: () => { sessionLost += 1; }, api,
    now: () => clock, wallNow: () => clock, uuid: () => crypto.randomUUID(), wait: async ms => { clock += ms; }, ...overrides,
  });
  return { values, calls, snapshots, storage, api, open,
    get total() { return total; }, get clock() { return clock; }, get sessionLost() { return sessionLost; },
    block: () => { blocked = true; }, release: () => { blocked = false; for (const resolve of waiting.splice(0)) resolve(); },
    fail: predicate => { rejectWrite = predicate; }, invalidate: () => { invalidated = true; },
    loseResponse: () => { lost = true; }, advance: ms => { clock += ms; },
  };
}

test("native input is not acknowledged, rendered or sent before SQLite commits", async () => {
  const f = fixture(), client = await f.open(true);
  f.block();
  let resolved = false;
  const input = client.recordTap(1, run, f.clock).then(value => { resolved = true; return value; });
  await settle();
  assert.equal(resolved, false);
  assert.equal(client.snapshot().pendingTaps, 0);
  assert.equal(f.snapshots.some(s => s.pendingTaps > 0), false);
  assert.equal(f.calls.length, 0);
  f.release();
  assert.equal(await input, 1);
  await client.flush();
  assert.equal(f.total, 1);
  assert.equal(client.snapshot().progress.lifetimeTaps, 1);
  await client.dispose();
});

test("failed native commit rejects input and freezes dispatch while preserving the committed journal", async () => {
  const f = fixture(), client = await f.open(false);
  assert.equal(await client.recordTap(2, run, f.clock), 2);
  const committed = f.values.get(key);
  f.fail(() => true);
  assert.equal(await client.recordTap(1, run, f.clock), 0);
  assert.equal(f.values.get(key), committed);
  assert.equal(client.snapshot().pendingTaps, 2);
  assert.equal(client.snapshot().durable, false);
  assert.equal(client.snapshot().errorCode, "STORAGE_FAILED");
  client.setOnline(true); await client.flush();
  assert.equal(f.calls.length, 0);
  assert.equal(await client.recordTap(1, run, f.clock), 0);
  await client.dispose();
  f.fail(() => false);
  const next = await f.open(true);
  await next.flush();
  assert.equal(f.total, 2, "only acknowledged durable input survives the reopen");
  await next.dispose();
});

test("restart after a lost network response reuses the exact native batch without duplicating taps", async () => {
  const f = fixture(), first = await f.open(true);
  f.loseResponse();
  assert.equal(await first.recordTap(3, run, f.clock), 3);
  await first.flush();
  assert.equal(f.total, 3);
  assert.ok(JSON.parse(f.values.get(key)).pendingBatch);
  const original = f.calls.find(c => c.kind === "batch").body;
  await first.dispose(); f.advance(60_000);
  const second = await f.open(true);
  await second.flush();
  assert.deepEqual(f.calls.filter(c => c.kind === "batch")[1].body, original);
  assert.equal(f.total, 3);
  assert.equal(second.snapshot().pendingTaps, 0);
  assert.equal(second.snapshot().run.creditedTaps, 3);
  await second.dispose();
});

test("server success followed by a failed SQLite acknowledgement retains the replayable batch", async () => {
  const f = fixture(), first = await f.open(true);
  f.fail(saved => saved.progress?.lifetimeTaps > 0 && saved.pendingBatch === null);
  assert.equal(await first.recordTap(1, run, f.clock), 1);
  await first.flush();
  assert.equal(f.total, 1);
  assert.equal(first.snapshot().durable, false);
  const pending = JSON.parse(f.values.get(key)).pendingBatch;
  assert.ok(pending);
  await first.dispose(); f.fail(() => false); f.advance(60_000);
  const next = await f.open(true); await next.flush();
  assert.equal(f.total, 1);
  assert.deepEqual(f.calls.filter(c => c.kind === "batch")[1].body, pending);
  assert.equal(next.snapshot().pendingTaps, 0);
  await next.dispose();
});

test("rapid native inputs retain their original timestamps and are committed in order", async () => {
  const f = fixture(), client = await f.open(false);
  f.block();
  const one = client.recordTap(1, run, f.clock);
  const two = client.recordTap(1, run, f.clock + 1);
  const three = client.recordTap(1, run, f.clock + 2);
  await settle(); assert.equal(client.snapshot().pendingTaps, 0);
  f.advance(20); f.release();
  assert.deepEqual(await Promise.all([one, two, three]), [1, 1, 1]);
  const stored = JSON.parse(f.values.get(key));
  assert.equal(client.snapshot().pendingTaps, 3);
  assert.deepEqual(stored.deferredQueue.flatMap(item => item.times), [epoch, epoch + 1, epoch + 2]);
  await client.dispose();
});

test("disposing during a native commit does not acknowledge input or publish late state", async () => {
  const f = fixture(), client = await f.open(true);
  f.block();
  const input = client.recordTap(1, run, f.clock);
  await settle();
  const count = f.snapshots.length;
  const close = client.dispose();
  f.release();
  assert.equal(await input, 0);
  await close;
  assert.equal(f.snapshots.length, count);
  assert.equal(f.calls.length, 0);
});

test("owner invalidation rejects the outstanding commit and cannot emit old progress", async () => {
  const f = fixture(), client = await f.open(true);
  f.block();
  const input = client.recordTap(1, run, f.clock);
  await settle(); f.invalidate(); f.release();
  assert.equal(await input, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(client.snapshot().pendingTaps, 0);
  await client.dispose();
});

test("legacy input receipts survive interrupted browser cleanup and import only once", async () => {
  const f = fixture(), legacy = browserStore();
  const id = crypto.randomUUID(), inputKey = `zhiv:game-input:v1:${owner}:${id}`;
  legacy.setItem(inputKey, JSON.stringify({ id, ownerPublicId: owner, runId: run, count: 2, capturedAt: f.clock }));
  const remove = legacy.removeItem;
  legacy.removeItem = () => { throw new Error("Browser cleanup blocked"); };
  const first = await f.open(false, legacy);
  assert.equal(first.snapshot().pendingTaps, 2);
  assert.deepEqual(JSON.parse(f.values.get(key)).inputReceipts, [id]);
  assert.ok(legacy.getItem(inputKey));
  await first.dispose();
  legacy.removeItem = remove;
  const second = await f.open(false, legacy);
  assert.equal(second.snapshot().pendingTaps, 2);
  assert.equal(legacy.getItem(inputKey), null);
  assert.deepEqual(JSON.parse(f.values.get(key)).inputReceipts, []);
  second.setOnline(true); await second.flush();
  assert.equal(f.total, 2);
  await second.dispose();
});

test("failed native migration retains the original WebView journal and all input", async () => {
  const f = fixture(), original = await f.open(false);
  await original.recordTap(1, run, f.clock); await original.dispose();
  const raw = f.values.get(key), legacy = browserStore();
  legacy.setItem(key, raw); f.values.clear(); f.fail(() => true);
  await assert.rejects(f.open(false, legacy), /SQLite/);
  assert.equal(legacy.getItem(key), raw);
  assert.equal(f.values.size, 0);
  assert.equal(f.calls.length, 0);
});

test("legacy WebView journal is deleted only after the native transaction acknowledges it", async () => {
  const f = fixture(), original = await f.open(false);
  await original.recordTap(2, run, f.clock); await original.dispose();
  const raw = f.values.get(key), legacy = browserStore();
  legacy.setItem(key, raw); f.values.clear(); f.block();
  const opening = f.open(false, legacy);
  await settle();
  assert.equal(legacy.getItem(key), raw);
  assert.equal(f.values.size, 0);
  f.release();
  const migrated = await opening;
  assert.equal(migrated.snapshot().pendingTaps, 2);
  assert.equal(legacy.getItem(key), null);
  assert.equal(JSON.parse(f.values.get(key)).ownerPublicId, owner);
  await migrated.dispose();
});

test("late network success after disposal cannot replace the committed pending receipt", async () => {
  const f = fixture();
  let complete, entered;
  const active = new Promise(resolve => { entered = resolve; });
  const api = { ...f.api, batch: async body => {
    const result = await f.api.batch(body);
    entered();
    return new Promise(resolve => { complete = () => resolve(result); });
  } };
  const client = await f.open(true, undefined, { api });
  await client.recordTap(1, run, f.clock);
  await active;
  const raw = f.values.get(key), count = f.snapshots.length;
  await client.dispose(); complete(); await settle();
  assert.equal(f.values.get(key), raw);
  assert.ok(JSON.parse(raw).pendingBatch);
  assert.equal(f.snapshots.length, count);
  const recovered = await f.open(true); await recovered.flush();
  assert.equal(f.total, 1);
  assert.equal(recovered.snapshot().pendingTaps, 0);
  await recovered.dispose();
});

test("a response belonging to another account closes the native tap controller", async () => {
  const f = fixture();
  const client = await f.open(true, undefined, { api: { ...f.api, progress: async () => ({
    ownerPublicId: other, items: [], lifetimeTaps: 999, bestSeries: 999,
    month: "2026-11", monthlyTaps: 999, leaderboardOptIn: false, visibilityVersion: 0, serverTime: new Date(epoch).toISOString(),
  }) } });
  await client.refresh();
  assert.equal(f.sessionLost, 1);
  assert.equal(await client.recordTap(1, run, f.clock), 0);
  assert.equal(f.snapshots.some(s => s.progress?.ownerPublicId === other), false);
  await client.dispose();
});

test("corrupt or foreign legacy journals fail closed without rewriting either store", async () => {
  const f = fixture(), legacy = browserStore();
  legacy.setItem(key, "{corrupt");
  await assert.rejects(f.open(false, legacy));
  assert.equal(legacy.getItem(key), "{corrupt");
  assert.equal(f.values.size, 0);
  legacy.rows.clear();
  const id = crypto.randomUUID(), inputKey = `zhiv:game-input:v1:${owner}:${id}`;
  legacy.setItem(inputKey, JSON.stringify({ id, ownerPublicId: other, runId: run, count: 1, capturedAt: epoch }));
  await assert.rejects(f.open(false, legacy), /owner mismatch/);
  assert.ok(legacy.getItem(inputKey));
  assert.equal(f.values.size, 0);
});
