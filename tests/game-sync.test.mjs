import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});
const { GameSyncClient } = await vite.ssrLoadModule("/lib/game-sync.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const gameApi = await vite.ssrLoadModule("/lib/game-api.ts");
const identities = await vite.ssrLoadModule("/lib/dev-api-store.ts");
const devGame = await vite.ssrLoadModule("/lib/dev-game-store.ts");
after(async () => vite.close());

const owner = "7K3P-2Q9M-W8ZR";
const otherOwner = "8K3P-2Q9M-W8ZR";
const sessionId = "9a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const runId = "4a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const requestId = "5a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const settle = () => new Promise(resolve => setImmediate(resolve));
const progress = (overrides = {}) => ({
  ownerPublicId: owner, items: [], lifetimeTaps: 0, bestSeries: 0,
  month: "2026-09", monthlyTaps: 0, leaderboardOptIn: false,
  visibilityVersion: 0, serverTime: "2026-09-07T10:00:00.000Z", ...overrides,
});
function fixture(overrides = {}) {
  let now = 0;
  let saved = progress();
  const runs = new Map();
  let lost = 0;
  const calls = [];
  const snapshots = [];
  const api = {
    progress: async () => saved,
    session: async body => {
      calls.push({ kind: "session", body: { ...body } });
      return { sessionId, nextSequence: 1, expiresAt: "2026-09-07T10:15:00.000Z", progress: saved };
    },
    batch: async body => {
      calls.push({ kind: "batch", body: { ...body } });
      const runTaps = (runs.get(body.runId) ?? 0) + body.tapCount;
      runs.set(body.runId, runTaps);
      saved = progress({ lifetimeTaps: saved.lifetimeTaps + body.tapCount, monthlyTaps: saved.monthlyTaps + body.tapCount,
        bestSeries: Math.max(saved.bestSeries, runTaps) });
      return { sessionId: body.sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, runTaps, rejectedTaps: 0, replayed: false, progress: saved };
    },
    ...overrides,
  };
  const client = new GameSyncClient(owner, true, value => snapshots.push(value), () => { lost += 1; }, api, () => now, () => requestId,
    async delayMs => { now += delayMs; });
  return { client, calls, snapshots, setNow: value => { now = value; }, lost: () => lost };
}

test("starts from server progress and batches real taps without importing lifetime counters", async () => {
  const f = fixture();
  await f.client.refresh();
  f.client.recordTap(1, runId);
  await settle();
  assert.deepEqual(f.calls[0].body, { ownerPublicId: owner, requestId });
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 1);
  f.client.recordTap(20, runId);
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 1);
  assert.equal(f.client.snapshot().pendingTaps, 20);
  await f.client.flush();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 21);
  assert.equal(f.calls.at(-1).body.sequence, 2);
  assert.deepEqual(Object.keys(f.calls.at(-1).body).sort(), ["runId", "sequence", "sessionId", "tapCount"]);
  f.client.dispose();
});

test("retries an unknown result exactly once before sending taps observed during failure", async () => {
  const batches = [];
  let total = 0;
  const f = fixture({ batch: async body => {
    batches.push({ ...body });
    if (batches.length === 1) { total += body.tapCount; throw new Error("response lost after commit"); }
    const replayed = batches.length === 2;
    if (!replayed) total += body.tapCount;
    return { sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, runTaps: total, rejectedTaps: 0, replayed,
      progress: progress({ lifetimeTaps: total, monthlyTaps: total, bestSeries: total }) };
  } });
  f.client.recordTap(3, runId);
  await settle();
  assert.equal(f.client.snapshot().status, "error");
  assert.equal(f.client.recordTap(50, runId), 50);
  assert.equal(f.client.snapshot().pendingTaps, 53);
  f.setNow(3_000);
  await f.client.flush();
  assert.deepEqual(batches[0], batches[1]);
  assert.equal(batches[2].sequence, 2);
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 53);
  assert.equal(f.client.snapshot().run.acceptedTaps, 53);
  assert.equal(f.client.snapshot().pendingTaps, 0);
  f.client.dispose();
});

test("bounds the durable queue and reports overflow without counting taps never queued", async () => {
  let resolveBatch;
  const f = fixture({ batch: body => new Promise(resolve => { resolveBatch = () => resolve({ sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, rejectedTaps: 0, runTaps: body.tapCount, replayed: false, progress: progress() }); }) });
  f.client.recordTap(1, runId); await settle();
  assert.equal(f.client.recordTap(31_000, runId), 29_999);
  assert.equal(f.client.snapshot().pendingTaps, 30_000);
  assert.equal(f.client.snapshot().errorCode, "QUEUE_FULL");
  f.client.setOnline(false);
  assert.equal(f.client.recordTap(20, runId), 0); // A legacy server has no offline permit.
  assert.equal(f.client.snapshot().pendingTaps, 30_000);
  f.client.dispose(); resolveBatch(); await settle();
});

test("keeps one write in flight and never combines different runs in a batch", async () => {
  let resolveBatch;
  const batches = [];
  const f = fixture({ batch: body => {
    batches.push({ ...body });
    return new Promise(resolve => { resolveBatch = () => resolve({ sessionId, sequence: body.sequence,
      acceptedTaps: body.tapCount, runTaps: body.tapCount, rejectedTaps: 0, replayed: false, progress: progress() }); });
  } });
  f.client.recordTap(1, runId);
  await settle();
  f.client.recordTap(2, requestId);
  const joined = f.client.flush();
  assert.equal(f.client.flush(), joined);
  assert.equal(batches.length, 1);
  resolveBatch();
  await settle();
  const second = f.client.flush();
  await settle();
  assert.equal(batches.length, 2);
  assert.equal(batches[1].runId, requestId);
  assert.equal(batches[1].tapCount, 2);
  resolveBatch();
  await second;
  f.client.dispose();
});

test("only an explicit uncommitted session expiry retries observed taps in a new session", async () => {
  let attempts = 0;
  const batches = [];
  let total = 0;
  const f = fixture({ batch: async body => {
    batches.push({ ...body });
    attempts += 1;
    if (attempts === 1) throw new ApiError("expired", 409, { code: "GAME_SESSION_EXPIRED", message: "expired" });
    total += body.tapCount;
    return { sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, runTaps: total, rejectedTaps: 0,
      replayed: false, progress: progress({ lifetimeTaps: total, bestSeries: total }) };
  } });
  f.client.recordTap(10, runId);
  await settle();
  assert.equal(f.client.snapshot().pendingTaps, 0);
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 10);
  assert.equal(f.client.snapshot().run.rejectedTaps, 0);
  f.setNow(3_000);
  f.client.recordTap(1, runId);
  await f.client.flush();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 11);
  assert.equal(f.calls.filter(call => call.kind === "session").length, 2);
  assert.equal(batches[0].tapCount, batches[1].tapCount);
  f.client.dispose();
});

test("ignores responses after disposal and refuses a session belonging to another account", async () => {
  let resolveRead;
  const f = fixture({ progress: () => new Promise(resolve => { resolveRead = resolve; }) });
  const read = f.client.refresh();
  f.client.dispose();
  resolveRead(progress({ lifetimeTaps: 99 }));
  await read;
  assert.equal(f.snapshots.length, 0);
  const g = fixture({ session: async () => ({ sessionId, nextSequence: 1,
    expiresAt: "2026-09-07T10:15:00.000Z", progress: progress({ ownerPublicId: otherOwner }) }) });
  g.client.recordTap(1, runId);
  await settle();
  assert.equal(g.lost(), 1);
  assert.equal(g.calls.filter(call => call.kind === "batch").length, 0);
});

test("late snapshots do not undo opt-in or move the monthly score back across UTC midnight", () => {
  const f = fixture();
  f.client.adoptProgress(progress({ lifetimeTaps: 12, monthlyTaps: 12 }));
  f.client.adoptProgress(progress({ lifetimeTaps: 13, monthlyTaps: 1, month: "2026-10",
    serverTime: "2026-10-01T00:00:01.000Z", leaderboardOptIn: true, visibilityVersion: 1 }));
  f.client.adoptProgress(progress({ lifetimeTaps: 12, monthlyTaps: 12 }));
  f.client.adoptProgress(progress({ lifetimeTaps: 999, monthlyTaps: 999 }));
  const current = f.client.snapshot().progress;
  assert.equal(current.month, "2026-10");
  assert.equal(current.monthlyTaps, 1);
  assert.equal(current.lifetimeTaps, 13);
  assert.equal(current.leaderboardOptIn, true);
  f.client.dispose();
});

test("uses server-confirmed accepted counts when the shared tap budget rejects part of a batch", async () => {
  const f = fixture({ batch: async body => ({ sessionId, sequence: body.sequence,
    acceptedTaps: 2, runTaps: 2, rejectedTaps: body.tapCount - 2, replayed: false,
    progress: progress({ lifetimeTaps: 2, monthlyTaps: 2 }) }) });
  f.client.recordTap(10, runId);
  await settle();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 2);
  assert.deepEqual(f.client.snapshot().run, { runId, acceptedTaps: 2, pendingTaps: 0, rejectedTaps: 8, interrupted: false });
  assert.equal(f.client.snapshot().pendingTaps, 0);
  await f.client.flush();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 2);
  f.client.dispose();
});

test("API rejects malformed progress and aborts a caller-cancelled request", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ...progress(), lifetimeTaps: -1 }), {
      headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(gameApi.getGameProgress(), error => error instanceof ApiError && error.status === 502);
    const controller = new AbortController();
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.cache, "no-store");
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    };
    const request = gameApi.getGameProgress(controller.signal);
    controller.abort();
    await assert.rejects(request, error => error.name === "AbortError");
  } finally { globalThis.fetch = originalFetch; }
});


test("a slow initial handshake queues only the bounded initial burst", async () => {
  let resolveStart;
  const f = fixture({ session: () => new Promise(resolve => { resolveStart = resolve; }) });
  f.client.recordTap(1, runId);
  for (let count = 1; count < 180; count += 1) {
    f.setNow(count * 35);
    f.client.recordTap(1, runId);
  }
  assert.equal(f.client.snapshot().pendingTaps, 60);
  resolveStart({ sessionId, nextSequence: 1, expiresAt: "2026-09-07T10:15:00.000Z", progress: progress() });
  await settle();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 60);
  assert.equal(f.client.snapshot().pendingTaps, 0);
  assert.deepEqual(f.calls.filter(call => call.kind === "batch").map(call => call.body.tapCount), [60]);
  f.client.dispose();
});

test("session renewal preserves the queued taps of the ongoing run", async () => {
  const f = fixture();
  f.client.recordTap(1, runId);
  await settle();
  f.setNow(899_500);
  f.client.recordTap(20, runId);
  f.setNow(900_001);
  await f.client.flush();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 21);
  assert.equal(f.calls.filter(call => call.kind === "session").length, 2);
  f.client.dispose();
});


test("server run count replaces local accumulation when a network gap splits the series", async () => {
  let calls = 0;
  const f = fixture({ batch: async body => {
    calls += 1;
    return { sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, runTaps: body.tapCount,
      rejectedTaps: 0, replayed: false, progress: progress({ lifetimeTaps: calls * 20, bestSeries: 20 }) };
  } });
  f.client.recordTap(20, runId);
  await settle();
  f.setNow(14_000);
  f.client.recordTap(20, runId);
  await f.client.flush();
  assert.equal(f.client.snapshot().run.acceptedTaps, 20);
  assert.equal(f.client.snapshot().run.interrupted, true);
  assert.equal(f.client.snapshot().progress.bestSeries, 20);
  f.client.dispose();
});

test("a terminal rejected batch is reported while later observed taps stay queued", async () => {
  let rejectBatch;
  const f = fixture({ batch: () => new Promise((_resolve, reject) => { rejectBatch = reject; }) });
  f.client.recordTap(4, runId);
  await settle();
  f.client.recordTap(9, runId);
  rejectBatch(new ApiError("conflict", 409, { code: "GAME_SEQUENCE_CONFLICT", message: "conflict" }));
  await settle();
  assert.equal(f.client.snapshot().pendingTaps, 13);
  assert.equal(f.client.snapshot().run.rejectedTaps, 0);
  assert.equal(f.client.snapshot().status, "error");
  f.client.dispose();
});

test("pending accounting follows the latest run while older replies are drained", async () => {
  let resolveBatch;
  let total = 0;
  const f = fixture({ batch: body => new Promise(resolve => { resolveBatch = () => {
    total += body.tapCount;
    resolve({ sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, runTaps: body.tapCount,
      rejectedTaps: 0, replayed: false, progress: progress({ lifetimeTaps: total, bestSeries: body.tapCount }) });
  }; }) });
  f.client.recordTap(4, runId);
  await settle();
  f.client.recordTap(9, requestId);
  assert.equal(f.client.snapshot().pendingTaps, 13);
  assert.deepEqual(f.client.snapshot().run, { runId: requestId, acceptedTaps: 0, pendingTaps: 9, rejectedTaps: 0, interrupted: false });
  resolveBatch();
  await settle();
  assert.equal(f.client.snapshot().run.acceptedTaps, 0);
  resolveBatch();
  await settle();
  assert.equal(f.client.snapshot().run.acceptedTaps, 9);
  assert.equal(f.client.snapshot().run.pendingTaps, 0);
  f.client.dispose();
});


test("a requested flush resolves only after the in-flight batch and its queued tail", async () => {
  const completions = [];
  const f = fixture({ batch: body => new Promise(resolve => completions.push(() => resolve({
    sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, runTaps: body.tapCount,
    rejectedTaps: 0, replayed: false, progress: progress(),
  }))) });
  f.client.recordTap(3, runId);
  await settle();
  f.client.recordTap(7, requestId);
  let drained = false;
  const waiting = f.client.flush().then(() => { drained = true; });
  completions.shift()();
  await settle();
  assert.equal(drained, false);
  assert.equal(f.client.snapshot().pendingTaps, 7);
  completions.shift()();
  await waiting;
  assert.equal(drained, true);
  assert.equal(f.client.snapshot().pendingTaps, 0);
  f.client.dispose();
});


function integratedFixture(context, { delayedStart = false, firstBatchDelay = 0 } = {}) {
  const epoch = Date.parse("2026-09-07T10:00:00Z");
  context.mock.timers.enable({ apis: ["Date"], now: epoch });
  identities.resetDevStoreForTests();
  devGame.resetDevGameStoreForTests();
  const player = identities.createDevIdentity("Player", crypto.randomUUID(), "Europe/Moscow");
  const ok = result => { assert.equal(result.kind, "ok", JSON.stringify(result)); return result.value; };
  let clock = 0;
  const advance = ms => { clock += ms; context.mock.timers.setTime(epoch + clock); };
  let finishStart;
  const batches = [];
  const client = new GameSyncClient(player.me.user.publicId, true, () => {}, () => assert.fail("owner changed"), {
    progress: async () => ok(devGame.getDevGameProgress(player.token)),
    session: body => {
      const granted = ok(devGame.createDevGameSession(player.token, body.ownerPublicId, body.requestId));
      return delayedStart ? new Promise(resolve => { finishStart = () => resolve({ ...granted, progress: { ...granted.progress, serverTime: new Date().toISOString() } }); }) : Promise.resolve(granted);
    },
    batch: async body => {
      if (batches.length === 0) advance(firstBatchDelay);
      const result = ok(devGame.submitDevGameBatch(player.token, body));
      batches.push({ ...body, at: clock, accepted: result.acceptedTaps });
      return result;
    },
  }, () => clock, () => crypto.randomUUID(), async delayMs => { advance(delayMs); });
  return { client, batches, advance, finishStart: () => finishStart() };
}

test("pacing drains 180 offline LTE taps through a granted modern permit without artificial rejects", async context => {
  const f = integratedFixture(context, { delayedStart: true });
  f.client.recordTap(1, runId); f.finishStart(); await f.client.flush();
  f.client.setOnline(false);
  for (let count = 1; count < 180; count += 1) {
    f.advance(35); assert.equal(f.client.recordTap(1, runId), 1);
  }
  f.client.setOnline(true); await f.client.flush();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 180);
  assert.equal(f.client.snapshot().progress.bestSeries, 180);
  assert.equal(f.client.snapshot().run.acceptedTaps, 180);
  assert.equal(f.client.snapshot().rejectedTaps, 0);
  assert.deepEqual(f.batches.map(item => item.tapCount), [1, 60, 60, 59]);
  assert.ok(f.batches[2].at - f.batches[1].at >= 2_000);
  assert.ok(f.batches[3].at - f.batches[2].at >= 2_000);
  f.client.dispose();
});

test("a delayed request arrival cannot refill the client budget before its acknowledgment", async context => {
  const f = integratedFixture(context, { firstBatchDelay: 3_000 });
  f.client.recordTap(60, runId);
  await settle();
  f.advance(2000);
  f.client.recordTap(60, runId);
  await f.client.flush();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 120);
  assert.equal(f.client.snapshot().rejectedTaps, 0);
  assert.deepEqual(f.batches.map(item => [item.at, item.accepted]), [[3_000, 60], [5_000, 60]]);
  f.client.dispose();
});

test("719 observed taps at 20 per second become exactly the saved run, record and month score", async context => {
  const f = integratedFixture(context);
  for (let count = 1; count <= 719; count += 1) {
    f.advance(50);
    assert.equal(f.client.recordTap(1, runId), 1);
    if (count % 15 === 0) await f.client.flush();
  }
  await f.client.flush();
  const saved = f.client.snapshot();
  assert.equal(saved.progress.lifetimeTaps, 719);
  assert.equal(saved.progress.monthlyTaps, 719);
  assert.equal(saved.progress.bestSeries, 719);
  assert.deepEqual(saved.run, { runId, acceptedTaps: 719, pendingTaps: 0, rejectedTaps: 0, interrupted: false });
  assert.ok(f.batches.every(item => item.tapCount <= 60));
  f.client.dispose();
});


test("a committed batch whose receipt was purged is never replayed under a new session", async () => {
  let attempts = 0;
  let committed = 0;
  const sent = [];
  const f = fixture({
    progress: async () => progress({ lifetimeTaps: committed, monthlyTaps: committed, bestSeries: committed }),
    batch: async body => {
      attempts += 1;
      sent.push({ ...body });
      if (attempts === 1) {
        committed += body.tapCount;
        throw new Error("response lost after commit");
      }
      if (attempts === 2) throw new ApiError("gone", 410, { code: "GAME_SESSION_GONE", message: "gone" });
      assert.fail("a committed batch was resubmitted after its receipt was gone");
    },
  });
  f.client.recordTap(9, runId);
  await settle();
  assert.equal(committed, 9);
  assert.equal(f.client.snapshot().pendingTaps, 9);
  f.setNow(3_000);
  await f.client.flush();
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(f.client.snapshot().pendingTaps, 9);
  assert.equal(f.client.snapshot().run.rejectedTaps, 0);
  assert.equal(f.client.snapshot().status, "error");
  f.setNow(6_000);
  await f.client.flush();
  f.setNow(9_000);
  await f.client.refresh();
  assert.equal(attempts, 2);
  assert.equal(f.calls.filter(call => call.kind === "session").length, 1);
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 9);
  assert.equal(committed, 9);
  f.client.dispose();
});

test("permanent items survive out-of-order progress and an older server snapshot", () => {
  const f = fixture();
  f.client.adoptProgress(progress({ items: ["leaf_garland"], serverTime: "2026-09-07T10:01:00.000Z" }));
  f.client.adoptProgress(progress({ items: ["flower"] }));
  f.client.adoptProgress(progress({ items: [], serverTime: "2026-09-07T10:02:00.000Z" }));
  assert.deepEqual(f.client.snapshot().progress.items, ["leaf_garland", "flower"]);
  f.client.dispose();
});

test("new client reads old monthly responses and explicitly asks for the expanded catalog", async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ ownerPublicId: owner, scope: "global", month: "2026-09", serverTime: "2026-09-07T10:00:00Z",
      entries: [{ rank: 1, displayName: "Owner", taps: 5, isMe: true }], myRank: 1, monthlyTaps: 5, leaderboardOptIn: true });
    assert.equal((await gameApi.getGameLeaderboard()).entries[0].score, 5);
    globalThis.fetch = async url => {
      assert.equal(url, "/api/v1/game/achievements?catalog=3");
      return Response.json({ ownerPublicId: owner, serverTime: "2026-09-07T10:00:00Z",
        achievements: [["seven_day_streak",7],["thousand_taps",1000],["five_friends",5]].map(([id,target]) => ({ id, target, progress: 0, unlockedAt: null })) });
    };
    assert.equal((await gameApi.getGameAchievements()).achievements.length, 3);
  } finally { globalThis.fetch = oldFetch; }
});

test("durable outbox survives lost acknowledgment, offline taps and two reloads without double credit", async context => {
  const epoch = Date.parse("2026-09-07T10:00:00Z");
  context.mock.timers.enable({ apis: ["Date"], now: epoch });
  identities.resetDevStoreForTests(); devGame.resetDevGameStoreForTests();
  const player = identities.createDevIdentity("Durable", crypto.randomUUID(), "UTC");
  let clock = 0, persisted = null, loseReply = true;
  const bodies = [];
  const advance = ms => { clock += ms; context.mock.timers.setTime(epoch + clock); };
  const journal = { read: () => structuredClone(persisted), write: value => { persisted = structuredClone(value); } };
  const ok = value => { assert.equal(value.kind, "ok", JSON.stringify(value)); return value.value; };
  const api = {
    progress: async () => ok(devGame.getDevGameProgress(player.token)),
    session: async body => ok(devGame.createDevGameSession(player.token, body.ownerPublicId, body.requestId)),
    batch: async body => {
      assert.deepEqual(persisted.pendingBatch, body, "write-ahead must precede network dispatch");
      bodies.push(structuredClone(body));
      const result = ok(devGame.submitDevGameBatch(player.token, body));
      if (loseReply) { loseReply = false; throw new Error("lost ACK"); }
      return result;
    },
  };
  const make = online => new GameSyncClient(player.me.user.publicId, online, () => {}, () => assert.fail("session lost"), api,
    () => clock, () => crypto.randomUUID(), async delay => advance(delay), journal, () => epoch + clock);
  let client = make(true);
  client.recordTap(1, runId); await settle();
  assert.equal(client.snapshot().pendingTaps, 1);
  client.setOnline(false);
  for (let i = 0; i < 20; i++) { advance(100); assert.equal(client.recordTap(1, runId), 1); }
  client.dispose();
  client = make(false);
  assert.equal(client.snapshot().pendingTaps, 21);
  advance(20 * 60_000); // Delivery after permit expiry preserves the original event-time run.
  assert.equal(client.recordTap(1, runId), 0);
  client.setOnline(true); await client.flush();
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(client.snapshot().pendingTaps, 0);
  assert.equal(client.snapshot().progress.lifetimeTaps, 21);
  assert.equal(client.snapshot().progress.bestSeries, 21);
  assert.equal(client.snapshot().run.interrupted, false);
  client.dispose();
  client = make(true);
  await client.flush();
  assert.equal(client.snapshot().progress.lifetimeTaps, 21);
  assert.equal(bodies.length, 3);
  client.dispose();
});

test("Retry-After survives reload and online/focus cannot bypass account throttling", async () => {
  let clock = 0, persisted = null, attempts = 0;
  const journal = { read: () => structuredClone(persisted), write: value => { persisted = structuredClone(value); } };
  const api = { progress: async () => progress(), session: async () => {
    attempts++; throw new ApiError("wait", 429, { code: "RATE_LIMITED", message: "wait" }, null, 60_000);
  }, batch: async () => assert.fail("no permit") };
  const make = () => new GameSyncClient(owner, true, () => {}, () => {}, api, () => clock, () => requestId,
    async ms => { clock += ms; }, journal, () => 100000 + clock);
  let client = make(); client.recordTap(1, runId); await settle(); client.dispose();
  client = make(); clock = 10_000;
  client.setOnline(false); client.setOnline(true); await client.flush(); await client.refresh();
  assert.equal(attempts, 1);
  assert.equal(client.snapshot().pendingTaps, 1);
  clock = 60_000; await client.flush(); assert.equal(attempts, 2); client.dispose();
});

test("unreadable journal is retained and storage failure stops new counted taps", () => {
  let writes = 0;
  const client = new GameSyncClient(owner, true, () => {}, () => {}, undefined, undefined, undefined, undefined,
    { read: () => { throw new Error("corrupt journal"); }, write: () => { writes++; } });
  assert.equal(client.recordTap(1, runId), 0);
  assert.equal(client.snapshot().errorCode, "STORAGE_FAILED");
  client.dispose(); assert.equal(writes, 0);
});

test("journal validates account ownership and never imports another player's outbox", async () => {
  const { gameJournalStore } = await vite.ssrLoadModule("/lib/game-sync-journal.ts");
  let raw = null;
  const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
  const first = gameJournalStore(owner, storage);
  const client = new GameSyncClient(owner, false, () => {}, () => {}, undefined, undefined, undefined, undefined, first);
  client.dispose();
  assert.throws(() => gameJournalStore(otherOwner, storage).read(), /owner mismatch/);
});

test("wall clock changes never reverse queued event timestamps and sleep ends the offline permit", async () => {
  let clock = 0, wall = Date.parse("2026-09-07T10:00:00Z");
  const batches = [];
  const api = {
    progress: async () => progress(),
    session: async () => ({ sessionId, nextSequence: 1, startedAt: progress().serverTime, expiresAt: "2026-09-07T10:15:00.000Z", progress: progress() }),
    batch: async body => { batches.push(body); return { sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, rejectedTaps: 0, runTaps: body.tapCount, replayed: false, progress: progress() }; },
  };
  const client = new GameSyncClient(owner, true, () => {}, () => {}, api, () => clock, () => requestId,
    async ms => { clock += ms; wall += ms; }, undefined, () => wall);
  client.recordTap(1, runId); await client.flush();
  client.setOnline(false);
  clock += 1000; wall += 1000; client.recordTap(1, runId);
  clock += 1000; wall -= 60000; client.recordTap(1, runId);
  client.setOnline(true); await client.flush();
  assert.ok(batches.at(-1).tapTimes[1] >= batches.at(-1).tapTimes[0]);
  client.setOnline(false); wall += 21 * 60_000; // performance timer was paused by sleep.
  assert.equal(client.recordTap(1, runId), 0);
  client.dispose();
});

test("lost session opening reply remains recoverable after another device takes over", async context => {
  const epoch = Date.parse("2026-09-07T10:00:00Z");
  context.mock.timers.enable({ apis: ["Date"], now: epoch });
  identities.resetDevStoreForTests(); devGame.resetDevGameStoreForTests();
  const bootstrapKey = crypto.randomUUID();
  const player = identities.createDevIdentity("Original", bootstrapKey, "UTC");
  const other = identities.createDevIdentity("Other", bootstrapKey, "UTC");
  let clock = 0, lost = true;
  const advance = ms => { clock += ms; context.mock.timers.setTime(epoch + clock); };
  const ok = value => {
    if (value.kind !== "ok") throw new ApiError("blocked", 409, { code: value.code, message: "blocked" });
    return value.value;
  };
  const api = {
    progress: async () => ok(devGame.getDevGameProgress(player.token)),
    session: async body => { const value = ok(devGame.createDevGameSession(player.token, body.ownerPublicId, body.requestId)); if (lost) { lost = false; throw new Error("open reply lost"); } return value; },
    batch: async body => ok(devGame.submitDevGameBatch(player.token, body)),
  };
  const client = new GameSyncClient(player.me.user.publicId, true, () => {}, () => assert.fail("session lost"), api,
    () => clock, () => crypto.randomUUID(), async ms => advance(ms), undefined, () => epoch + clock);
  client.recordTap(1, runId); await settle();
  advance(31000); ok(devGame.createDevGameSession(other.token, other.me.user.publicId, crypto.randomUUID()));
  await client.flush(); // Opens the original permit receipt and delivers its initial tap, then waits for writer.
  assert.equal(client.snapshot().progress.lifetimeTaps, 1);
  assert.equal(client.recordTap(1, runId), 0);
  advance(31000); await client.flush();
  assert.equal(client.recordTap(1, runId), 1);
  await client.flush(); assert.equal(client.snapshot().progress.lifetimeTaps, 2);
  client.dispose();
});
