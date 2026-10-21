import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { earthTestCanvasContext } from "./earth-canvas-harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthGlobeScene } = await vite.ssrLoadModule("/features/earth/globe-scene.ts");
const { createEarthLightingData, EARTH_LIGHTS_SOURCE } = await vite.ssrLoadModule("/features/earth/globe-lighting.ts");
const { EARTH_BIOME_LAYER, EARTH_VEGETATION_LAYER, earthSeasonBiomeColor } = await vite.ssrLoadModule("/features/earth/earth-seasons.ts");

function fixture({ zoom = 1, reduced = false, mode = "day", eveningCenter, recordLighting = false,
  recordSeasons = false, now = Date.UTC(2026, 0, 15, 12) } = {}) {
  const originals = { window: globalThis.window, document: globalThis.document, performance: globalThis.performance, dateNow: Date.now };
  let time = 0, sequence = 0, imageUpdates = 0;
  let center = { lng: 38, lat: 55 };
  const timers = new Map(), listeners = new Map(), visibilityListeners = new Set(), preferenceListeners = new Set();
  const markers = [];
  const lightsUpdates = [];
  const seasonUpdates = [], layers = new Map(recordSeasons ? [[EARTH_BIOME_LAYER, {}], [EARTH_VEGETATION_LAYER, {}]] : []);
  const ownerDocument = {
    hidden: false,
    addEventListener(type, callback) { assert.equal(type, "visibilitychange"); visibilityListeners.add(callback); },
    removeEventListener(type, callback) { assert.equal(type, "visibilitychange"); visibilityListeners.delete(callback); },
    createElement(tag) {
      const handlers = new Map();
      return { tag, attributes: {}, dataset: {}, children: [], style: { setProperty(key, value) { this[key] = value; } },
        context: earthTestCanvasContext(), getContext() { return this.context; }, remove() { this.removed = (this.removed ?? 0) + 1; },
        classList: { contains: () => false },
        setAttribute(key, value) { this.attributes[key] = value; },
        append(...children) { this.children.push(...children); },
        addEventListener(type, callback) {
          if (!handlers.has(type)) handlers.set(type, new Set());
          handlers.get(type).add(callback);
        },
        removeEventListener(type, callback) { handlers.get(type)?.delete(callback); },
      };
    },
    createElementNS(namespace, tag) { assert.equal(namespace, "http://www.w3.org/2000/svg"); return this.createElement(tag); },
  };
  const media = { get matches() { return reduced; },
    addEventListener(type, callback) { assert.equal(type, "change"); preferenceListeners.add(callback); },
    removeEventListener(type, callback) { assert.equal(type, "change"); preferenceListeners.delete(callback); } };
  globalThis.document = ownerDocument;
  globalThis.window = {
    matchMedia: () => media,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay, due: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => time } });
  Date.now = () => now + time;
  const container = { ownerDocument, clientWidth: 800, clientHeight: 600, children: [], append(...children) { this.children.push(...children); } };
  const mercatorY = latitude => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
  const map = {
    getContainer: () => container, getCanvasContainer: () => container, getCenter: () => center, getZoom: () => zoom,
    getSource: id => recordLighting && id === EARTH_LIGHTS_SOURCE
      ? { setData(data) { lightsUpdates.push(data); } } : undefined,
    getLayer: id => layers.get(id), hasImage: () => true, setSky() {}, setLight() {},
    setPaintProperty: (...args) => seasonUpdates.push(args),
    updateImage() { imageUpdates++; }, triggerRepaint() {}, addLayer() {}, removeLayer() {},
    project(position) {
      const scale = 512 * 2 ** zoom;
      const longitude = Array.isArray(position) ? position[0] : position.lng;
      const latitude = Array.isArray(position) ? position[1] : position.lat;
      const delta = ((longitude - center.lng + 540) % 360) - 180;
      return { x: container.clientWidth / 2 + delta / 360 * scale,
        y: container.clientHeight / 2 + (mercatorY(latitude) - mercatorY(center.lat)) * scale };
    },
    unproject(point) {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      const scale = 512 * 2 ** zoom;
      return { lng: center.lng + (x - container.clientWidth / 2) / scale * 360,
        lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * (mercatorY(center.lat) + (y - container.clientHeight / 2) / scale)))) * 180 / Math.PI };
    },
    on(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    off(type, callback) {
      listeners.get(type)?.delete(callback);
      if (listeners.get(type)?.size === 0) listeners.delete(type);
    },
  };
  class Marker {
    constructor(options) { this.options = options; this.positions = []; this.removed = 0; markers.push(this); }
    setLngLat(position) { this.positions.push([...position]); return this; }
    addTo(target) { assert.equal(target, map); return this; }
    remove() { this.removed++; }
  }
  const emit = (type, event) => { for (const callback of [...listeners.get(type) ?? []]) callback(event); };
  const scene = createEarthGlobeScene(map, Marker, mode, eveningCenter);
  return { scene, map, markers, timers, listeners, visibilityListeners, preferenceListeners, lightsUpdates, seasonUpdates,
    get imageUpdates() { return imageUpdates; },
    get weatherField() { return container.children.find(element => element.dataset.earthWeather); },
    advance(duration) {
      const end = time + duration;
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (timer.due > end) break;
        time = timer.due; timers.delete(id); timer.callback();
      }
      time = end;
    },
    cameraFrames(interval, duration, inputType = "mousemove") {
      const end = time + duration;
      while (time + interval <= end) {
        this.advance(interval);
        emit("move", inputType ? { originalEvent: { type: inputType, timeStamp: time } } : {});
        emit("render");
      }
      emit("moveend");
    },
    setZoom(value) { zoom = value; emit("zoom"); emit("move"); },
    move(value) { center = value; emit("move"); },
    reduce(value) { reduced = value; for (const callback of preferenceListeners) callback(); },
    hide(value) { ownerDocument.hidden = value; for (const callback of visibilityListeners) callback(); },
    restore() {
      scene.dispose();
      globalThis.window = originals.window;
      globalThis.document = originals.document;
      Object.defineProperty(globalThis, "performance", { configurable: true, value: originals.performance });
      Date.now = originals.dateNow;
    },
  };
}

const rain = { condition: "rain", area: { key: "55:38", latitude: 55, longitude: 38 } };
const transforms = state => {
  const count = Number(state.weatherField.dataset.weatherParticles);
  return state.weatherField.context.calls.filter(call => call[0] === "lineTo" || call[0] === "arc").slice(-count);
};

test("a restored evening keeps its geographic sun anchor across camera movement and mode changes", () => {
  const anchor = { lng: 35, lat: 27 };
  const expected = createEarthLightingData("evening", 0, anchor).lights;
  const s = fixture({ mode: "evening", eveningCenter: anchor, recordLighting: true });
  try {
    assert.deepEqual(s.lightsUpdates.at(-1), expected, "a remounted scene uses the saved evening rather than the restored camera centre");
    s.scene.setReady(true);
    s.move({ lng: -90, lat: 40 }); s.advance(125);
    s.scene.setLighting("evening");
    assert.deepEqual(s.lightsUpdates.at(-1), expected, "panning and a repeated mode effect do not move the sun");
    s.scene.setLighting("day");
    assert.equal(s.lightsUpdates.at(-1).features.length, 0);
    s.scene.setLighting("evening");
    assert.deepEqual(s.lightsUpdates.at(-1), expected, "a mode without a new anchor preserves the existing selection");
    const nextAnchor = { lng: 120, lat: -20 };
    s.scene.setLighting("evening", nextAnchor);
    assert.deepEqual(s.lightsUpdates.at(-1), createEarthLightingData("evening", 0, nextAnchor).lights,
      "an explicit user selection can place a new evening");
  } finally { s.restore(); }
});

test("one scene clock animates overview decor, while street weather leaves ocean and global clouds still", () => {
  const s = fixture();
  try {
    assert.equal(s.timers.size, 0, "preparation has no decorative timer");
    s.scene.setReady(true);
    assert.equal(s.timers.size, 1);
    s.advance(250);
    assert.ok(s.imageUpdates > 0);
    const cloudPositions = s.markers.filter(marker => marker.options.element.dataset.earthCloud).map(marker => marker.positions.length);
    const uploads = s.imageUpdates;
    s.setZoom(4.2);
    assert.equal(s.timers.size, 0, "globe decor stops at the street-detail boundary");
    s.setZoom(12);
    s.scene.setWeather(rain);
    assert.equal(s.weatherField.tag, "canvas"); assert.equal(s.weatherField.hidden, false);
    assert.equal(s.timers.size, 1, "the shared clock supports street-level rain");
    const previous = transforms(s);
    s.advance(500);
    assert.notDeepEqual(transforms(s), previous);
    assert.equal(s.imageUpdates, uploads);
    assert.deepEqual(s.markers.filter(marker => marker.options.element.dataset.earthCloud).map(marker => marker.positions.length), cloudPositions);
  } finally { s.restore(); }
});

test("panning out of a weather cell stops street motion immediately and panning back resumes it", () => {
  const s = fixture({ zoom: 12 });
  try {
    s.scene.setReady(true); s.scene.setWeather(rain);
    assert.equal(s.timers.size, 1);
    s.move({ lng: 39, lat: 55 });
    assert.equal(s.weatherField.hidden, true);
    assert.equal(s.weatherField.hidden, true);
    assert.equal(s.timers.size, 0, "a hidden old forecast cannot retain a background clock");
    s.advance(60_000);
    s.move({ lng: 38, lat: 55 });
    assert.equal(s.weatherField.hidden, false);
    assert.equal(s.timers.size, 1);
    const previous = transforms(s);
    s.advance(125);
    assert.notDeepEqual(transforms(s), previous);
  } finally { s.restore(); }
});

test("reduced motion and hidden/retained maps have no timer, and terminal callbacks never touch a disposed map", () => {
  const s = fixture({ zoom: 12 });
  try {
    s.scene.setReady(true); s.scene.setWeather(rain); s.advance(500);
    s.reduce(true);
    assert.equal(s.timers.size, 0);
    const still = transforms(s);
    s.advance(5_000); s.move({ lng: 38.1, lat: 55 });
    assert.deepEqual(transforms(s), still, "manual movement cannot advance reduced-motion particles");
    s.reduce(false); assert.equal(s.timers.size, 1);
    s.hide(true); assert.equal(s.timers.size, 0);
    assert.equal(s.weatherField.hidden, true);
    assert.equal(s.weatherField.hidden, true);
    s.hide(false); assert.equal(s.timers.size, 1);
    s.scene.setVisible(false); assert.equal(s.timers.size, 0);
    s.scene.setVisible(true); assert.equal(s.timers.size, 1);
    const queued = [...s.timers.values()][0].callback;
    s.scene.dispose();
    assert.equal(s.timers.size, 0); assert.equal(s.listeners.size, 0);
    assert.equal(s.visibilityListeners.size, 0); assert.equal(s.preferenceListeners.size, 0);
    assert.ok(s.markers.every(marker => marker.removed === 1));
    s.map.getCenter = () => { throw new Error("disposed map was read"); };
    queued(); s.scene.setLighting("evening"); s.scene.setVisible(true); s.scene.setReady(true); s.scene.setWeather(rain);
    assert.equal(s.timers.size, 0);
  } finally { s.restore(); }
});

test("real slow user frames adapt the existing scene clock, ocean uploads and precipitation, then healthy input restores them", () => {
  const s = fixture();
  try {
    s.cameraFrames(50, 3_000); assert.equal(s.timers.size, 0, "loading cannot produce quality evidence or an effect clock");
    s.scene.setReady(true); s.setZoom(14); s.scene.setWeather(rain);
    const fullParticles = Number(s.weatherField.dataset.weatherParticles);
    const weatherSize = [s.weatherField.width, s.weatherField.height];
    assert.ok(fullParticles > 0);
    s.setZoom(1);
    s.cameraFrames(50, 3_000, null);
    s.advance(3_000);
    assert.equal([...s.timers.values()][0].delay, 125, "flyTo and the existing 8 Hz decor clock are not poor device FPS");
    s.cameraFrames(50, 2_100);
    assert.equal(s.timers.size, 1); assert.equal([...s.timers.values()][0].delay, 250);
    const cloudMarkers = s.markers.filter(marker => marker.options.element.dataset.earthCloud);
    const writes = cloudMarkers.map(marker => marker.positions.length), uploads = s.imageUpdates;
    s.advance(1_000);
    assert.deepEqual(cloudMarkers.map((marker, index) => marker.positions.length - writes[index]), [4, 4, 4, 4, 4]);
    assert.equal(s.imageUpdates - uploads, 2, "ocean retains its image while uploading half as often");
    s.setZoom(14);
    assert.equal(Number(s.weatherField.dataset.weatherParticles), Math.floor(fullParticles * .7));
    assert.deepEqual([s.weatherField.width, s.weatherField.height], weatherSize);
    s.setZoom(1); s.hide(true); s.advance(5_000); s.hide(false);
    s.cameraFrames(16, 6_400);
    assert.equal([...s.timers.values()][0].delay, 125, "healthy foreground gestures restore full decorative motion");
    s.setZoom(14); assert.equal(Number(s.weatherField.dataset.weatherParticles), fullParticles);
    s.scene.dispose(); assert.equal(s.timers.size, 0); assert.equal(s.listeners.size, 0);
  } finally { s.restore(); }
});

test("hidden, retained and reduced-motion intervals discard partial quality evidence", () => {
  const s = fixture();
  try {
    s.scene.setReady(true);
    for (const suspend of [value => s.hide(value), value => s.scene.setVisible(!value), value => s.reduce(value)]) {
      s.cameraFrames(50, 1_050); suspend(true);
      assert.equal(s.timers.size, 0);
      s.cameraFrames(50, 3_000); suspend(false); s.cameraFrames(50, 1_050);
      assert.equal([...s.timers.values()][0].delay, 125, "separate foreground periods cannot complete an old slow window");
      // Start the next case with a clean foreground sample period.
      s.scene.setReady(false); s.scene.setReady(true);
    }
    const render = [...s.listeners.get("render") ?? []];
    s.scene.dispose();
    s.map.getCenter = () => { throw new Error("disposed quality or season callback touched the map"); };
    for (const callback of render) callback();
    assert.equal(s.listeners.size, 0); assert.equal(s.timers.size, 0);
  } finally { s.restore(); }
});

test("seasons reuse scene lifecycle, update once per day and refresh after a long hidden or reduced-motion spell", () => {
  const base = Date.UTC(2026, 0, 15, 12), day = 86_400_000;
  const s = fixture({ recordSeasons: true, now: base });
  try {
    assert.equal(s.seasonUpdates.length, 2); assert.equal(s.timers.size, 0, "season setup has no independent clock");
    assert.deepEqual(s.seasonUpdates[0], [EARTH_BIOME_LAYER, "fill-color", earthSeasonBiomeColor(base)]);
    s.scene.setReady(true); s.advance(1_000); assert.equal(s.seasonUpdates.length, 2);
    s.hide(true); s.advance(day * 2); assert.equal(s.seasonUpdates.length, 2);
    s.hide(false); assert.equal(s.seasonUpdates.length, 4);
    s.reduce(true); s.advance(day); assert.equal(s.seasonUpdates.length, 4); assert.equal(s.timers.size, 0);
    s.move({ lng: 38.1, lat: 55 }); assert.equal(s.seasonUpdates.length, 6, "a visible static map refreshes seasonal paint when the user moves it");
    s.move({ lng: 38.2, lat: 55 }); assert.equal(s.seasonUpdates.length, 6);
    s.scene.dispose(); s.advance(day); s.scene.setReady(true);
    assert.equal(s.seasonUpdates.length, 6); assert.equal(s.timers.size, 0);
  } finally { s.restore(); }
});
