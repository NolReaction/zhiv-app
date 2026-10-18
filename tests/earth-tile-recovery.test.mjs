import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { createEarthTileRecovery } = await vite.ssrLoadModule("/features/earth/tile-recovery.ts");
after(() => vite.close());

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
async function flush() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }
function fakeClock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    count: () => timers.size,
    async advance(milliseconds) {
      const until = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].due; next[1].callback(); await flush();
      }
      now = until; await flush();
    },
  };
}
function fixture(options = {}) {
  const state = { enabled: true, visible: true, online: true, moving: false, ready: true, pending: 0, progress: 10, ...options.state };
  const clock = fakeClock(), calls = [], statuses = [];
  let recovery;
  recovery = createEarthTileRecovery({
    readState: () => state,
    sources: () => ["streets", "land"],
    clock,
    onChange: status => statuses.push(status),
    async refresh(targets, signal) {
      calls.push({ targets, signal });
      if (options.refresh) await options.refresh({ recovery, state, targets, signal });
      else { state.ready = false; state.pending = 1; }
    },
  });
  return { recovery, state, clock, calls, statuses };
}
const tile = (x = 1, y = 2, z = 3) => ({ tileID: { canonical: { x, y, z } } });

test("renderer errors deduplicate canonical tiles and preserve source-level failures", async t => {
  const s = fixture(); t.after(() => s.recovery.dispose());
  s.recovery.reportFailure({ sourceId: "streets", tile: tile() });
  s.recovery.reportFailure({ sourceId: "streets", tile: tile() });
  s.recovery.reportFailure({ sourceId: "streets", tile: tile(2) });
  s.recovery.reportFailure({ sourceId: "land" });
  s.recovery.reportFailure({ sourceId: "land", tile: tile() });
  await s.clock.advance(1_199); assert.equal(s.calls.length, 0);
  await s.clock.advance(1);
  assert.deepEqual(s.calls[0].targets, [
    { sourceId: "streets", tiles: [{ x: 1, y: 2, z: 3 }, { x: 2, y: 2, z: 3 }] },
    { sourceId: "land" },
  ]);
});

test("malformed canonical IDs fall back to their source rather than throwing inside Map.refreshTiles", async t => {
  for (const bad of [tile(-1), tile(8), tile(1, 2, 26), tile(1.1), {}, null]) {
    const s = fixture(); t.after(() => s.recovery.dispose());
    s.recovery.reportFailure({ sourceId: "streets", tile: bad });
    await s.clock.advance(1_200);
    assert.deepEqual(s.calls[0].targets, [{ sourceId: "streets" }]);
  }
});

test("prolonged failed panning bounds retained tile IDs and refreshes the visible source instead", async t => {
  const s = fixture(); t.after(() => s.recovery.dispose());
  for (let x = 0; x < 256; x += 1) s.recovery.reportFailure({ sourceId: "streets", tile: tile(x, 0, 8) });
  await s.clock.advance(1_200);
  assert.deepEqual(s.calls[0].targets, [{ sourceId: "streets" }]);
});

test("unknown explicit errors broaden only to the supplied tile sources", async t => {
  const s = fixture(); t.after(() => s.recovery.dispose());
  await s.clock.advance(90_000); assert.equal(s.calls.length, 0);
  s.recovery.reportFailure({});
  await s.clock.advance(1_200);
  assert.deepEqual(s.calls[0].targets, [{ sourceId: "streets" }, { sourceId: "land" }]);
});

test("errored tiles counting as loaded cannot dismiss an incident before a repair and fresh settlement", async t => {
  const s = fixture({ refresh() {} }); t.after(() => s.recovery.dispose());
  s.recovery.reportFailure({ sourceId: "streets", tile: tile() });
  s.recovery.check(true);
  assert.equal(s.statuses.at(-1), "waiting");
  await s.clock.advance(1_200);
  assert.equal(s.calls.length, 1);
  assert.equal(s.statuses.at(-1), "retrying");
  s.recovery.check();
  assert.equal(s.statuses.at(-1), "retrying", "the old loaded flag does not prove recovery");
  s.recovery.check(true);
  assert.equal(s.statuses.at(-1), "idle", "a later idle confirms no visible work remains");
});

test("successful resource progress with a fully settled map clears the incident and grants a fresh future budget", async t => {
  const s = fixture(); t.after(() => s.recovery.dispose());
  s.recovery.reportFailure({ sourceId: "streets", tile: tile() });
  await s.clock.advance(1_200);
  s.state.progress += 1; s.recovery.check();
  assert.notEqual(s.statuses.at(-1), "idle", "resource completion alone cannot reveal unfinished rendering");
  s.state.pending = 0; s.state.ready = true; s.recovery.check();
  assert.equal(s.statuses.at(-1), "idle");
  s.recovery.reportFailure({ sourceId: "land" });
  await s.clock.advance(1_200);
  assert.deepEqual(s.calls[1].targets, [{ sourceId: "land" }]);
});

test("new errors during a pass are not cleared by unrelated resource progress or idle", async t => {
  const s = fixture({ refresh({ recovery, state }) {
    state.progress += 1;
    recovery.reportFailure({ sourceId: "streets", tile: tile() });
    recovery.check(true);
  } }); t.after(() => s.recovery.dispose());
  s.recovery.reportFailure({ sourceId: "streets", tile: tile() });
  await s.clock.advance(1_200);
  assert.equal(s.statuses.at(-1), "waiting");
  await s.clock.advance(1_200);
  assert.equal(s.statuses.at(-1), "failed");
  await s.clock.advance(300_000);
  assert.equal(s.calls.length, 2, "automatic failures have a finite budget");
  s.recovery.retry();
  await s.clock.advance(2_400);
  assert.equal(s.calls.length, 4, "an explicit retry or connection restoration opens one fresh budget");
  assert.equal(s.statuses.at(-1), "failed");
});

test("hidden, offline, and moving maps postpone repairs without spending their retry budget", async t => {
  const s = fixture(); t.after(() => s.recovery.dispose());
  s.recovery.reportFailure({ sourceId: "streets", tile: tile() });
  for (const [property, blocked, permitted] of [["visible", false, true], ["online", false, true], ["moving", true, false]]) {
    s.state[property] = blocked; s.recovery.check();
    await s.clock.advance(60_000);
    assert.equal(s.calls.length, 0);
    s.state[property] = permitted; s.recovery.check();
  }
  await s.clock.advance(1_200);
  assert.equal(s.calls.length, 1);
});

test("the watchdog waits for sustained lack of progress and does not replace the map", async t => {
  const s = fixture({ state: { ready: false, pending: 1 } }); t.after(() => s.recovery.dispose());
  await s.clock.advance(20_000); assert.equal(s.calls.length, 0);
  await s.clock.advance(2_200);
  assert.deepEqual(s.calls[0].targets, [{ sourceId: "streets" }, { sourceId: "land" }]);
  await s.clock.advance(150_000);
  assert.equal(s.calls.length, 2, "unresolved stalls also exhaust after two passes");
  assert.equal(s.statuses.at(-1), "failed");
});

test("progress and disabled initial preparation postpone the watchdog", async t => {
  const s = fixture({ state: { enabled: false, ready: false, pending: 1 } }); t.after(() => s.recovery.dispose());
  s.recovery.reportFailure({ sourceId: "streets" });
  await s.clock.advance(120_000); assert.equal(s.calls.length, 0);
  s.state.enabled = true; s.recovery.check();
  for (let index = 0; index < 5; index += 1) {
    await s.clock.advance(15_000);
    s.state.progress += 1; s.recovery.check();
  }
  assert.equal(s.calls.length, 0);
  await s.clock.advance(25_000);
  assert.equal(s.calls.length, 1);
});

test("a rejected repair callback is contained and retried only twice", async t => {
  const s = fixture({ refresh() { throw new Error("source disappeared"); } }); t.after(() => s.recovery.dispose());
  s.recovery.reportFailure({ sourceId: "streets" });
  await s.clock.advance(90_000);
  assert.equal(s.calls.length, 2);
  assert.equal(s.statuses.at(-1), "failed");
});

test("disposal cancels queued timers and fences a pending cache repair before it touches a removed map", async () => {
  const gate = deferred(); let mapRefreshes = 0;
  const s = fixture({ async refresh({ signal }) {
    await gate.promise;
    if (!signal.aborted) mapRefreshes += 1;
  } });
  s.recovery.reportFailure({ sourceId: "streets" });
  await s.clock.advance(1_200);
  assert.equal(s.calls.length, 1);
  const previous = [...s.statuses];
  s.recovery.dispose();
  assert.equal(s.calls[0].signal.aborted, true);
  gate.resolve(); await flush();
  await s.clock.advance(90_000);
  s.recovery.check(true); s.recovery.retry(); s.recovery.reportFailure({});
  assert.equal(mapRefreshes, 0);
  assert.equal(s.clock.count(), 0);
  assert.deepEqual(s.statuses, previous);
});

test("manual retry can recover an incomplete view even when the renderer emitted no error", async t => {
  const s = fixture({ state: { ready: false, pending: 0 } }); t.after(() => s.recovery.dispose());
  s.recovery.retry();
  await s.clock.advance(1_200);
  assert.deepEqual(s.calls[0].targets, [{ sourceId: "streets" }, { sourceId: "land" }]);
});
