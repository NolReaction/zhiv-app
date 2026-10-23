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
  const sources = new Map(), layers = new Map(), timers = new Map(), fits = [], writes = [];
  let id = 0;
  const map = {
    getSource: key => sources.get(key),
    addSource(key, definition) { sources.set(key, { ...definition, setData(data) { this.data = structuredClone(data); writes.push({ source: this, data: this.data }); } }); },
    removeSource(key) { sources.delete(key); },
    getLayer: key => layers.get(key), addLayer(value) { layers.set(value.id, value); }, removeLayer(key) { layers.delete(key); },
    fitBounds(bounds, options) { fits.push({ bounds, options }); },
    getContainer: () => ({ clientWidth: 390, clientHeight: 700 }),
  };
  const overlay = createEarthMeetMap(map, { now: () => now, wallNow: () => wall, reducedMotion: () => reduced,
    setTimeout(callback, delay) { timers.set(++id, { callback, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  overlay.install(); overlay.setVisible(true);
  return { overlay, sources, layers, timers, fits, writes, data: () => sources.get(EARTH_MEET_SOURCE)?.data,
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

test("a meeting accepts retained private GPS and respects reduced motion", () => {
  const h = harness(true);
  h.overlay.setSnapshot(null, friend(), 1);
  assert.equal(h.fits.length, 0); assert.equal(h.data().features.length, 0);
  h.overlay.setSnapshot(self({ timestamp: WALL - 60_001 }), friend(), 1);
  assert.equal(h.fits.length, 1);
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

test("expiry and missing grants remove line while a retained own point stays usable without waiting for a poll", () => {
  for (const target of [friend({ expiresAtMonotonic: 1_000 }), friend({ expiresAt: new Date(WALL + 1_000).toISOString() })]) {
    const h = harness(); h.overlay.setSnapshot(self(), target, 1); h.tick(1_001);
    assert.equal(h.data().features.length, 0); assert.equal(h.timers.size, 0); h.overlay.dispose();
  }
  const h = harness(); h.overlay.setSnapshot(self(), friend(), 1); h.tick(60_001);
  assert.equal(h.data().features.length, 1);
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

test("wall-clock rollback cannot extend the friend's independent access deadline", () => {
  const h = harness(); h.overlay.setSnapshot(self(), friend({ expiresAtMonotonic: 60_000 }), 1);
  h.tick(30_000); h.rollback(10_000);
  h.overlay.setSnapshot(self(), friend({ expiresAtMonotonic: 60_000 }), 1); h.tick(30_001);
  assert.equal(h.data().features.length, 0); h.overlay.dispose();
});


test("style replacement recreates the empty layers without duplicating a camera request", () => {
  const h = harness(); h.overlay.setSnapshot(self(), friend(), 1);
  h.sources.clear(); h.layers.clear(); h.overlay.install();
  assert.equal(h.sources.size, 1); assert.equal(h.layers.size, 2); assert.equal(h.data().features.length, 1);
  assert.equal(h.fits.length, 1); h.overlay.dispose();
});

test("unchanged and empty meeting snapshots avoid worker writes while focus, coordinates and source replacement remain live", () => {
  const h = harness();
  const emptyWrites = h.writes.length;
  for (let index = 0; index < 50; index++) h.overlay.setSnapshot(null, null, 0);
  assert.equal(h.writes.length, emptyWrites, "an unselected meeting never resubmits the same empty GeoJSON");
  h.overlay.setSnapshot(self(), friend(), 1);
  const firstLineWrites = h.writes.length;
  for (let index = 0; index < 50; index++) h.overlay.setSnapshot(self(), friend(), 1);
  assert.equal(h.writes.length, firstLineWrites);
  h.overlay.setSnapshot(self(), friend(), 2);
  assert.equal(h.writes.length, firstLineWrites, "an explicit refocus needs no identical line upload");
  assert.equal(h.fits.length, 2, "the write guard never swallows an explicit camera request");
  h.overlay.setSnapshot(self(), friend({ longitude: 37.64 }), 2);
  assert.equal(h.writes.length, firstLineWrites + 1);
  h.sources.clear(); h.layers.clear(); h.overlay.install();
  assert.equal(h.writes.length, firstLineWrites + 2, "the same geometry is republished to a new style's source");
  h.tick(60_001);
  assert.equal(h.writes.length, firstLineWrites + 2);
  assert.equal(h.data().features.length, 1, "capture age does not remove a planned last-known connection");
  h.overlay.setSnapshot(null, null, 2);
  h.overlay.setVisible(false); h.overlay.setVisible(true);
  assert.equal(h.writes.length, firstLineWrites + 3, "repeated revocation and hiding do not repeat an already empty upload");
  h.overlay.setSnapshot(self({ timestamp: WALL + 60_001 }), friend(), 3);
  h.overlay.setVisible(false);
  assert.equal(h.data().features.length, 0, "hiding still clears a new live line immediately");
  h.overlay.dispose();
});

const road = (values = {}) => ({ ownerPublicId: "SELF", circleId: "friend", friendPublicId: "FRIEND",
  origin: [37.61, 55.75], destination: [37.63, 55.76], createdAt: WALL, createdAtMonotonic: 0,
  expiresAt: WALL + 30_000, expiresAtMonotonic: 30_000, distanceMeters: 1800, durationSeconds: 1400,
  geometry: { type: "LineString", coordinates: [[37.61, 55.75], [37.60, 55.77], [37.63, 55.76]] }, ...values });

test("a requested road path keeps its bends, frames the detour, and never repeats worker uploads", () => {
  const h = harness(), route = road();
  h.overlay.setSnapshot(self(), friend(), 1, route);
  assert.deepEqual(h.data().features[0].geometry.coordinates, [route.geometry.coordinates]);
  assert.deepEqual(h.data().features[0].properties, {}, "the worker receives geometry without account identifiers");
  assert.ok(Math.abs(h.fits[0].bounds[0][0] - 37.60) < 1e-9);
  assert.equal(h.fits[0].bounds[1][1], 55.77, "camera includes the walking detour rather than just the endpoints");
  const writes = h.writes.length;
  for (let i = 0; i < 40; i++) h.overlay.setSnapshot(self(), friend(), 1, structuredClone(route));
  assert.equal(h.writes.length, writes);
  h.tick(30_001);
  assert.deepEqual(h.data().features[0].geometry.coordinates, earthMeetLine(self(), friend()).features[0].geometry.coordinates,
    "an expired road path falls back to the explicitly labelled direct connection");
  assert.equal(h.fits.length, 1, "expiry never moves the camera");
  h.overlay.dispose();
});

test("a route for an old friend, expired access or moved endpoint cannot reach the map worker", () => {
  for (const route of [road({ friendPublicId: "OTHER" }), road({ circleId: "OLD" }),
    road({ expiresAtMonotonic: 0 }), road({ expiresAt: WALL }), road({ origin: [37, 55] }), road({ destination: [38, 56] })]) {
    const h = harness(); h.overlay.setSnapshot(self(), friend(), 0, route);
    assert.deepEqual(h.data().features[0].geometry, earthMeetLine(self(), friend()).features[0].geometry);
    h.overlay.dispose();
  }
  const h = harness(); h.overlay.setSnapshot(self(), friend(), 0, road());
  h.overlay.setSnapshot(self(), null, 0, road());
  assert.equal(h.data().features.length, 0);
  h.overlay.setVisible(false); h.overlay.setVisible(true);
  assert.equal(h.data().features.length, 0, "retained background data cannot restore a route");
  h.overlay.dispose();
});

test("a road path crossing the date line is split and framed in the short interval", () => {
  const h = harness();
  const position = self({ longitude: 179.99, latitude: 10 });
  const person = friend({ longitude: -179.99, latitude: 10 });
  const route = road({ origin: [179.99, 10], destination: [-179.99, 10],
    geometry: { type: "LineString", coordinates: [[179.99, 10], [179.999, 10.001], [-179.999, 10.001], [-179.99, 10]] } });
  h.overlay.setSnapshot(position, person, 1, route);
  const segments = h.data().features[0].geometry.coordinates;
  assert.equal(segments.length, 2);
  assert.ok(segments.flat().every(([longitude]) => Math.abs(longitude) <= 180));
  assert.equal(segments[0].at(-1)[1], segments[1][0][1]);
  assert.ok(h.fits[0].bounds[1][0] - h.fits[0].bounds[0][0] < .1);
  h.overlay.dispose();
});


test("a manual build frames the whole arriving path once after its initial point view", () => {
  const h = harness();
  h.overlay.setSnapshot(self(), friend(), 1);
  assert.equal(h.fits.length, 1);
  h.overlay.setSnapshot(self(), friend(), 1, road());
  assert.equal(h.fits.length, 2);
  assert.equal(h.fits[1].bounds[1][1], 55.77);
  h.overlay.setSnapshot(self(), friend(), 1, structuredClone(road()));
  assert.equal(h.fits.length, 2);
  h.tick(30_001);
  assert.equal(h.fits.length, 2);
  h.overlay.dispose();
});

test("road points exactly on either date-line boundary never form a world-spanning segment", () => {
  for (const direction of [1, -1]) {
    const h = harness();
    const origin = [direction * 179.99, 10], destination = [direction * -179.99, 10];
    const coordinates = [origin, [direction * -180, 10.001], [direction * 180, 10.002], destination];
    h.overlay.setSnapshot(self({ longitude: origin[0], latitude: 10 }), friend({ longitude: destination[0], latitude: 10 }), 1,
      road({ origin, destination, geometry: { type: "LineString", coordinates } }));
    for (const segment of h.data().features[0].geometry.coordinates) {
      assert.ok(segment.length >= 2);
      for (let i = 1; i < segment.length; i++) assert.ok(Math.abs(segment[i][0] - segment[i - 1][0]) <= 180);
      assert.ok(segment.flat().every(Number.isFinite));
    }
    h.overlay.dispose();
  }
});
