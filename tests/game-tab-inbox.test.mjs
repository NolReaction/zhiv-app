import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { GameSyncClient } = await vite.ssrLoadModule("/features/game/game-sync.ts");
const { gameJournalStore } = await vite.ssrLoadModule("/features/game/game-sync-journal.ts");
const { gameTabInbox } = await vite.ssrLoadModule("/features/game/game-tab-inbox.ts");
const owner = "7K3P-2Q9M-W8ZR", other = "7K3P-2Q9M-W8ZX";
const runA = crypto.randomUUID(), runB = crypto.randomUUID();
const epoch = Date.parse("2026-09-11T10:00:00Z");

function fixture() {
  const values = new Map(), receipts = new Map(), envelopes = [];
  let clock = epoch, total = 0, lostAck = false, failWrite = false, failRemove = false;
  const storage = {
    get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, raw) => { if (failWrite && key.includes("outbox")) throw new Error("Quota exceeded"); values.set(key, raw); },
    removeItem: key => { if (failRemove) throw new Error("Removal interrupted"); values.delete(key); },
  };
  const journal = gameJournalStore(owner, storage);
  const progress = () => ({ ownerPublicId: owner, items: [], lifetimeTaps: total, bestSeries: total,
    month: "2026-09", monthlyTaps: total, leaderboardOptIn: false, visibilityVersion: 0,
    serverTime: new Date(clock).toISOString() });
  const api = { progress: async () => progress(),
    session: async () => ({ sessionId: crypto.randomUUID(), nextSequence: 1,
      startedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 900000).toISOString(), progress: progress() }),
    batch: async body => {
      assert.deepEqual(journal.read().pendingBatch, body, "persist the exact envelope before dispatch");
      const key = `${body.sessionId}:${body.sequence}`;
      if (receipts.has(key)) {
        assert.deepEqual(envelopes.find(item => `${item.sessionId}:${item.sequence}` === key), body);
        return { ...receipts.get(key), replayed: true, progress: progress() };
      }
      total += body.tapCount; envelopes.push(structuredClone(body));
      const result = { sessionId: body.sessionId, sequence: body.sequence, acceptedTaps: body.tapCount,
        rejectedTaps: 0, runTaps: total, replayed: false, progress: progress() };
      receipts.set(key, result);
      if (lostAck) { lostAck = false; throw new TypeError("Network lost after commit"); }
      return result;
    },
  };
  return { storage, journal, envelopes, inbox: () => gameTabInbox(owner, storage),
    client: () => new GameSyncClient(owner, false, () => {}, () => assert.fail("owner changed"), api,
      () => clock, () => crypto.randomUUID(), async delay => { clock += delay; }, journal, () => clock),
    get clock() { return clock; }, get total() { return total; },
    advance: () => { clock += 60000; }, loseAck: () => { lostAck = true; },
    failWrite: value => { failWrite = value; }, failRemove: value => { failRemove = value; } };
}

test("two visible producers each record beyond 634 before a writer exists, then reload and drain exactly once", async () => {
  const f = fixture(), a = f.inbox(), b = f.inbox();
  for (let i = 0; i < 720; i++) {
    assert.equal(a.record(1, runA, f.clock + i), 1);
    assert.equal(b.record(1, runB, f.clock + i), 1);
  }
  assert.equal(a.snapshot(false, runA).run.pendingTaps, 720);
  assert.equal(b.snapshot(false, runB).run.pendingTaps, 720);
  assert.equal(a.snapshot(false).pendingTaps, 1440);
  const first = f.client();
  assert.equal(a.drain(first), true, "large imports are split so they cannot freeze the UI or writer heartbeat");
  while (a.drain(first)) { /* Finish the bounded import slices. */ }
  first.dispose();
  assert.equal(f.storage.length, 1, "only the delivery journal remains after import");
  const next = f.client(); b.drain(next); next.setOnline(true); await next.flush();
  assert.equal(f.total, 1440); assert.equal(next.snapshot().pendingTaps, 0);
  assert.equal(a.snapshot(true, runA).run.pendingTaps, 0);
  assert.equal(b.snapshot(true, runB).run.pendingTaps, 0);
  assert.equal(a.snapshot(true, runA).run.creditedTaps, 720);
  assert.equal(b.snapshot(true, runB).run.creditedTaps, 720);
  assert.equal(a.snapshot(true).progress.lifetimeTaps, 1440);
  assert.deepEqual(f.journal.read().inputReceipts, []); next.dispose();
});

test("crash after journal import but before inbox removal does not duplicate a tap on handoff", async () => {
  const f = fixture(), inbox = f.inbox(), a = f.client();
  inbox.record(9, runA, f.clock); f.failRemove(true);
  assert.throws(() => inbox.drain(a), /Removal interrupted/);
  assert.equal(f.journal.read().inputReceipts.length, 1);
  assert.equal(inbox.snapshot(false, runA).pendingTaps, 9, "the input and imported queue are the same taps");
  a.dispose(); f.failRemove(false);
  const b = f.client(); inbox.drain(b); b.setOnline(true); await b.flush();
  assert.equal(f.total, 9); assert.equal(f.storage.length, 1);
  assert.deepEqual(f.journal.read().inputReceipts, []); b.dispose();
});

test("failed journal write leaves immutable input available to another writer", async () => {
  const f = fixture(), inbox = f.inbox(), first = f.client();
  inbox.record(7, runA, f.clock); f.failWrite(true); inbox.drain(first);
  assert.equal(f.journal.read(), null);
  assert.equal(inbox.snapshot(false, runA, first).pendingTaps, 7, "unpersisted memory must not double-count the durable input");
  assert.equal(inbox.snapshot(false, runA, first).durable, false);
  first.dispose(); f.failWrite(false);
  const next = f.client(); inbox.drain(next); next.setOnline(true); await next.flush();
  assert.equal(f.total, 7); assert.equal(next.snapshot().pendingTaps, 0); next.dispose();
});

test("lost server ACK plus writer reload and fresh input replays the immutable envelope once", async () => {
  const f = fixture(), a = f.inbox(), b = f.inbox(), first = f.client();
  a.record(8, runA, f.clock); a.drain(first); f.loseAck(); first.setOnline(true); await first.flush();
  const envelope = f.journal.read().pendingBatch;
  assert.ok(envelope); assert.equal(f.total, 8);
  b.record(13, runB, f.clock); first.dispose(); f.advance();
  const next = f.client(); b.drain(next); next.setOnline(true); await next.flush();
  assert.equal(f.total, 21); assert.deepEqual(f.envelopes[0], envelope);
  assert.equal(next.snapshot().pendingTaps, 0); next.dispose();
});

test("an input persists when another writer owns dispatch and account journals stay isolated", () => {
  const f = fixture(), inbox = f.inbox();
  f.storage.setItem(`zhiv:game-writer:v1:${owner}`, JSON.stringify({ id: crypto.randomUUID(), until: f.clock + 8000 }));
  assert.equal(inbox.record(1, runA, f.clock), 1);
  const isolated = gameTabInbox(other, f.storage);
  assert.equal(isolated.snapshot(false).pendingTaps, 0);
  assert.equal(inbox.snapshot(false, runA).run.pendingTaps, 1);
  assert.throws(() => inbox.record(0, runA, f.clock));
});

test("an input written before a permit becomes catch-up, without fabricated historical timestamps", async () => {
  const f = fixture(), inbox = f.inbox();
  inbox.record(3, runA, f.clock); f.advance();
  const writer = f.client(); inbox.drain(writer); writer.setOnline(true); await writer.flush();
  assert.equal(f.total, 3); assert.equal(f.envelopes[0].tapTimes, undefined); writer.dispose();
});
