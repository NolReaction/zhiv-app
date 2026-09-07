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
after(async () => vite.close());

const owner = "7K3P-2Q9M-W8ZR";
const otherOwner = "8K3P-2Q9M-W8ZR";
const sessionId = "9a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const runId = "4a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const requestId = "5a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const settle = () => new Promise(resolve => setImmediate(resolve));
const progress = (overrides = {}) => ({
  ownerPublicId: owner, lifetimeTaps: 0, bestSeries: 0,
  month: "2026-09", monthlyTaps: 0, leaderboardOptIn: false,
  visibilityVersion: 0, serverTime: "2026-09-07T10:00:00.000Z", ...overrides,
});
function fixture(overrides = {}) {
  let now = 0;
  let saved = progress();
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
      saved = progress({ lifetimeTaps: saved.lifetimeTaps + body.tapCount, monthlyTaps: saved.monthlyTaps + body.tapCount });
      return { sessionId: body.sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, rejectedTaps: 0, replayed: false, progress: saved };
    },
    ...overrides,
  };
  const client = new GameSyncClient(owner, true, value => snapshots.push(value), () => { lost += 1; }, api, () => now, () => requestId);
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

test("retries an unknown result with exactly the same batch and excludes taps played during failure", async () => {
  const batches = [];
  const f = fixture({ batch: async body => {
    batches.push({ ...body });
    if (batches.length === 1) throw new Error("response lost after commit");
    return { sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, rejectedTaps: 0, replayed: true,
      progress: progress({ lifetimeTaps: body.tapCount, monthlyTaps: body.tapCount }) };
  } });
  f.client.recordTap(3, runId);
  await settle();
  assert.equal(f.client.snapshot().status, "error");
  f.client.recordTap(50, runId);
  assert.equal(f.client.snapshot().pendingTaps, 3);
  f.setNow(3_000);
  await f.client.flush();
  assert.deepEqual(batches[0], batches[1]);
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 3);
  assert.equal(f.client.snapshot().pendingTaps, 0);
  f.client.dispose();
});

test("does not queue offline taps or exceed the bounded startup window", async () => {
  let resolveStart;
  const f = fixture({ session: () => new Promise(resolve => { resolveStart = resolve; }) });
  f.client.recordTap(1, runId);
  f.client.recordTap(1_000, runId);
  assert.equal(f.client.snapshot().pendingTaps, 60);
  f.setNow(6_000);
  resolveStart({ sessionId, nextSequence: 1, expiresAt: "2026-09-07T10:15:00.000Z", progress: progress() });
  await settle();
  assert.equal(f.calls.filter(call => call.kind === "batch").length, 0);
  assert.equal(f.client.snapshot().pendingTaps, 0);
  f.client.setOnline(false);
  f.client.recordTap(20, runId);
  assert.equal(f.client.snapshot().pendingTaps, 0);
  assert.equal(f.client.snapshot().status, "offline");
  f.client.dispose();
});

test("keeps one write in flight and never combines different runs in a batch", async () => {
  let resolveBatch;
  const batches = [];
  const f = fixture({ batch: body => {
    batches.push({ ...body });
    return new Promise(resolve => { resolveBatch = () => resolve({ sessionId, sequence: body.sequence,
      acceptedTaps: body.tapCount, rejectedTaps: 0, replayed: false, progress: progress() }); });
  } });
  f.client.recordTap(1, runId);
  await settle();
  f.client.recordTap(2, requestId);
  await Promise.all([f.client.flush(), f.client.flush()]);
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

test("discards expired-session taps and creates a fresh session only for future taps", async () => {
  let attempts = 0;
  const f = fixture({ batch: async body => {
    attempts += 1;
    if (attempts === 1) throw new ApiError("expired", 409, { code: "GAME_SESSION_EXPIRED", message: "expired" });
    return { sessionId, sequence: body.sequence, acceptedTaps: body.tapCount, rejectedTaps: 0, replayed: false, progress: progress({ lifetimeTaps: body.tapCount }) };
  } });
  f.client.recordTap(10, runId);
  await settle();
  assert.equal(f.client.snapshot().pendingTaps, 0);
  f.setNow(3_000);
  f.client.recordTap(1, runId);
  await settle();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 1);
  assert.equal(f.calls.filter(call => call.kind === "session").length, 2);
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
    acceptedTaps: 2, rejectedTaps: body.tapCount - 2, replayed: false,
    progress: progress({ lifetimeTaps: 2, monthlyTaps: 2 }) }) });
  f.client.recordTap(10, runId);
  await settle();
  assert.equal(f.client.snapshot().progress.lifetimeTaps, 2);
  assert.equal(f.client.snapshot().pendingTaps, 0);
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
