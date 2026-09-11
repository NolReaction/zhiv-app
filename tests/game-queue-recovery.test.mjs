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
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "7K3P-2Q9M-W8ZR";
const oldId = "9a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const freshId = "8a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const runId = "4a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const epoch = Date.parse("2026-09-07T10:00:00Z");
const progress = time => ({ ownerPublicId: owner, items: [], lifetimeTaps: 100, bestSeries: 100,
  month: "2026-09", monthlyTaps: 100, leaderboardOptIn: false, visibilityVersion: 0,
  serverTime: new Date(time).toISOString() });

function fixture(code, opening = false) {
  let clock = epoch + 3 * 86400000, raw, failArchive = false;
  const storage = { getItem: () => raw, setItem: (_key, value) => {
    if (failArchive && JSON.parse(value).archivedQueues.length) throw new Error("Quota exceeded");
    raw = value;
  } };
  const journal = gameJournalStore(owner, storage);
  const batch = { sessionId: oldId, sequence: 2, runId, tapCount: 9, tapTimes: Array(9).fill(epoch + 1000) };
  const queue = [{ runId, count: 4, times: Array(4).fill(epoch + 2000) }];
  journal.write({ version: 1, ownerPublicId: owner, savedAt: epoch + 3000, progress: progress(epoch),
    session: opening ? null : { sessionId: oldId, nextSequence: 2, startedAt: new Date(epoch).toISOString(),
      expiresAt: new Date(epoch + 900000).toISOString(), progress: progress(epoch) },
    run: { runId, acceptedTaps: 100, rejectedTaps: 0, interrupted: false }, queue,
    pendingBatch: opening ? null : batch, startRequest: opening ? { requestId: oldId, ownerPublicId: owner } : null,
    archivedQueues: [], recordingStopped: false, lastEventAt: epoch + 2000, rejectedTaps: 0,
    serverOffset: 0, retryAfter: 0, retryRemaining: 0 });
  const original = journal.read(), sent = [], starts = [];
  const failure = () => { throw new ApiError("Terminal receipt", code === "GAME_SESSION_CONFLICT" ? 409 : 410, { code, message: "Terminal receipt" }); };
  const api = {
    progress: async () => progress(clock),
    session: async body => {
      starts.push(body);
      if (body.requestId === oldId) return failure();
      return { sessionId: freshId, nextSequence: 1, startedAt: new Date(clock).toISOString(),
        expiresAt: new Date(clock + 900000).toISOString(), progress: progress(clock) };
    },
    batch: async body => {
      sent.push(structuredClone(body));
      if (body.sessionId === oldId) return failure();
      return { sessionId: freshId, sequence: body.sequence, acceptedTaps: body.tapCount,
        rejectedTaps: 0, runTaps: body.tapCount, replayed: false,
        progress: { ...progress(clock), lifetimeTaps: 100 + body.tapCount } };
    },
  };
  const client = () => new GameSyncClient(owner, true, () => {}, () => assert.fail("must not lose login"),
    api, () => clock, () => crypto.randomUUID(), async delay => { clock += delay; }, journal, () => clock);
  return { client, journal, original, sent, starts, storage, fail: value => { failArchive = value; }, advance: () => { clock += 60000; } };
}

for (const code of ["GAME_QUEUE_EXPIRED", "GAME_SESSION_GONE", "GAME_SESSION_CONFLICT"]) {
  test(`${code}: archive exact old queue across reloads and only send fresh taps`, async () => {
    const f = fixture(code);
    const before = f.client(); before.dispose();
    const recovered = f.client(); await recovered.flush();
    assert.equal(recovered.snapshot().pendingTaps, 0);
    assert.equal(recovered.snapshot().archivedTaps, 13);
    assert.equal(recovered.snapshot().rejectedTaps, 0);
    const archived = f.journal.read().archivedQueues[0];
    assert.deepEqual(archived.pendingBatch, f.original.pendingBatch);
    assert.deepEqual(archived.queue, f.original.queue);
    assert.deepEqual(archived.session, f.original.session);
    assert.equal(f.starts.length, 0);
    recovered.dispose();
    const next = f.client();
    assert.equal(next.snapshot().archivedTaps, 13);
    assert.equal(next.recordTap(2, crypto.randomUUID()), 2); await next.flush();
    assert.equal(next.snapshot().progress.lifetimeTaps, 102);
    assert.equal(f.starts.length, 1);
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].sessionId, freshId);
    assert.equal(f.sent[1].tapCount, 2);
    assert.deepEqual(f.journal.read().archivedQueues[0], archived);
    next.dispose();
  });
}

test("failed archive storage preserves the active outbox until a later successful write", async () => {
  const f = fixture("GAME_QUEUE_EXPIRED"); f.fail(true);
  const client = f.client(); await client.flush();
  assert.equal(client.snapshot().pendingTaps, 13);
  assert.equal(client.snapshot().archivedTaps, 0);
  assert.deepEqual(f.journal.read().pendingBatch, f.original.pendingBatch);
  assert.equal(client.recordTap(1, runId), 1);
  assert.equal(client.snapshot().pendingTaps, 14);
  assert.deepEqual(f.journal.read().pendingBatch, f.original.pendingBatch);
  assert.equal(f.journal.read().deferredQueue[0].count, 1);
  f.fail(false); f.advance(); await client.flush();
  assert.equal(client.snapshot().pendingTaps, 1);
  assert.equal(client.snapshot().archivedTaps, 13);
  await client.flush();
  assert.equal(client.snapshot().pendingTaps, 0);
  assert.equal(client.snapshot().progress.lifetimeTaps, 101);
  client.dispose();
});

test("a terminal opening request is archived before generating another request ID", async () => {
  const f = fixture("GAME_SESSION_CONFLICT", true), client = f.client();
  await client.flush();
  assert.equal(client.snapshot().archivedTaps, 4);
  assert.deepEqual(f.journal.read().archivedQueues[0].startRequest, f.original.startRequest);
  assert.equal(client.recordTap(1, crypto.randomUUID()), 1); await client.flush();
  assert.notEqual(f.starts[1].requestId, oldId);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].tapCount, 1);
  client.dispose();
});

test("an oversized recovery archive cannot replace the readable journal", () => {
  const f = fixture("GAME_QUEUE_EXPIRED"), before = f.storage.getItem();
  const archived = { archivedAt: epoch, code: "GAME_QUEUE_EXPIRED", requestId: "x".repeat(2000000),
    queue: f.original.queue, pendingBatch: f.original.pendingBatch, session: f.original.session, startRequest: null };
  assert.throws(() => f.journal.write({ ...f.original, archivedQueues: [archived] }), /Journal too large/);
  assert.equal(f.storage.getItem(), before);
  assert.deepEqual(f.journal.read(), f.original);
});
