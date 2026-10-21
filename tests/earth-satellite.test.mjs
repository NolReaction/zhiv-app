import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthSatellite, EARTH_SATELLITE_SOURCE: SOURCE, EARTH_SATELLITE_LAYER: LAYER,
  EARTH_SATELLITE_MIN_ZOOM, EARTH_SATELLITE_INITIAL_STATE } = await vite.ssrLoadModule("/features/earth/satellite.ts");
const TEST_KEY = "test-key";
const attribution = '<a href="https://www.maptiler.com/copyright/">© MapTiler</a> © imagery contributors';
const providerMetadata = (values = {}) => ({ tilejson: "2.0.0", tiles: ["https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg"],
  minzoom: 0, maxzoom: 20, tileSize: 512, bounds: [-180, -85, 180, 85], attribution, ...values });
const json = (value, init) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function harness({ fetch: fetcher = async () => json(providerMetadata()), apiKey = TEST_KEY, zoom = 12, beforeLayerId } = {}) {
  let now = 0, nextTimer = 0, loaded = false, moving = false;
  const listeners = new Map(), sources = new Map(), layers = new Map([["earth-land", { id: "earth-land" }],
    ["earth-roads-edge", { id: "earth-roads-edge" }], ["earth-labels", { id: "earth-labels" }]]);
  const timers = new Map(), calls = [], changes = [], removals = [], insertions = [];
  const map = {
    on(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); return this; },
    off(type, callback) { listeners.get(type)?.delete(callback); return this; },
    getZoom: () => zoom, isMoving: () => moving, isSourceLoaded: () => loaded,
    getSource: key => sources.get(key), getLayer: key => layers.get(key),
    addSource(key, definition) { sources.set(key, structuredClone(definition)); },
    removeSource(key) { removals.push(["source", key]); sources.delete(key); },
    addLayer(definition, before) { insertions.push({ definition, before }); layers.set(definition.id, structuredClone(definition)); },
    removeLayer(key) { removals.push(["layer", key]); layers.delete(key); },
  };
  const controller = createEarthSatellite(map, { apiKey, onChange: value => changes.push(value), beforeLayerId,
    environment: { fetch: async (...args) => { calls.push(args); return fetcher(...args); },
      setTimeout(callback, delay) { timers.set(++nextTimer, { at: now + delay, callback }); return nextTimer; },
      clearTimeout(id) { timers.delete(id); } } });
  const emit = (type, data = {}) => { for (const callback of [...listeners.get(type) ?? []]) callback(data); };
  return { controller, calls, sources, layers, changes, timers, listeners, removals, insertions, emit,
    state: () => controller.getSnapshot(),
    enable() { controller.setVisible(true); controller.setEnabled(true); },
    loaded(value = true) { loaded = value; emit("sourcedata", { sourceId: SOURCE }); },
    zoom(value) { zoom = value; emit("zoomend"); },
    moving(value) { moving = value; emit(value ? "movestart" : "moveend"); },
    tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
  };
}

test("satellite is dormant until selected, visible and near; actual metadata configures the same map", async () => {
  const h = harness({ zoom: 3 });
  assert.deepEqual(h.state(), EARTH_SATELLITE_INITIAL_STATE);
  assert.equal(EARTH_SATELLITE_MIN_ZOOM, 10);
  h.controller.setVisible(true); h.zoom(14); await settle();
  assert.equal(h.calls.length, 0, "opening the ordinary map does not contact the imagery provider");
  h.zoom(3); h.controller.setEnabled(true); await settle();
  assert.equal(h.state().status, "zoom-required"); assert.equal(h.state().enabled, true); assert.equal(h.calls.length, 0);
  h.zoom(10); await settle();
  assert.equal(h.calls.length, 1);
  const [url, request] = h.calls[0];
  assert.equal(new URL(url).origin, "https://api.maptiler.com");
  assert.equal(new URL(url).pathname, "/tiles/satellite-v2/tiles.json");
  assert.equal(new URL(url).searchParams.get("key"), TEST_KEY);
  assert.equal(request.credentials, "omit"); assert.equal(request.mode, "cors"); assert.equal(request.redirect, "error");
  const source = h.sources.get(SOURCE);
  assert.equal(source.type, "raster"); assert.equal(source.tileSize, 512);
  assert.equal(source.minzoom, 0); assert.equal(source.maxzoom, 20);
  assert.deepEqual(source.bounds, [-180, -85, 180, 85]); assert.equal(source.attribution, attribution);
  assert.equal(source.url, undefined, "the SDK does not issue another TileJSON request");
  assert.equal(source.volatile, undefined, "GL JS does not implement a volatile cache guarantee");
  assert.equal(new URL(source.tiles[0]).searchParams.get("key"), TEST_KEY);
  assert.equal(h.insertions[0].before, "earth-roads-edge"); assert.equal(h.layers.get(LAYER).minzoom, 10);
  assert.equal(h.state().status, "loading"); h.loaded(); assert.equal(h.state().status, "ready");
  assert.equal(h.state().attribution, attribution); assert.equal(h.timers.size, 0); h.controller.dispose();
});

test("missing key, hidden view and offline gate all requests before activation", async () => {
  const missing = harness({ apiKey: "" }); missing.enable(); await settle();
  assert.equal(missing.state().status, "unavailable"); assert.equal(missing.state().enabled, false); assert.equal(missing.calls.length, 0);
  missing.controller.dispose();
  const h = harness(); h.controller.setEnabled(true); await settle();
  assert.equal(h.state().status, "paused"); assert.equal(h.calls.length, 0);
  h.controller.setOnline(false); h.controller.setVisible(true); await settle();
  assert.equal(h.state().status, "offline"); assert.equal(h.calls.length, 0);
  h.controller.setOnline(true); await settle(); assert.equal(h.calls.length, 1); h.controller.dispose();
});

test("source removal cancels tiles on off, hide, offline and distant zoom; metadata stays only in memory", async () => {
  const h = harness(); h.enable(); await settle(); h.loaded();
  for (const [stop, resume, status] of [
    [() => h.controller.setVisible(false), () => h.controller.setVisible(true), "paused"],
    [() => h.controller.setOnline(false), () => h.controller.setOnline(true), "offline"],
    [() => h.zoom(9), () => h.zoom(12), "zoom-required"],
    [() => h.controller.setEnabled(false), () => h.controller.setEnabled(true), "off"],
  ]) {
    stop(); assert.equal(h.state().status, status); assert.equal(h.sources.size, 0); assert.equal(h.layers.has(LAYER), false);
    assert.equal(h.state().attribution, null); assert.equal(h.timers.size, 0);
    h.emit("error", { sourceId: SOURCE, error: { status: 403 } });
    assert.equal(h.state().status, status, "late errors from cancelled requests cannot undo a pause");
    assert.deepEqual(h.removals.slice(-2), [["layer", LAYER], ["source", SOURCE]]);
    resume(); await settle(); assert.equal(h.sources.size, 1); assert.equal(h.state().status, "ready");
  }
  assert.equal(h.calls.length, 1, "toggle and foreground return reuse bounded metadata without a device cache"); h.controller.dispose();
});

test("aborting metadata ignores a late network response and never reopens a hidden/offline/disabled map", async () => {
  for (const stop of [h => h.controller.setVisible(false), h => h.controller.setOnline(false), h => h.controller.setEnabled(false), h => h.controller.dispose()]) {
    let resolve;
    const h = harness({ fetch: () => new Promise(done => { resolve = done; }) });
    h.enable(); const signal = h.calls[0][1].signal;
    stop(h); assert.equal(signal.aborted, true); assert.equal(h.timers.size, 0);
    resolve(json(providerMetadata())); await settle(); assert.equal(h.sources.size, 0); assert.equal(h.layers.has(LAYER), false);
    h.controller.dispose();
  }
});

test("HTTP access/limit/network errors fall back once with fixed text that cannot expose credentials", async () => {
  for (const status of [401, 403, 429, 500]) {
    const h = harness({ fetch: async () => new Response("private provider message", { status }) }); h.enable(); await settle();
    assert.equal(h.state().status, "error"); assert.equal(h.state().enabled, false); assert.equal(h.sources.size, 0); assert.equal(h.timers.size, 0);
    assert.match(h.state().error, status === 429 ? /Лимит/ : status === 401 || status === 403 ? /Нет доступа/ : /недоступен/);
    assert.ok(!JSON.stringify(h.changes).includes(TEST_KEY)); assert.ok(!JSON.stringify(h.changes).includes("private provider message"));
    h.emit("moveend"); h.emit("render"); assert.equal(h.calls.length, 1, "no automatic retry after provider failure"); h.controller.dispose();
  }
  const h = harness({ fetch: async () => { throw new Error(`https://api.maptiler.com/private?key=${TEST_KEY}`); } }); h.enable(); await settle();
  assert.equal(h.state().status, "error"); assert.ok(!h.state().error.includes(TEST_KEY)); h.controller.dispose();
});

test("TileJSON fetch and streaming body have one bounded deadline and cancellation", async () => {
  let cancelled = false;
  const h = harness({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  h.enable(); await settle(); h.tick(14_999); assert.equal(h.state().status, "loading");
  h.tick(1); await settle(); assert.equal(h.state().status, "error"); assert.match(h.state().error, /слишком долго/);
  assert.equal(h.calls[0][1].signal.aborted, true); assert.equal(cancelled, true); assert.equal(h.timers.size, 0); h.controller.dispose();
  const pending = harness({ fetch: () => new Promise(() => {}) }); pending.enable(); pending.tick(15_000);
  assert.equal(pending.state().status, "error"); assert.equal(pending.calls[0][1].signal.aborted, true); pending.controller.dispose();
});

test("oversized and malformed metadata cannot add a source or redirect tile requests", async () => {
  const bad = [
    { tiles: ["http://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg"] },
    { tiles: ["https://example.com/tiles/satellite-v2/{z}/{x}/{y}.jpg"] },
    { tiles: ["https://api.maptiler.com/tiles/other/{z}/{x}/{y}.jpg"] },
    { tiles: ["https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?redirect=somewhere"] },
    { tiles: [] }, { tiles: Array(9).fill("https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg") },
    { tileSize: 4096 }, { tileSize: undefined }, { minzoom: -1 }, { maxzoom: 9 }, { maxzoom: 25 },
    { bounds: [180, -90, -180, 90] }, { bounds: [-180, -91, 180, 90] }, { scheme: "dangerous" },
    { attribution: "" }, { attribution: "x".repeat(4097) }, { attribution: `private ${TEST_KEY}` },
  ];
  for (const values of bad) {
    const h = harness({ fetch: async () => json(providerMetadata(values)) }); h.enable(); await settle();
    assert.equal(h.state().status, "error", JSON.stringify(values)); assert.equal(h.sources.size, 0); assert.equal(h.calls.length, 1); h.controller.dispose();
  }
  for (const response of [() => new Response("x".repeat(65_537)),
    () => new Response("{}", { headers: { "content-length": "999999999" } }),
    () => new Response("{broken-json")]) {
    const h = harness({ fetch: async () => response() }); h.enable(); await settle();
    assert.equal(h.state().status, "error"); assert.equal(h.sources.size, 0); h.controller.dispose();
  }
});

test("metadata's actual smaller tiles, scheme and higher minzoom are respected", async () => {
  const h = harness({ zoom: 10, fetch: async () => json(providerMetadata({ tileSize: undefined, tile_size: 256, minzoom: 11, scheme: "tms",
    tiles: ["https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}"] })) });
  h.enable(); await settle(); assert.equal(h.state().status, "zoom-required"); assert.equal(h.state().minZoom, 11); assert.equal(h.sources.size, 0);
  h.zoom(11); await settle(); const source = h.sources.get(SOURCE);
  assert.equal(source.tileSize, 256); assert.equal(source.scheme, "tms"); assert.equal(h.layers.get(LAYER).minzoom, 11);
  assert.ok(source.tiles[0].includes("/{z}/{x}/{y}?"), "documented raw imagery templates need no extension");
  assert.equal(h.calls.length, 1); h.controller.dispose();
});

test("live satellite-v2 TileJSON shape uses the verified 512px raw JPEG contract when size is omitted", async () => {
  const liveAttribution = '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> '
    + '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';
  const liveShape = { tilejson: "2.0.0", minzoom: 0, maxzoom: 22, format: "jpg", attribution: liveAttribution,
    tiles: ["https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}"] };
  const h = harness({ fetch: async () => json(liveShape) }); h.enable(); await settle();
  assert.equal(h.state().status, "loading");
  assert.equal(h.sources.get(SOURCE).tileSize, 512, "actual raw JPEG dimensions; no guessing from rendered map examples");
  assert.equal(h.sources.get(SOURCE).maxzoom, 22); assert.equal(h.sources.get(SOURCE).attribution, liveAttribution);
  assert.ok(h.sources.get(SOURCE).tiles[0].includes("/{z}/{x}/{y}?"));
  assert.equal(h.calls.length, 1, "no failed-version or sample-tile probes for each user"); h.controller.dispose();
});

test("source errors are owned independently of source lifetime and do not capture base-map errors", async () => {
  const h = harness(); h.enable(); await settle(); h.loaded();
  const ordinary = { sourceId: "earth-streets", error: { status: 500, url: "https://tiles.openfreemap.org/base/1/2/3.pbf" } };
  assert.equal(h.controller.ownsError(ordinary), false); h.emit("error", ordinary); assert.equal(h.state().status, "ready");
  const own = { sourceId: SOURCE, error: { status: 403, message: `private ${TEST_KEY}` } };
  assert.equal(h.controller.ownsError(own), true); h.emit("error", own);
  assert.equal(h.state().status, "error"); assert.equal(h.sources.size, 0); assert.match(h.state().error, /Нет доступа/);
  assert.equal(h.controller.ownsError(own), true, "late tile errors still belong to the optional source");
  assert.equal(h.controller.ownsError({ error: { url: "https://api.maptiler.com/tiles/satellite-v2/10/1/2.jpg" } }), true);
  assert.equal(h.controller.ownsError({ error: { url: "https://attacker.invalid/tiles/satellite-v2/10/1/2.jpg" } }), false);
  assert.ok(!JSON.stringify(h.changes).includes(TEST_KEY)); h.controller.dispose();
});

test("settled tile loading has a fixed watchdog; movement suspends it without a permanent retry loop", async () => {
  const h = harness(); h.enable(); await settle(); h.tick(10_000); h.emit("render"); h.tick(9_999);
  assert.equal(h.state().status, "loading"); h.tick(1); assert.equal(h.state().status, "error"); assert.equal(h.sources.size, 0);
  h.controller.setEnabled(true); await settle(); h.tick(19_000); h.moving(true); h.tick(100_000);
  assert.equal(h.state().status, "loading"); assert.equal(h.timers.size, 0);
  h.moving(false); h.tick(19_999); assert.equal(h.state().status, "loading"); h.loaded(); h.tick(1);
  assert.equal(h.state().status, "ready"); assert.equal(h.timers.size, 0);
  h.loaded(false); assert.equal(h.state().status, "loading"); h.tick(20_000);
  assert.equal(h.state().status, "error", "a later viewport is bounded too"); h.controller.dispose();
});

test("style recreation reinstalls only the optional layer and dispose is terminal", async () => {
  const h = harness(); h.enable(); await settle(); h.loaded();
  h.sources.clear(); h.layers.delete(LAYER); h.emit("style.load");
  assert.equal(h.sources.size, 1); assert.equal(h.calls.length, 1); assert.equal(h.state().status, "ready");
  h.controller.dispose(); const changeCount = h.changes.length;
  assert.deepEqual(h.state(), EARTH_SATELLITE_INITIAL_STATE, "disposal clears the snapshot without notifying an unmounted UI");
  assert.equal(h.sources.size, 0); assert.equal(h.timers.size, 0);
  assert.ok([...h.listeners.values()].every(listeners => listeners.size === 0));
  h.controller.setEnabled(true); h.controller.setVisible(true); h.controller.setOnline(true); h.emit("style.load"); await settle();
  assert.equal(h.sources.size, 0); assert.equal(h.calls.length, 1); assert.equal(h.changes.length, changeCount);
});

test("an absent insertion point fails safely before making any SDK tile requests", async () => {
  const h = harness({ beforeLayerId: () => "missing-base-layer" }); h.enable(); await settle();
  assert.equal(h.state().status, "error"); assert.equal(h.sources.size, 0); assert.equal(h.insertions.length, 0); h.controller.dispose();
});
