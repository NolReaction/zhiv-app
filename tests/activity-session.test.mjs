import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createActivitySession } = await vite.ssrLoadModule("/features/activity/session.ts");
const { commandDevPresence, isDevPresenceActive } = await vite.ssrLoadModule("/lib/dev/activity-store.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const instant = Date.parse("2026-10-07T12:00:00Z");
function fixture(overrides = {}) {
  let time = instant; const sent = [], connected = []; const owner = crypto.randomUUID();
  const session = createActivitySession({ now: () => time, send: async command => { sent.push({ ...command }); return commandDevPresence(owner, command, time); },
    reconcile: async () => true, connected: id => connected.push(id), sessionLost: () => assert.fail("Unexpected auth loss"), ...overrides });
  return { session, sent, connected, owner, setTime: value => { time = instant + value; } };
}
test("five minutes without input ends only the game lease and requires explicit return", async () => {
  const f = fixture(); f.session.start(true, true); await flush(); assert.equal(f.session.getSnapshot().mode, "active");
  assert.equal(f.session.getSnapshot().resumeRequired, false);
  for (let second = 30; second < 300; second += 30) { f.setTime(second * 1000); f.session.check(); await flush(); }
  assert.ok(f.sent.filter(c => c.kind === "heartbeat").every(c => c.active === false));
  f.setTime(300_000); f.session.check(); await flush(); assert.equal(f.session.getSnapshot().mode, "away");
  assert.equal(f.session.getSnapshot().resumeRequired, true);
  const previous = f.sent[0].presenceId;
  f.session.input(); f.session.environment(true, true); await flush(); assert.equal(f.session.getSnapshot().mode, "away");
  await f.session.resume(); assert.equal(f.session.getSnapshot().mode, "active");
  assert.equal(f.session.getSnapshot().resumeRequired, false);
  assert.notEqual(f.sent.at(-1).presenceId, previous);
  assert.equal(isDevPresenceActive(f.owner, previous, instant + 300_000), false);
});
test("input immediately after browser sleep cannot erase an expired idle deadline", async () => {
  const f = fixture(); f.session.start(true, true); await flush();
  f.setTime(301_000); f.session.input(); assert.equal(f.session.getSnapshot().mode, "away");
});
test("offline pauses commands and a short disconnect reconciles before returning", async () => {
  let calls = 0, release;
  const f = fixture({ reconcile: () => ++calls === 1 ? Promise.resolve(true) : new Promise(resolve => { release = resolve; }) });
  f.session.start(true, true); await flush(); f.setTime(20_000); f.session.environment(false, true);
  assert.equal(f.session.getSnapshot().mode, "offline"); assert.equal(f.connected.at(-1), null);
  f.setTime(40_000); f.session.environment(true, true); await flush();
  assert.equal(f.session.getSnapshot().mode, "connecting"); assert.equal(calls, 2);
  release(true); await flush(); assert.equal(f.session.getSnapshot().mode, "active");
});
test("reconciliation failure leaves a usable retry instead of endless loading", async () => {
  let calls = 0;
  const f = fixture({ reconcile: async () => ++calls > 1 }); f.session.start(true, true); await flush();
  assert.equal(f.session.getSnapshot().mode, "error"); assert.equal(f.connected.at(-1), null);
  f.setTime(4000); await f.session.retry(); assert.equal(f.session.getSnapshot().mode, "active");
});
test("persistent reconciliation failure backs off and cannot consume the hourly lease budget through retries", async () => {
  let elapsed = 0;
  const attempts = [];
  const f = fixture({ reconcile: async () => { attempts.push(elapsed); return false; } });
  const stop = f.session.start(true, true);
  try {
    await flush();
    // An attentive player keeps the page awake and presses either retry button;
    // both manual requests and the automatic scheduler must obey one deadline.
    for (elapsed = 1000; elapsed <= 3_600_000; elapsed += 1000) {
      f.setTime(elapsed); f.session.input(); f.session.check();
      await f.session.retry(); await f.session.resume();
      if (f.session.getSnapshot().mode === "connecting") await flush();
      assert.equal(f.session.getSnapshot().mode, "error");
      assert.equal(f.connected.at(-1), null);
    }
    assert.deepEqual(attempts.slice(0, 7), [0, 3000, 9000, 21000, 45000, 93000, 153000]);
    assert.ok(attempts.length >= 60 && attempts.length <= 65, `${attempts.length} attempts must stay below 120 leases per hour`);
    const resumes = f.sent.filter(command => command.kind === "resume");
    assert.equal(new Set(resumes.map(command => command.presenceId)).size, attempts.length);
    assert.equal(f.sent.filter(command => command.kind === "suspend").length, resumes.length);
  } finally { stop(); }
});
test("only a reconciled active connection resets consecutive failure backoff", async () => {
  let ready = false;
  const f = fixture({ reconcile: async () => ready });
  const stop = f.session.start(true, true);
  try {
    await flush(); assert.equal(f.session.getSnapshot().retryAt, instant + 3000);
    f.setTime(3000); await f.session.retry();
    assert.equal(f.session.getSnapshot().retryAt, instant + 9000);
    ready = true; f.setTime(9000); await f.session.retry();
    assert.equal(f.session.getSnapshot().mode, "active");
    ready = false; f.setTime(10_000);
    f.session.environment(false, true); f.session.environment(true, true); await flush();
    assert.equal(f.session.getSnapshot().mode, "error");
    assert.equal(f.session.getSnapshot().retryAt, instant + 13_000);
  } finally { stop(); }
});
test("a server cooldown longer than the client backoff cap survives visibility and manual retry", async () => {
  let sent = 0;
  const f = fixture({ send: async () => { sent++; throw new ApiError("Wait", 429, undefined, undefined, 180_000); } });
  const stop = f.session.start(true, true);
  try {
    await flush(); assert.equal(f.session.getSnapshot().retryAt, instant + 180_000);
    f.setTime(179_999); f.session.environment(true, false); f.session.environment(true, true);
    f.session.check(); await f.session.retry(); await f.session.resume();
    assert.equal(sent, 1);
    f.setTime(180_000); await f.session.retry(); assert.equal(sent, 2);
  } finally { stop(); }
});
test("returning from a hidden page during cooldown automatically reconnects at the deadline", async () => {
  let attempts = 0;
  const owner = crypto.randomUUID();
  const f = fixture({ send: async command => {
    attempts++;
    if (attempts === 1) throw new ApiError("Wait", 429, undefined, undefined, 60_000);
    return commandDevPresence(owner, command, instant + 60_000);
  } });
  const stop = f.session.start(true, true);
  try {
    await flush(); f.setTime(10_000); f.session.environment(true, false);
    f.setTime(30_000); f.session.environment(true, true); f.session.check(); await flush();
    assert.equal(attempts, 1);
    assert.equal(f.session.getSnapshot().mode, "hidden");
    f.setTime(59_999); f.session.check(); await flush(); assert.equal(attempts, 1);
    f.setTime(60_000); f.session.check(); await flush();
    assert.equal(attempts, 2);
    assert.equal(f.session.getSnapshot().mode, "active");
  } finally { stop(); }
});
test("a lost resume response retries the identical lease and sequence", async () => {
  const commands = []; let time = instant;
  const owner = crypto.randomUUID();
  const f = fixture({ now: () => time, send: async command => {
    commands.push({ ...command }); const response = commandDevPresence(owner, command, time);
    if (commands.length === 1) throw new Error("response lost"); return response;
  } });
  f.session.start(true, true); await flush(); time += 4000; await f.session.retry();
  assert.deepEqual(commands[0], commands[1]); assert.equal(f.session.getSnapshot().mode, "active");
});
test("late resume response after offline cannot restart the game", async () => {
  let release; const f = fixture({ send: command => new Promise(resolve => { release = () => resolve(commandDevPresence(crypto.randomUUID(), command, instant)); }) });
  f.session.start(true, true); f.session.environment(false, true); release(); await flush();
  assert.equal(f.session.getSnapshot().mode, "offline"); assert.equal(f.connected.at(-1), null);
});
test("rate limits keep their retry deadline and input cannot bypass it", async () => {
  let sent = 0; const f = fixture({ send: async () => { sent++; throw new ApiError("Wait", 429, undefined, undefined, 60_000); } });
  f.session.start(true, true); await flush(); f.setTime(30_000); f.session.check(); await f.session.resume();
  f.session.environment(false, true); f.session.environment(true, true); f.session.check(); await flush(); assert.equal(sent, 1);
  f.setTime(60_000); f.session.check(); await flush(); assert.equal(sent, 2);
});
test("visible offline input keeps local play active without creating a presence", async () => {
  const f = fixture(); f.session.start(false, true);
  f.setTime(240_000); f.session.input();
  f.setTime(480_000); f.session.input(); f.session.check(); await flush();
  assert.equal(f.session.getSnapshot().mode, "offline");
  assert.equal(f.session.getSnapshot().resumeRequired, false); assert.equal(f.sent.length, 0);
  f.session.environment(true, true); await flush(); assert.equal(f.session.getSnapshot().mode, "active");
});
test("the first offline tap after the idle deadline cannot resume AFK", async () => {
  const f = fixture(); f.session.start(false, true);
  f.setTime(300_000); f.session.input();
  assert.equal(f.session.getSnapshot().mode, "away"); assert.equal(f.session.getSnapshot().resumeRequired, true);
  f.session.environment(true, true); f.session.check(); await f.session.retry();
  assert.equal(f.session.getSnapshot().mode, "away"); assert.equal(f.sent.length, 0);
});
test("failed heartbeats reconnect automatically after backoff with one request in flight", async () => {
  let time = instant, attempts = 0, release;
  const owner = crypto.randomUUID();
  const f = fixture({ now: () => time, send: async command => {
    attempts++;
    if (command.kind === "heartbeat") throw new Error("Connection lost");
    if (attempts === 3) return new Promise(resolve => { release = () => resolve(commandDevPresence(owner, command, time)); });
    return commandDevPresence(owner, command, time);
  } });
  f.session.start(true, true); await flush(); time += 30_000; f.session.check(); await flush();
  assert.equal(f.session.getSnapshot().mode, "error"); assert.equal(attempts, 2);
  time += 2999; f.session.check(); await flush(); assert.equal(attempts, 2);
  time++; f.session.check(); f.session.check(); await flush();
  assert.equal(attempts, 3); assert.equal(f.session.getSnapshot().mode, "connecting");
  release(); await flush(); assert.equal(f.session.getSnapshot().mode, "active");
});
test("explicit AFK return stays paused across errors and offline until reconciliation succeeds", async () => {
  let calls = 0, release;
  const f = fixture({ reconcile: () => {
    calls++;
    if (calls === 1) return Promise.resolve(true);
    if (calls === 2) return Promise.resolve(false);
    return new Promise(resolve => { release = resolve; });
  } });
  f.session.start(true, true); await flush(); f.setTime(300_000); f.session.check();
  await f.session.resume(); assert.equal(f.session.getSnapshot().mode, "error");
  assert.equal(f.session.getSnapshot().resumeRequired, true);
  f.session.environment(false, true); assert.equal(f.session.getSnapshot().mode, "offline");
  assert.equal(f.session.getSnapshot().resumeRequired, true);
  f.setTime(304_000); f.session.environment(true, true); await flush();
  assert.equal(f.session.getSnapshot().mode, "connecting"); assert.equal(f.session.getSnapshot().resumeRequired, true);
  release(true); await flush(); assert.equal(f.session.getSnapshot().mode, "active");
  assert.equal(f.session.getSnapshot().resumeRequired, false);
});
test("input during connection errors and reconciliation counts without bypassing retry deadlines", async () => {
  let calls = 0, release;
  const f = fixture({ reconcile: () => ++calls === 1 ? Promise.resolve(false) : new Promise(resolve => { release = resolve; }) });
  f.session.start(true, true); await flush();
  f.setTime(240_000); f.session.input(); f.session.check(); await flush();
  assert.equal(f.session.getSnapshot().mode, "connecting");
  f.setTime(480_000); f.session.input(); f.session.check();
  assert.equal(f.session.getSnapshot().mode, "connecting");
  release(true); await flush(); assert.equal(f.session.getSnapshot().mode, "active");
});
test("an explicitly requested AFK return retries automatically while keeping the overlay paused", async () => {
  let calls = 0, release;
  const f = fixture({ reconcile: () => {
    calls++;
    if (calls === 1) return Promise.resolve(true);
    if (calls === 2) return Promise.resolve(false);
    return new Promise(resolve => { release = resolve; });
  } });
  f.session.start(true, true); await flush(); f.setTime(300_000); f.session.check(); await f.session.resume();
  f.setTime(302_999); f.session.check(); await flush(); assert.equal(calls, 2);
  f.setTime(303_000); f.session.check(); await flush();
  assert.equal(calls, 3); assert.equal(f.session.getSnapshot().mode, "connecting");
  assert.equal(f.session.getSnapshot().resumeRequired, true);
  release(true); await flush(); assert.equal(f.session.getSnapshot().resumeRequired, false);
});
test("hidden input and failed AFK return do not grant an automatic return after another idle period", async () => {
  let calls = 0;
  const f = fixture({ reconcile: async () => ++calls === 1 });
  f.session.start(true, true); await flush(); f.setTime(300_000); f.session.check();
  await f.session.resume(); assert.equal(f.session.getSnapshot().mode, "error");
  f.session.environment(true, false); f.setTime(540_000); f.session.input(); f.session.check();
  assert.equal(calls, 2); assert.equal(f.session.getSnapshot().mode, "hidden");
  f.setTime(600_000); f.session.check(); f.session.environment(true, true); await f.session.retry();
  assert.equal(f.session.getSnapshot().mode, "away"); assert.equal(calls, 2);
  assert.equal(f.session.getSnapshot().resumeRequired, true);
});
test("server dev presence unions tabs, excludes disconnected gaps and splits UTC days", () => {
  const owner = crypto.randomUUID(), a = crypto.randomUUID(), b = crypto.randomUUID();
  const start = Date.parse("2026-10-07T23:59:40Z");
  const resume = id => ({ kind: "resume", presenceId: id, sequence: 0, active: true });
  const beat = (id, sequence) => ({ kind: "heartbeat", presenceId: id, sequence, active: true });
  commandDevPresence(owner, resume(a), start); commandDevPresence(owner, resume(b), start + 10_000);
  const first = commandDevPresence(owner, beat(a, 1), start + 30_000);
  assert.equal(first.onlineTodaySeconds, 10);
  const second = commandDevPresence(owner, beat(b, 1), start + 40_000);
  assert.equal(second.onlineTodaySeconds, 20, "overlap is credited once");
  const stale = commandDevPresence(owner, beat(a, 2), start + 150_000);
  assert.equal(stale.status, "disconnected"); assert.equal(stale.onlineTodaySeconds, 20);
  assert.equal(commandDevPresence(owner, resume(a), start + 150_000).status, "disconnected");
  assert.equal(isDevPresenceActive(crypto.randomUUID(), b, start + 45_000), false);
});
test("suspension and stale duplicate commands cannot revive an old lease", () => {
  const owner = crypto.randomUUID(), id = crypto.randomUUID();
  commandDevPresence(owner, { kind: "resume", presenceId: id, sequence: 0, active: true }, instant);
  commandDevPresence(owner, { kind: "suspend", presenceId: id, sequence: 1, active: false }, instant + 1000);
  assert.equal(commandDevPresence(owner, { kind: "heartbeat", presenceId: id, sequence: 2, active: true }, instant + 2000).status, "suspended");
  assert.equal(isDevPresenceActive(owner, id, instant + 2000), false);
});

test("a second login cookie cannot use another session's presence", () => {
  const owner = crypto.randomUUID(), id = crypto.randomUUID();
  const command = { kind: "resume", presenceId: id, sequence: 0, active: true };
  commandDevPresence(owner, command, instant, "first-cookie");
  assert.equal(isDevPresenceActive(owner, id, instant + 1000, "first-cookie"), true);
  assert.equal(isDevPresenceActive(owner, id, instant + 1000, "second-cookie"), false);
  assert.throws(() => commandDevPresence(owner, command, instant + 1000, "second-cookie"), /недоступна/);
});

test("real late input renews presence before the idle boundary instead of a false AFK kick", async () => {
  const f = fixture(); f.session.start(true, true); await flush();
  for (let second = 30; second <= 270; second += 30) { f.setTime(second * 1000); f.session.check(); await flush(); }
  f.setTime(290_000); f.session.input(); await flush();
  assert.equal(f.sent.at(-1).active, true); assert.equal(f.sent.at(-1).kind, "heartbeat");
  f.setTime(310_000); f.session.check(); await flush(); assert.equal(f.session.getSnapshot().mode, "active");
});

test("an inactive response from an older lease cannot invalidate a replacement connection", async t => {
  const { setGamePresence, gamePresenceHeaders } = await vite.ssrLoadModule("/features/activity/transport-state.ts");
  const { sendEconomyCommand } = await vite.ssrLoadModule("/features/economy/sync/api.ts");
  const previousWindow = globalThis.window, browser = new EventTarget(); let expired = 0, answer, seen;
  globalThis.window = browser; browser.addEventListener("zhiv:presence-expired", () => expired++);
  t.after(() => { setGamePresence(null); if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  t.mock.method(globalThis, "fetch", (_, init) => { seen = init.headers["X-Game-Presence"]; return new Promise(resolve => { answer = resolve; }); });
  setGamePresence("old"); const pending = sendEconomyCommand({}); setGamePresence("new");
  answer(Response.json({ code: "GAME_SESSION_INACTIVE", message: "Return" }, { status: 409 }));
  await assert.rejects(pending); assert.equal(seen, "old"); assert.equal(expired, 0);
  assert.equal(gamePresenceHeaders()["X-Game-Presence"], "new");
  const current = sendEconomyCommand({}); answer(Response.json({ code: "GAME_SESSION_INACTIVE", message: "Return" }, { status: 409 }));
  await assert.rejects(current); assert.equal(expired, 1); assert.equal(gamePresenceHeaders()["X-Game-Presence"], undefined);
});
