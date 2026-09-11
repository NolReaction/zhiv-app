import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { GameSyncClient } = await vite.ssrLoadModule("/features/game/game-sync.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const devGame = await vite.ssrLoadModule("/lib/dev/game-store.ts");
const epoch = Date.parse("2026-09-10T10:00:00Z");
const owner = "7K3P-2Q9M-W8ZR";
const runId = "4a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const oldId = "9a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const settle = () => new Promise(resolve => setImmediate(resolve));
const progress = (at, total = 0) => ({ ownerPublicId: owner, items: [], lifetimeTaps: total,
  bestSeries: total, month: "2026-09", monthlyTaps: total, leaderboardOptIn: false,
  visibilityVersion: 0, serverTime: new Date(at).toISOString() });

function fixture(options = {}) {
  let clock = 0, saved = options.saved ?? null, total = 0, opens = 0;
  const bodies = [];
  const journal = { read: () => structuredClone(saved), write: value => { saved = structuredClone(value); } };
  const session = () => ({ sessionId: crypto.randomUUID(), nextSequence: 1,
    startedAt: new Date(epoch + clock).toISOString(), expiresAt: new Date(epoch + clock + 900000).toISOString(),
    progress: progress(epoch + clock, total) });
  const api = {
    progress: async () => progress(epoch + clock, total),
    session: async body => { opens++; return options.open ? options.open(body, session) : session(); },
    batch: async body => {
      assert.deepEqual(saved.pendingBatch, body, "the exact envelope must be durable before dispatch");
      bodies.push(structuredClone(body));
      if (options.batch) await options.batch(body);
      total += body.tapCount;
      return { sessionId: body.sessionId, sequence: body.sequence, acceptedTaps: body.tapCount,
        rejectedTaps: 0, runTaps: total, replayed: false, progress: progress(epoch + clock, total) };
    },
  };
  const client = new GameSyncClient(owner, options.online ?? true, () => {}, () => assert.fail("owner changed"),
    api, () => clock, () => crypto.randomUUID(), async delay => { clock += delay; }, journal, () => epoch + clock);
  return { client, bodies, journal, setClock: value => { clock = value; },
    get clock() { return clock; }, get opens() { return opens; } };
}

function savedOutbox(overrides = {}) {
  return { version: 1, ownerPublicId: owner, savedAt: epoch, progress: null,
    queue: [], session: null, pendingBatch: null, startRequest: null,
    run: { runId, acceptedTaps: 0, rejectedTaps: 0, interrupted: false },
    archivedQueues: [], deferredQueue: [], catchUpMode: false, rejectedTaps: 0,
    serverOffset: 0, recordingStopped: false, lastEventAt: 0, retryAfter: 0, retryRemaining: 0,
    ...overrides };
}

const oldSession = () => ({ sessionId: oldId, nextSequence: 2,
  startedAt: new Date(epoch).toISOString(), expiresAt: new Date(epoch + 900000).toISOString(), progress: progress(epoch) });

test("634 fast taps survive a held handshake and resume event-time telemetry after catch-up", async () => {
  let release;
  const f = fixture({ open: (_body, session) => new Promise(resolve => { release = () => resolve(session()); }) });
  assert.equal(f.client.recordTap(634, runId), 634);
  assert.equal(f.journal.read().queue.reduce((sum, item) => sum + item.count, 0), 60);
  assert.equal(f.journal.read().deferredQueue.reduce((sum, item) => sum + item.count, 0), 574);
  release(); await f.client.flush();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 634);
  assert.equal(f.client.snapshot().pendingTaps, 0);
  assert.equal(f.bodies[0].tapTimes.length, 60);
  assert.ok(f.bodies.slice(1).every(body => body.tapTimes === undefined));
  assert.equal(f.journal.read().catchUpMode, false);
  const catchUpEnd = Date.parse(f.client.snapshot().progress.serverTime);
  f.setClock(f.clock + 100);
  assert.equal(f.client.recordTap(1, runId), 1); await f.client.flush();
  assert.equal(f.bodies.at(-1).tapTimes.length, 1);
  assert.ok(f.bodies.at(-1).tapTimes[0] >= catchUpEnd);
  f.client.dispose();
});

test("permit expiry keeps an in-flight envelope immutable while fresh taps wait durably", async () => {
  let release, first = true;
  const f = fixture({ batch: async () => { if (first) { first = false; await new Promise(resolve => { release = resolve; }); } } });
  f.client.recordTap(1, runId); await settle();
  const pending = structuredClone(f.journal.read().pendingBatch);
  f.setClock(900001);
  assert.equal(f.client.recordTap(10, runId), 10);
  assert.deepEqual(f.journal.read().pendingBatch, pending);
  assert.equal(f.journal.read().deferredQueue.reduce((sum, item) => sum + item.count, 0), 10);
  release(); await f.client.flush();
  assert.equal(f.opens, 2);
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 11);
  assert.equal(f.client.snapshot().pendingTaps, 0);
  assert.deepEqual(f.bodies[0], pending);
  assert.equal(f.bodies[1].tapTimes, undefined);
  f.client.dispose();
});

test("fresh deferred taps survive archiving an unrelated ambiguous old receipt", async () => {
  const pendingBatch = { sessionId: oldId, sequence: 2, runId, tapCount: 3, tapTimes: [epoch + 10, epoch + 20, epoch + 30] };
  const queued = [{ runId, count: 2, times: [epoch + 1000, epoch + 1001] }];
  const f = fixture({ saved: savedOutbox({ session: oldSession(), pendingBatch, queue: queued,
    deferredQueue: [{ runId, count: 5, times: Array(5).fill(epoch + 300000000), deferred: true }] }),
    batch: async body => { if (body.sessionId === oldId) throw new ApiError("gone", 410, { code: "GAME_SESSION_GONE", message: "gone" }); } });
  f.setClock(300000000); await f.client.flush();
  assert.equal(f.client.snapshot().archivedTaps, 5);
  assert.equal(f.client.snapshot().pendingTaps, 5);
  assert.deepEqual(f.journal.read().archivedQueues[0].pendingBatch, pendingBatch);
  assert.deepEqual(f.journal.read().archivedQueues[0].queue, queued);
  await f.client.flush();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 5);
  assert.equal(f.client.snapshot().pendingTaps, 0);
  assert.equal(f.bodies.length, 2);
  assert.notEqual(f.bodies[1].sessionId, oldId);
  f.client.dispose();
});

test("a restored closed permit stays idle until the player records fresh input", async () => {
  const f = fixture({ saved: savedOutbox({ recordingStopped: true,
    session: { ...oldSession(), closedAt: new Date(epoch + 1000).toISOString() } }) });
  f.setClock(3000); await f.client.flush();
  assert.equal(f.opens, 0);
  assert.equal(f.client.recordTap(3, runId), 3); await f.client.flush();
  assert.equal(f.opens, 1);
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 3);
  f.client.dispose();
});

test("recovered opening uses integer event times despite a fractional persisted clock offset", async () => {
  const f = fixture({ saved: savedOutbox({ serverOffset: 0.5,
    startRequest: { ownerPublicId: owner, requestId: crypto.randomUUID() },
    queue: [{ runId, count: 1, times: [epoch + 1000] }], lastEventAt: epoch + 1000 }),
    open: async (_body, session) => ({ ...session(), sessionId: oldId, startedAt: new Date(epoch).toISOString() }) });
  f.setClock(5000); await f.client.flush();
  assert.ok(f.bodies[0].tapTimes.every(Number.isSafeInteger));
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 1);
  f.client.dispose();
});

test("recovering an old desktop queue cannot silently steal the phone writer permit", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: epoch });
  identities.resetDevStoreForTests(); devGame.resetDevGameStoreForTests();
  const key = crypto.randomUUID();
  const desktop = identities.createDevIdentity("Owner", key, "UTC");
  const phone = identities.createDevIdentity("Owner", key, "UTC");
  let clock = 0, desktopOpens = 0;
  const advance = value => { clock = value; context.mock.timers.setTime(epoch + clock); };
  const ok = value => { if (value.kind === "ok") return value.value;
    throw new ApiError(value.code, 409, { code: value.code, message: value.code }); };
  const make = (player, isDesktop) => new GameSyncClient(player.me.user.publicId, true, () => {}, () => assert.fail("owner changed"), {
    progress: async () => ok(devGame.getDevGameProgress(player.token)),
    session: async body => { if (isDesktop) desktopOpens++; return ok(devGame.createDevGameSession(player.token, body.ownerPublicId, body.requestId)); },
    batch: async body => ok(devGame.submitDevGameBatch(player.token, body)),
  }, () => clock, () => crypto.randomUUID(), async delay => advance(clock + delay), undefined, () => epoch + clock);
  const a = make(desktop, true), b = make(phone, false);
  a.recordTap(1, runId); await a.flush(); a.setOnline(false);
  advance(31000); b.recordTap(1, runId); await b.flush();
  advance(32000); a.recordTap(1, runId); a.setOnline(true); await a.flush();
  assert.equal(a.snapshot().errorCode, "GAME_PERMIT_CLOSED");
  advance(63000); await a.flush();
  assert.equal(desktopOpens, 1, "old closed input must never request a fresh writer");
  advance(64000); assert.equal(b.recordTap(1, runId), 1); await b.flush();
  assert.equal(b.recordTap(1, runId), 1); await b.flush();
  assert.equal(b.snapshot().rejectedTaps, 0);
  assert.equal(b.snapshot().pendingTaps, 0);
  assert.equal(b.snapshot().progress.lifetimeTaps, 4);
  a.dispose(); b.dispose();
});

test("legacy catch-up budget exhaustion never consumes its sequence or creates a partial receipt", context => {
  context.mock.timers.enable({ apis: ["Date"], now: epoch });
  identities.resetDevStoreForTests(); devGame.resetDevGameStoreForTests();
  const player = identities.createDevIdentity("Owner", crypto.randomUUID(), "UTC");
  const ok = value => { assert.equal(value.kind, "ok", JSON.stringify(value)); return value.value; };
  const permit = ok(devGame.createDevGameSession(player.token, player.me.user.publicId, crypto.randomUUID()));
  const initial = { sessionId: permit.sessionId, sequence: 1, runId, tapCount: 59 };
  ok(devGame.submitDevGameBatch(player.token, initial));
  const pending = { ...initial, sequence: 2, tapCount: 2 };
  assert.equal(devGame.submitDevGameBatch(player.token, pending).code, "GAME_PACING");
  assert.equal(ok(devGame.getDevGameProgress(player.token)).lifetimeTaps, 59);
  context.mock.timers.setTime(epoch + 2000);
  const accepted = ok(devGame.submitDevGameBatch(player.token, pending));
  assert.equal(accepted.acceptedTaps, 2); assert.equal(accepted.rejectedTaps, 0);
  assert.equal(accepted.progress.lifetimeTaps, 61);
  const replayed = ok(devGame.submitDevGameBatch(player.token, pending));
  assert.equal(replayed.replayed, true); assert.equal(replayed.progress.lifetimeTaps, 61);
});
