import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev-api-store.ts");
const game = await vite.ssrLoadModule("/lib/dev-game-store.ts");
const validation = await vite.ssrLoadModule("/lib/dev-game-validation.ts");
beforeEach(() => { identities.resetDevStoreForTests(); game.resetDevGameStoreForTests(); });
after(() => vite.close());

function ok(result) {
  assert.equal(result.kind, "ok", JSON.stringify(result));
  return result.value;
}
function player(name = "Player", zone = "Europe/Moscow") {
  const bootstrapKey = crypto.randomUUID();
  return { ...identities.createDevIdentity(name, bootstrapKey, zone), bootstrapKey };
}
function session(user, requestId = crypto.randomUUID()) {
  return ok(game.createDevGameSession(user.token, user.me.user.publicId, requestId));
}
function batch(user, active, tapCount, sequence = 1, runId = crypto.randomUUID()) {
  const request = { sessionId: active.sessionId, sequence, tapCount, runId };
  return { request, value: ok(game.submitDevGameBatch(user.token, request)) };
}
function visibility(user, enabled, version) {
  return game.updateDevGameVisibility(user.token, user.me.user.publicId, enabled, version);
}

test("game progress is shared by an account while game sessions are tied to their login session", () => {
  const owner = player();
  const secondDevice = identities.createDevIdentity("Ignored", owner.bootstrapKey);
  const stranger = player("Stranger");
  const active = session(owner);
  const sent = batch(owner, active, 7);
  assert.equal(ok(game.getDevGameProgress(secondDevice.token)).lifetimeTaps, 7);
  assert.equal(ok(game.getDevGameProgress(stranger.token)).lifetimeTaps, 0);
  assert.equal(game.getDevGameProgress(undefined).code, "UNAUTHORIZED");
  assert.equal(game.submitDevGameBatch(secondDevice.token, sent.request).code, "GAME_SESSION_CONFLICT");
  assert.equal(game.submitDevGameBatch(stranger.token, sent.request).code, "GAME_SESSION_GONE");
  assert.equal(game.createDevGameSession(owner.token, stranger.me.user.publicId, crypto.randomUUID()).code, "GAME_OWNER_CHANGED");
  assert.equal(game.updateDevGameVisibility(owner.token, stranger.me.user.publicId, true, 0).code, "GAME_OWNER_CHANGED");
});

test("only one device can acquire the active writer and takeover closes the old live session", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player();
  const first = session(owner);
  const sent = batch(owner, first, 60);
  assert.equal(game.createDevGameSession(owner.token, owner.me.user.publicId, crypto.randomUUID()).code, "GAME_ACTIVE_ELSEWHERE");
  context.mock.timers.setTime(Date.now() + 30_001);
  const second = session(owner);
  assert.equal(batch(owner, second, 60).value.acceptedTaps, 60);
  assert.equal(game.submitDevGameBatch(owner.token, { ...sent.request, sequence: 2 }).code, "GAME_ACTIVE_ELSEWHERE");
  assert.equal(ok(game.submitDevGameBatch(owner.token, sent.request)).replayed, true);
});

test("batch retries return the accepted receipt once, including after expiry, and compare the payload", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player();
  const active = session(owner);
  const sent = batch(owner, active, 9);
  assert.equal(game.submitDevGameBatch(owner.token, { ...sent.request, sequence: 3 }).code, "GAME_SEQUENCE_CONFLICT");
  assert.equal(game.submitDevGameBatch(owner.token, { ...sent.request, tapCount: 10 }).code, "GAME_SEQUENCE_CONFLICT");
  assert.equal(game.submitDevGameBatch(owner.token, { ...sent.request, runId: crypto.randomUUID() }).code, "GAME_SEQUENCE_CONFLICT");
  context.mock.timers.setTime(Date.now() + 16 * 60_000);
  const replayed = ok(game.submitDevGameBatch(owner.token, sent.request));
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.acceptedTaps, 9);
  assert.equal(replayed.progress.lifetimeTaps, 9);
  assert.equal(game.submitDevGameBatch(owner.token, { ...sent.request, sequence: 2 }).code, "GAME_SESSION_EXPIRED");
});

test("a previous batch cannot be replayed after another sequence has been acknowledged", () => {
  const owner = player();
  const active = session(owner);
  const first = batch(owner, active, 5);
  const second = batch(owner, active, 6, 2);
  assert.equal(game.submitDevGameBatch(owner.token, first.request).code, "GAME_SEQUENCE_CONFLICT");
  assert.equal(ok(game.submitDevGameBatch(owner.token, second.request)).progress.lifetimeTaps, 11);
});

test("session creation is idempotent, capped per account, and expires without refreshing its deadline", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player();
  const key = crypto.randomUUID();
  const active = session(owner, key);
  assert.equal(session(owner, key).sessionId, active.sessionId);
  const secondDevice = identities.createDevIdentity("Ignored", owner.bootstrapKey);
  assert.equal(game.createDevGameSession(secondDevice.token, owner.me.user.publicId, key).code, "GAME_SESSION_CONFLICT");
  assert.equal(game.createDevGameSession(owner.token, owner.me.user.publicId, crypto.randomUUID()).code, "GAME_ACTIVE_ELSEWHERE");
  context.mock.timers.setTime(Date.parse(active.expiresAt));
  assert.equal(ok(game.createDevGameSession(owner.token, owner.me.user.publicId, key)).expiresAt, active.expiresAt);
  assert.notEqual(session(owner).sessionId, active.sessionId);
});

test("best series follows a server-bounded run and cannot combine different sessions", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player();
  const active = session(owner);
  const run = crypto.randomUUID();
  batch(owner, active, 20, 1, run);
  context.mock.timers.setTime(Date.now() + 12_000);
  assert.equal(batch(owner, active, 20, 2, run).value.progress.bestSeries, 40);
  context.mock.timers.setTime(Date.now() + 12_001);
  assert.equal(batch(owner, active, 10, 3, run).value.progress.bestSeries, 40);
  context.mock.timers.setTime(Date.now() + 30_001);
  const second = session(owner);
  assert.equal(batch(owner, second, 35, 1, run).value.progress.bestSeries, 40);
  assert.equal(ok(game.getDevGameProgress(owner.token)).lifetimeTaps, 85);
});

test("monthly scores use server UTC and zone changes cannot move taps between months", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T23:59:59Z") });
  const owner = player("Traveller", "Pacific/Kiritimati");
  const active = session(owner);
  assert.equal(active.expiresAt, "2026-10-01T00:00:00.000Z");
  const before = batch(owner, active, 10);
  assert.equal(before.value.progress.month, "2026-09");
  assert.equal(ok(identities.updateDevTimeZone(owner.token, "Etc/GMT+12", crypto.randomUUID())).profile.timeZone, "Etc/GMT+12");
  assert.equal(ok(game.getDevGameProgress(owner.token)).monthlyTaps, 10);
  context.mock.timers.setTime(Date.now() + 1_000);
  const current = ok(game.getDevGameProgress(owner.token));
  assert.equal(current.month, "2026-10");
  assert.equal(current.monthlyTaps, 0);
  assert.equal(current.lifetimeTaps, 10);
  assert.equal(game.submitDevGameBatch(owner.token, { ...before.request, sequence: 2 }).code, "GAME_SESSION_EXPIRED");
  const replay = ok(game.submitDevGameBatch(owner.token, before.request));
  assert.equal(replay.progress.monthlyTaps, 0);
  assert.equal(replay.progress.lifetimeTaps, 10);
  assert.equal(batch(owner, session(owner), 12).value.progress.monthlyTaps, 12);
});

test("leaderboard participation is private by default and stale visibility writes cannot reverse opt-out", () => {
  const owner = player("Owner");
  const other = player("Other");
  batch(owner, session(owner), 10);
  batch(other, session(other), 20);
  assert.deepEqual(ok(game.getDevGameLeaderboard(owner.token)).entries, []);
  assert.equal(ok(visibility(owner, true, 0)).visibilityVersion, 1);
  assert.equal(ok(visibility(owner, true, 0)).visibilityVersion, 1);
  ok(visibility(other, true, 0));
  let board = ok(game.getDevGameLeaderboard(owner.token));
  assert.equal(board.myRank, 2);
  assert.deepEqual(board.entries.map(entry => entry.displayName), ["Other", "Owner"]);
  assert.deepEqual(Object.keys(board.entries[0]).sort(), ["displayName", "isMe", "rank", "score", "taps"]);
  ok(identities.updateDevDisplayName(other.token, "Renamed", crypto.randomUUID()));
  assert.equal(ok(game.getDevGameLeaderboard(owner.token)).entries[0].displayName, "Renamed");
  assert.equal(ok(visibility(owner, false, 1)).visibilityVersion, 2);
  assert.equal(visibility(owner, true, 0).code, "GAME_VISIBILITY_CONFLICT");
  board = ok(game.getDevGameLeaderboard(owner.token));
  assert.equal(board.myRank, null);
  assert.equal(board.monthlyTaps, 10);
  assert.equal(board.leaderboardOptIn, false);
  assert.equal(board.entries.length, 1);
});

test("the top 100 is capped while an opted-in player's own rank remains available below it", () => {
  const owner = player("Below top 100");
  batch(owner, session(owner), 1);
  ok(visibility(owner, true, 0));
  for (let index = 0; index < 101; index++) {
    const other = player(`Other ${index}`);
    batch(other, session(other), 2);
    ok(visibility(other, true, 0));
  }
  const board = ok(game.getDevGameLeaderboard(owner.token));
  assert.equal(board.entries.length, 100);
  assert.equal(board.myRank, 102);
  assert.ok(board.entries.every(entry => !entry.isMe));
  assert.deepEqual(board.entries.map(entry => entry.rank), Array.from({ length: 100 }, (_, index) => index + 1));
});

test("game request validation rejects client totals, times, unexpected fields and invalid counts", () => {
  const owner = player();
  const base = { sessionId: crypto.randomUUID(), runId: crypto.randomUUID(), sequence: 1, tapCount: 60 };
  assert.deepEqual(validation.parseDevGameBatch(base), base);
  for (const extra of [{ lifetimeTaps: 100_000 }, { checkedAt: "2046-01-01T00:00:00Z" }, { timeZone: "UTC" }]) {
    assert.equal(validation.parseDevGameBatch({ ...base, ...extra }), null);
  }
  for (const value of [0, -1, 61, 1.5, "2", Number.MAX_SAFE_INTEGER]) {
    assert.equal(validation.parseDevGameBatch({ ...base, tapCount: value }), null);
  }
  for (const value of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER]) {
    assert.equal(validation.parseDevGameBatch({ ...base, sequence: value }), null);
  }
  assert.equal(validation.parseDevGameBatch({ ...base, runId: "forged" }), null);
  assert.equal(validation.parseDevGameSession({ ownerPublicId: owner.me.user.publicId, requestId: crypto.randomUUID(), localTaps: 5 }), null);
  assert.equal(validation.parseDevGameVisibility({ ownerPublicId: owner.me.user.publicId, expectedVersion: 0, leaderboardOptIn: "true" }), null);
  assert.equal(validation.parseDevGameVisibility({ ownerPublicId: owner.me.user.publicId, expectedVersion: -1, leaderboardOptIn: true }), null);
});


test("an uninterrupted run survives session renewal and its expired predecessor can be claimed only once", context => {
  const started = Date.parse("2026-09-07T10:00:00Z");
  context.mock.timers.enable({ apis: ["Date"], now: new Date(started) });
  const owner = player();
  const first = session(owner);
  const run = crypto.randomUUID();
  for (let index = 0; index < 90; index++) {
    context.mock.timers.setTime(started + index * 10_000);
    batch(owner, first, 5, index + 1, run);
  }
  context.mock.timers.setTime(Date.parse(first.expiresAt));
  const renewed = session(owner);
  const inherited = batch(owner, renewed, 5, 1, run).value;
  assert.equal(inherited.progress.bestSeries, 455);
  assert.equal(inherited.progress.lifetimeTaps, 455);
  assert.equal(game.createDevGameSession(owner.token, owner.me.user.publicId, crypto.randomUUID()).code, "GAME_ACTIVE_ELSEWHERE");
  context.mock.timers.setTime(Date.now() + 1_000);
  assert.equal(batch(owner, renewed, 5, 2, run).value.progress.bestSeries, 460);
});

test("renewing at UTC month end preserves the run while monthly points remain in their own month", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T23:59:59Z") });
  const owner = player();
  const first = session(owner);
  const run = crypto.randomUUID();
  const before = batch(owner, first, 20, 1, run);
  context.mock.timers.setTime(Date.parse(first.expiresAt));
  const after = batch(owner, session(owner), 15, 1, run).value;
  assert.equal(after.progress.month, "2026-10");
  assert.equal(after.progress.monthlyTaps, 15);
  assert.equal(after.progress.lifetimeTaps, 35);
  assert.equal(after.progress.bestSeries, 35);
  const retry = ok(game.submitDevGameBatch(owner.token, before.request));
  assert.equal(retry.replayed, true);
  assert.equal(retry.progress.bestSeries, 35);
  assert.equal(retry.progress.monthlyTaps, 15);
});

test("renewal cannot inherit an idle run or a run from another login session", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T23:59:59Z") });
  const owner = player();
  const secondDevice = identities.createDevIdentity("Ignored", owner.bootstrapKey);
  const first = session(owner);
  const run = crypto.randomUUID();
  batch(owner, first, 20, 1, run);
  context.mock.timers.setTime(Date.parse(first.expiresAt));
  assert.equal(batch(secondDevice, session(secondDevice), 15, 1, run).value.progress.bestSeries, 20);
  context.mock.timers.setTime(Date.now() + 30_001);
  assert.equal(batch(owner, session(owner), 15, 1, run).value.progress.bestSeries, 20);
});

test("a rejected batch does not claim the predecessor before a successor actually accepts taps", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T23:59:59.999Z") });
  const owner = player();
  const first = session(owner);
  const run = crypto.randomUUID();
  batch(owner, first, 60, 1, run);
  context.mock.timers.setTime(Date.parse(first.expiresAt));
  const waiting = session(owner);
  assert.equal(batch(owner, waiting, 1, 1, run).value.acceptedTaps, 0);
  assert.equal(game.createDevGameSession(owner.token, owner.me.user.publicId, crypto.randomUUID()).code, "GAME_ACTIVE_ELSEWHERE");
  context.mock.timers.setTime(Date.now() + 100);
  assert.equal(batch(owner, waiting, 1, 2, run).value.progress.bestSeries, 61);
});


test("a fast manual run saves all 719 taps and returns its confirmed count on every receipt", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player();
  const active = session(owner);
  const run = crypto.randomUUID();
  let accepted = 0;
  for (let sequence = 1; sequence <= 36; sequence++) {
    context.mock.timers.setTime(Date.now() + 1_000);
    const count = Math.min(20, 719 - accepted);
    const sent = batch(owner, active, count, sequence, run);
    accepted += count;
    assert.equal(sent.value.acceptedTaps, count);
    assert.equal(sent.value.rejectedTaps, 0);
    assert.equal(sent.value.runTaps, accepted);
    assert.equal(sent.value.progress.bestSeries, accepted);
    const replay = ok(game.submitDevGameBatch(owner.token, sent.request));
    assert.equal(replay.runTaps, accepted);
    assert.equal(replay.progress.lifetimeTaps, accepted);
  }
  const persisted = ok(game.getDevGameProgress(owner.token));
  assert.equal(persisted.bestSeries, 719);
  assert.equal(persisted.lifetimeTaps, 719);
  assert.equal(persisted.monthlyTaps, 719);
});

test("receipt run counts describe the requested run after a rejection or a server idle split", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player();
  const active = session(owner);
  const firstRun = crypto.randomUUID();
  assert.equal(batch(owner, active, 60, 1, firstRun).value.runTaps, 60);
  const secondRun = crypto.randomUUID();
  const rejected = batch(owner, active, 4, 2, secondRun);
  assert.equal(rejected.value.acceptedTaps, 0);
  assert.equal(rejected.value.runTaps, 0);
  assert.equal(ok(game.submitDevGameBatch(owner.token, rejected.request)).runTaps, 0);
  context.mock.timers.setTime(Date.now() + 1_000);
  assert.equal(batch(owner, active, 20, 3, secondRun).value.runTaps, 20);
  context.mock.timers.setTime(Date.now() + 12_001);
  const reset = batch(owner, active, 10, 4, secondRun).value;
  assert.equal(reset.runTaps, 10);
  assert.equal(reset.progress.bestSeries, 60);
  assert.equal(reset.progress.lifetimeTaps, 90);
});


test("purged receipts cannot be mistaken for expired but uncommitted batches", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player();
  const active = session(owner);
  const sent = batch(owner, active, 9);
  context.mock.timers.setTime(Date.parse(active.expiresAt) + 172_800_001);
  session(owner); // Another active device/session triggers the retention cleanup.
  assert.equal(game.submitDevGameBatch(owner.token, sent.request).code, "GAME_SESSION_GONE");
  assert.equal(ok(game.getDevGameProgress(owner.token)).lifetimeTaps, 9);
  assert.equal(game.submitDevGameBatch(player("Other").token, sent.request).code, "GAME_SESSION_GONE");
});

test("series ranking shares places, persists across months and keeps the top 100 bounded", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T23:59:59Z") });
  const owner = player("Owner"); batch(owner, session(owner), 1); ok(visibility(owner, true, 0));
  for (let i = 0; i < 101; i++) { const peer = player(`Peer ${i}`); batch(peer, session(peer), 2); ok(visibility(peer, true, 0)); }
  const hidden = player("Hidden"); batch(hidden, session(hidden), 60);
  let board = ok(game.getDevGameLeaderboard(owner.token, "global", Date.now(), "best_series"));
  assert.equal(board.metric, "best_series"); assert.equal(board.bestSeries, 1);
  assert.equal(board.entries.length, 100); assert.equal(board.myRank, 102);
  assert.ok(board.entries.every(item => item.rank === 1 && item.score === 2));
  context.mock.timers.setTime(Date.now() + 1_000);
  board = ok(game.getDevGameLeaderboard(owner.token, "global", Date.now(), "best_series"));
  assert.equal(board.myRank, 102); assert.equal(board.monthlyTaps, 0);
  assert.deepEqual(ok(game.getDevGameLeaderboard(owner.token)).entries, []);
  ok(visibility(owner, false, 1));
  assert.equal(ok(game.getDevGameLeaderboard(owner.token, "global", Date.now(), "best_series")).myRank, null);
});
test("ranking metric rejects unknown or repeated parameters", () => {
  assert.equal(validation.parseDevGameMetric(new URLSearchParams()), "monthly_taps");
  assert.equal(validation.parseDevGameMetric(new URLSearchParams("metric=best_series")), "best_series");
  for (const query of ["metric=all", "metric=", "metric=best_series&metric=best_series"]) assert.equal(validation.parseDevGameMetric(new URLSearchParams(query)), null);
});

test("timed batches preserve delayed runs, split at takeover and cannot repeatedly farm the past", context => {
  const start = Date.parse("2026-09-07T10:00:00Z");
  context.mock.timers.enable({ apis: ["Date"], now: start });
  const owner = player(), secondDevice = identities.createDevIdentity("Ignored", owner.bootstrapKey);
  const first = session(owner), runId = crypto.randomUUID();
  const payload = { sessionId: first.sessionId, sequence: 1, runId, tapCount: 1, tapTimes: [start] };
  assert.equal(ok(game.submitDevGameBatch(owner.token, payload)).runTaps, 1);
  assert.equal(game.createDevGameSession(secondDevice.token, owner.me.user.publicId, crypto.randomUUID()).code, "GAME_ACTIVE_ELSEWHERE");
  context.mock.timers.setTime(start + 31_000);
  const second = session(secondDevice);
  assert.equal(batch(secondDevice, second, 1).value.acceptedTaps, 1);
  const delayed = { ...payload, sequence: 2, tapCount: 3, tapTimes: [start + 1000, start + 2000, start + 32000] };
  const result = ok(game.submitDevGameBatch(owner.token, delayed));
  assert.equal(result.acceptedTaps, 2); assert.equal(result.rejectedTaps, 1); assert.equal(result.runTaps, 3);
  assert.equal(result.rejectionCode, "GAME_PERMIT_CLOSED");
  assert.equal(ok(game.submitDevGameBatch(owner.token, delayed)).replayed, true);
  // Delivery-time refill does not replenish the old permit's event-time budget.
  let accepted = 0;
  for (let sequence = 3; sequence < 10; sequence++) {
    context.mock.timers.setTime(Date.now() + 3000);
    accepted += ok(game.submitDevGameBatch(owner.token, { ...payload, sequence, tapCount: 60, tapTimes: Array(60).fill(start + 2000) })).acceptedTaps;
  }
  assert.ok(accepted <= 60);
});

test("future timestamps cannot poison the next packet and an internal idle gap splits a timed run", context => {
  const start = Date.parse("2026-09-07T10:00:00Z");
  context.mock.timers.enable({ apis: ["Date"], now: start });
  const owner = player(), active = session(owner), runId = crypto.randomUUID();
  const payload = { sessionId: active.sessionId, sequence: 1, runId, tapCount: 1, tapTimes: [start + 60000] };
  assert.equal(ok(game.submitDevGameBatch(owner.token, payload)).acceptedTaps, 0);
  context.mock.timers.setTime(start + 20000);
  const result = ok(game.submitDevGameBatch(owner.token, { ...payload, sequence: 2, tapCount: 4, tapTimes: [start, start + 1000, start + 19000, start + 20000] }));
  assert.equal(result.acceptedTaps, 4); assert.equal(result.runTaps, 2); assert.equal(result.progress.bestSeries, 2);
});

test("temporary delivery budget exhaustion is a non-commit and the exact batch succeeds later", context => {
  const start = Date.parse("2026-09-07T10:00:00Z");
  context.mock.timers.enable({ apis: ["Date"], now: start });
  const owner = player(), active = session(owner), runId = crypto.randomUUID();
  context.mock.timers.setTime(start + 4000);
  const payload = { sessionId: active.sessionId, sequence: 1, runId, tapCount: 60, tapTimes: Array(60).fill(start) };
  ok(game.submitDevGameBatch(owner.token, payload));
  const next = { ...payload, sequence: 2, tapTimes: Array(60).fill(start + 3000) };
  assert.equal(game.submitDevGameBatch(owner.token, next).code, "GAME_PACING");
  context.mock.timers.setTime(start + 6000);
  assert.equal(ok(game.submitDevGameBatch(owner.token, next)).acceptedTaps, 60);
});
