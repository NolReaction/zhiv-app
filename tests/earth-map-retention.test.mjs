import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { createEarthMapRetention, EARTH_MAP_RETENTION_MS } = await vite.ssrLoadModule("/features/app/earth-map-retention.ts");
after(() => vite.close());

function fixture() {
  let now = 0, sequence = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const controller = createEarthMapRetention(clock);
  const context = { owner: "owner-a", selected: true, available: true, documentHidden: false };
  return {
    controller, context, timers,
    update(values = {}) { Object.assign(context, values); controller.setContext({ ...context }); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of timers) if (timer.due <= now) { timers.delete(id); timer.callback(); }
    },
  };
}

test("a map mounts only for its selected available owner, without retaining a cold navigation", () => {
  const s = fixture();
  s.update({ selected: false });
  assert.equal(s.controller.getSnapshot().mounted, false);
  s.update({ selected: true });
  assert.deepEqual(s.controller.getSnapshot(), { owner: "owner-a", mounted: true, ready: false, expiresAt: null });
  s.update({ selected: false });
  assert.equal(s.controller.getSnapshot().mounted, false);
  s.controller.reportReady("owner-a", true);
  assert.equal(s.controller.getSnapshot().mounted, false, "a removed map's late completion cannot remount it");
  assert.equal(s.timers.size, 0);
});

test("ready Profile and People round trips preserve one mounted session and cancel expiry on return", () => {
  const s = fixture();
  s.update(); s.controller.reportReady("owner-a", true);
  let removals = 0;
  const unsubscribe = s.controller.subscribe(() => { if (!s.controller.getSnapshot().mounted) removals += 1; });
  for (let round = 0; round < 3; round += 1) {
    s.update({ selected: false });
    assert.equal(s.controller.getSnapshot().mounted, true);
    assert.equal(s.controller.getSnapshot().ready, true);
    assert.equal(s.timers.size, 1);
    s.advance(30_000);
    s.update({ selected: true });
    assert.equal(s.controller.getSnapshot().expiresAt, null);
    assert.equal(s.timers.size, 0);
  }
  s.advance(EARTH_MAP_RETENTION_MS * 2);
  assert.equal(s.controller.getSnapshot().mounted, true);
  assert.equal(removals, 0);
  unsubscribe(); s.controller.dispose();
});

test("offscreen retention expires in 120 seconds and incidental renders never extend it", () => {
  const s = fixture();
  s.update(); s.controller.reportReady("owner-a", true); s.update({ selected: false });
  assert.equal(EARTH_MAP_RETENTION_MS, 120_000);
  assert.equal(s.controller.getSnapshot().expiresAt, 120_000);
  s.advance(60_000);
  for (let index = 0; index < 10; index += 1) s.update();
  assert.equal(s.controller.getSnapshot().expiresAt, 120_000);
  assert.equal(s.timers.size, 1);
  s.advance(59_999);
  assert.equal(s.controller.getSnapshot().mounted, true);
  s.advance(1);
  assert.equal(s.controller.getSnapshot().mounted, false);
  assert.equal(s.timers.size, 0);
  s.update(); s.controller.reportReady("owner-a", true);
  assert.equal(s.controller.getSnapshot().mounted, false);
  s.update({ selected: true });
  assert.deepEqual(s.controller.getSnapshot(), { owner: "owner-a", mounted: true, ready: false, expiresAt: null });
});

test("document background preserves an existing loading map within the same bounded budget", () => {
  const s = fixture();
  s.update(); s.update({ documentHidden: true });
  assert.equal(s.controller.getSnapshot().mounted, true);
  assert.equal(s.controller.getSnapshot().ready, false);
  s.advance(10_000); s.controller.reportReady("owner-a", true);
  assert.equal(s.controller.getSnapshot().expiresAt, EARTH_MAP_RETENTION_MS);
  s.advance(EARTH_MAP_RETENTION_MS - 10_000);
  assert.equal(s.controller.getSnapshot().mounted, false);
  s.update({ documentHidden: false });
  assert.equal(s.controller.getSnapshot().mounted, true);
  assert.equal(s.controller.getSnapshot().ready, false);
  assert.equal(s.timers.size, 0);
  s.controller.dispose();
});

test("a hidden document never prepares an unvisited map and foreground return keeps an existing session", () => {
  const s = fixture();
  s.update({ documentHidden: true });
  assert.equal(s.controller.getSnapshot().mounted, false);
  s.update({ documentHidden: false }); s.controller.reportReady("owner-a", true);
  s.update({ documentHidden: true }); s.advance(10_000); s.update({ documentHidden: false });
  assert.equal(s.controller.getSnapshot().mounted, true);
  assert.equal(s.controller.getSnapshot().ready, true);
  assert.equal(s.timers.size, 0);
  s.controller.dispose();
});

test("owner changes, logout and game/AFK/startup unavailability release ready maps immediately", () => {
  for (const next of [{ owner: null }, { available: false }, { owner: "owner-b", selected: false }]) {
    const s = fixture();
    s.update(); s.controller.reportReady("owner-a", true); s.update({ selected: false });
    s.update(next);
    assert.equal(s.controller.getSnapshot().mounted, false);
    assert.equal(s.timers.size, 0);
    s.controller.reportReady("owner-a", true);
    assert.equal(s.controller.getSnapshot().mounted, false);
  }
  const s = fixture();
  s.update(); s.controller.reportReady("owner-a", true); s.update({ owner: "owner-b" });
  assert.deepEqual(s.controller.getSnapshot(), { owner: "owner-b", mounted: true, ready: false, expiresAt: null });
  s.controller.reportReady("owner-a", true);
  assert.equal(s.controller.getSnapshot().ready, false);
  s.controller.dispose();
});

test("a retained map that loses readiness is released and cancelled expiry callbacks cannot affect its replacement", () => {
  const s = fixture();
  s.update(); s.controller.reportReady("owner-a", true); s.update({ selected: false });
  const staleExpiry = [...s.timers.values()][0].callback;
  s.controller.reportReady("owner-a", false);
  assert.equal(s.controller.getSnapshot().mounted, false);
  assert.equal(s.timers.size, 0);
  s.update({ selected: true }); s.controller.reportReady("owner-a", true);
  staleExpiry();
  assert.equal(s.controller.getSnapshot().mounted, true);
  s.advance(EARTH_MAP_RETENTION_MS);
  assert.equal(s.controller.getSnapshot().mounted, true);
  assert.equal(s.controller.getSnapshot().ready, true);
  s.controller.dispose();
});

test("disposal removes expiry and leaves an empty reusable controller for effect cleanup", () => {
  const s = fixture();
  s.update(); s.controller.reportReady("owner-a", true); s.update({ selected: false });
  s.controller.dispose();
  assert.equal(s.timers.size, 0);
  assert.equal(s.controller.getSnapshot().mounted, false);
  s.advance(EARTH_MAP_RETENTION_MS);
  s.update({ selected: true });
  assert.equal(s.controller.getSnapshot().mounted, true);
  assert.equal(s.controller.getSnapshot().ready, false);
  s.controller.dispose();
});
