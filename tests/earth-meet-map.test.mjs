import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthMeetMap, earthMeetLine, EARTH_MEET_SOURCE } = await vite.ssrLoadModule("/features/earth/meet-map.ts");
const WALL = Date.parse("2026-10-20T12:00:00Z");
const self = (values = {}) => ({ latitude: 55.75, longitude: 37.61, accuracy: 20, timestamp: WALL, ...values });
const friend = (values = {}) => ({ circleId: "friend", user: { publicId: "FRIEND", displayName: "Друг" },
  latitude: 55.76, longitude: 37.63, accuracyMeters: 30, precision: "PRECISE",
  updatedAt: new Date(WALL).toISOString(), expiresAt: new Date(WALL + 120_000).toISOString(), expiresAtMonotonic: 120_000, ...values });
function harness(reduced = false) {
  let now = 0, wall = WALL;
  const sources = new Map(), layers = new Map(), timers = new Map(), fits = [];
  let id = 0;
  const map = {
    getSource: key => sources.get(key),
    addSource(key, definition) { sources.set(key, { ...definition, setData(data) { this.data = structuredClone(data); } }); },
    removeSource(key) { sources.delete(key); },
    getLayer: key => layers.get(key), addLayer(value) { layers.set(value.id, value); }, removeLayer(key) { layers.delete(key); },
    fitBounds(bounds, options) { fits.push({ bounds, options }); },
    getContainer: () => ({ clientWidth: 390, clientHeight: 700 }),
  };
  const overlay = createEarthMeetMap(map, { now: () => now, wallNow: () => wall, reducedMotion: () => reduced,
    setTimeout(callback, delay) { timers.set(++id, { callback, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  overlay.install(); overlay.setVisible(true);
  return { overlay, sources, layers, timers, fits, data: () => sources.get(EARTH_MEET_SOURCE)?.data,
    tick(ms) { now += ms; wall += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
    rollback(ms) { wall -= ms; },
  };
}

test("meeting draws an ephemeral direct line and frames both locations only once per request", () => {
  const h = harness();
  h.overlay.setSnapshot(self(), friend(), 1);
  assert.equal(h.data().features.length, 1);
  assert.deepEqual(h.data().features[0].properties, {}, "no identity or privacy settings in the map worker");
  assert.deepEqual(h.fits[0].bounds[0], [37.61, 55.75]);
  assert.ok(Math.abs(h.fits[0].bounds[1][0] - 37.63) < 1e-9);
  assert.equal(h.fits[0].bounds[1][1], 55.76);
  assert.equal(h.fits[0].options.maxZoom, 15);
  assert.equal(h.fits[0].options.bearing, 0);
  assert.equal(h.fits[0].options.essential, false);
  assert.ok(h.fits[0].options.padding.bottom > h.fits[0].options.padding.top);
  h.overlay.setSnapshot(self(), friend({ latitude: 55.77 }), 1);
  assert.equal(h.fits.length, 1, "updates must not fight the user's camera gestures");
  let preparations = 0;
  const padding = { top: 28, bottom: 40, left: 28, right: 28 };
  h.overlay.setCameraPadding(padding, () => { preparations++; });
  h.overlay.setSnapshot(self(), friend(), 2);
  assert.equal(h.fits.length, 2);
  assert.equal(preparations, 1, "measured viewport is applied only before a new explicit framing");
  assert.deepEqual(h.fits[1].options.padding, padding, "only marker clearance is added to the native panel padding");
  assert.equal(h.fits[1].options.absolutePadding, undefined);
  h.overlay.setSnapshot(self(), friend(), 2);
  assert.equal(preparations, 1, "ordinary location snapshots cannot interrupt camera movement");
  h.overlay.dispose();
  assert.equal(h.sources.size, 0); assert.equal(h.layers.size, 0); assert.equal(h.timers.size, 0);
});

test("a meeting waits for fresh private GPS and respects reduced motion", () => {
  const h = harness(true);
  h.overlay.setSnapshot(null, friend(), 1);
  assert.equal(h.fits.length, 0); assert.equal(h.data().features.length, 0);
  h.overlay.setSnapshot(self({ timestamp: WALL - 60_001 }), friend(), 1);
  assert.equal(h.fits.length, 0);
  h.overlay.setSnapshot(self(), friend(), 1);
  assert.equal(h.fits.length, 1); assert.equal(h.fits[0].options.duration, 0);
  h.overlay.dispose();
});

test("the date-line connection splits safely while camera takes the short interval", () => {
  for (const [start, end] of [[179.9, -179.9], [-179.9, 179.9]]) {
    const h = harness();
    h.overlay.setSnapshot(self({ latitude: 10, longitude: start }), friend({ latitude: 20, longitude: end }), 1);
    const segments = h.data().features[0].geometry.coordinates;
    assert.equal(segments.length, 2);
    assert.ok(segments.flat().every(([longitude]) => Math.abs(longitude) <= 180));
    assert.ok(h.fits[0].bounds[1][0] - h.fits[0].bounds[0][0] < 1);
    assert.equal(segments[0].at(-1)[1], segments[1][0][1]);
    h.overlay.dispose();
  }
  assert.equal(earthMeetLine(self(), friend()).features[0].geometry.coordinates.length, 1);
});

test("expiry, missing grants and stale own GPS remove line without waiting for a poll", () => {
  for (const target of [friend({ expiresAtMonotonic: 1_000 }), friend({ expiresAt: new Date(WALL + 1_000).toISOString() })]) {
    const h = harness(); h.overlay.setSnapshot(self(), target, 1); h.tick(1_001);
    assert.equal(h.data().features.length, 0); assert.equal(h.timers.size, 0); h.overlay.dispose();
  }
  const h = harness(); h.overlay.setSnapshot(self(), friend(), 1); h.tick(60_001);
  assert.equal(h.data().features.length, 0);
  h.overlay.setSnapshot(self({ timestamp: WALL + 60_001 }), friend(), 2);
  assert.equal(h.data().features.length, 1);
  h.overlay.setSnapshot(self(), null, 2);
  assert.equal(h.data().features.length, 0); h.overlay.dispose();
});

test("backgrounding clears coordinates and cannot restore them or replay camera focus", () => {
  const h = harness(); h.overlay.setSnapshot(self(), friend(), 1);
  h.overlay.setVisible(false);
  assert.equal(h.data().features.length, 0); assert.equal(h.timers.size, 0);
  h.overlay.setSnapshot(self(), friend(), 2);
  h.overlay.setVisible(true);
  assert.equal(h.data().features.length, 0);
  h.overlay.setSnapshot(self(), friend(), 1);
  assert.equal(h.data().features.length, 1); assert.equal(h.fits.length, 1);
  h.overlay.dispose();
  h.overlay.install(); h.overlay.setSnapshot(self(), friend(), 3);
  assert.equal(h.sources.size, 0);
});

test("wall-clock rollback cannot extend an unchanged private fix", () => {
  const h = harness(); h.overlay.setSnapshot(self(), friend(), 1); h.tick(30_000); h.rollback(10_000);
  h.overlay.setSnapshot(self(), friend(), 1); h.tick(30_001);
  assert.equal(h.data().features.length, 0); h.overlay.dispose();
});

test("style replacement recreates the empty layers without duplicating a camera request", () => {
  const h = harness(); h.overlay.setSnapshot(self(), friend(), 1);
  h.sources.clear(); h.layers.clear(); h.overlay.install();
  assert.equal(h.sources.size, 1); assert.equal(h.layers.size, 2); assert.equal(h.data().features.length, 1);
  assert.equal(h.fits.length, 1); h.overlay.dispose();
});
