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
  assert.equal(game.submitDevGameBatch(stranger.token, sent.request).code, "GAME_SESSION_EXPIRED");
  assert.equal(game.createDevGameSession(owner.token, stranger.me.user.publicId, crypto.randomUUID()).code, "GAME_OWNER_CHANGED");
  assert.equal(game.updateDevGameVisibility(owner.token, stranger.me.user.publicId, true, 0).code, "GAME_OWNER_CHANGED");
});

test("multiple sessions share one tap allowance and new sessions cannot refill it", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player();
  const first = session(owner);
  assert.equal(batch(owner, first, 60).value.acceptedTaps, 60);
  const second = session(owner);
  assert.equal(batch(owner, second, 60).value.acceptedTaps, 0);
  context.mock.timers.setTime(Date.now() + 1_000);
  const sent = batch(owner, second, 60, 2).value;
  assert.equal(sent.acceptedTaps, 12);
  assert.equal(sent.rejectedTaps, 48);
  assert.equal(sent.progress.lifetimeTaps, 72);
  assert.equal(sent.progress.monthlyTaps, 72);
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
  for (let index = 0; index < 7; index++) session(owner);
  assert.equal(game.createDevGameSession(owner.token, owner.me.user.publicId, crypto.randomUUID()).code, "GAME_SESSION_LIMIT");
  context.mock.timers.setTime(Date.parse(active.expiresAt));
  assert.equal(game.createDevGameSession(owner.token, owner.me.user.publicId, key).code, "GAME_SESSION_EXPIRED");
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
  assert.deepEqual(Object.keys(board.entries[0]).sort(), ["displayName", "isMe", "rank", "taps"]);
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
  const parallel = session(owner);
  batch(owner, parallel, 5, 1, run);
  context.mock.timers.setTime(Date.now() + 1_000);
  // A second successor starts its own run instead of reusing the already-claimed 450 taps.
  assert.equal(batch(owner, parallel, 6, 2, run).value.progress.bestSeries, 455);
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
  context.mock.timers.setTime(Date.now() + 12_001);
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
  const successor = session(owner);
  context.mock.timers.setTime(Date.now() + 100);
  assert.equal(batch(owner, successor, 1, 1, run).value.progress.bestSeries, 61);
  context.mock.timers.setTime(Date.now() + 100);
  assert.equal(batch(owner, waiting, 1, 2, run).value.progress.bestSeries, 61);
});
