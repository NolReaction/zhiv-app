import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthGlobeScene } = await vite.ssrLoadModule("/features/earth/globe-scene.ts");
const { createEarthLightingData, EARTH_LIGHTING_SOURCE, EARTH_LIGHTS_SOURCE } = await vite.ssrLoadModule("/features/earth/globe-lighting.ts");

function fixture({ zoom = 1, reduced = false, mode = "day", eveningCenter, recordLighting = false } = {}) {
  const originals = { window: globalThis.window, document: globalThis.document, performance: globalThis.performance };
  let time = 0, sequence = 0, imageUpdates = 0;
  let center = { lng: 38, lat: 55 };
  const timers = new Map(), listeners = new Map(), visibilityListeners = new Set(), preferenceListeners = new Set();
  const markers = [];
  const shadeUpdates = [];
  const ownerDocument = {
    hidden: false,
    addEventListener(type, callback) { assert.equal(type, "visibilitychange"); visibilityListeners.add(callback); },
    removeEventListener(type, callback) { assert.equal(type, "visibilitychange"); visibilityListeners.delete(callback); },
    createElement(tag) {
      const handlers = new Map();
      return { tag, attributes: {}, dataset: {}, children: [], style: { setProperty(key, value) { this[key] = value; } },
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
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => time } });
  const container = { ownerDocument, clientWidth: 800, clientHeight: 600 };
  const mercatorY = latitude => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
  const map = {
    getContainer: () => container, getCenter: () => center, getZoom: () => zoom,
    getSource: id => recordLighting && [EARTH_LIGHTING_SOURCE, EARTH_LIGHTS_SOURCE].includes(id)
      ? { setData(data) { if (id === EARTH_LIGHTING_SOURCE) shadeUpdates.push(data); } } : undefined,
    getLayer: () => undefined, hasImage: () => true, setSky() {}, setLight() {},
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
  const emit = type => { for (const callback of [...listeners.get(type) ?? []]) callback(); };
  const scene = createEarthGlobeScene(map, Marker, mode, eveningCenter);
  return { scene, map, markers, timers, listeners, visibilityListeners, preferenceListeners, shadeUpdates,
    get imageUpdates() { return imageUpdates; },
    get weatherMarker() { return markers.find(marker => marker.options.element.dataset.earthWeather); },
    advance(duration) {
      const end = time + duration;
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (timer.due > end) break;
        time = timer.due; timers.delete(id); timer.callback();
      }
      time = end;
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
    },
  };
}

const rain = { condition: "rain", area: { key: "55:38", latitude: 55, longitude: 38 } };
const particles = state => state.markers.filter(marker => marker.options.element.dataset.earthWeather)
  .flatMap(marker => marker.options.element.children[0].children.slice(-12));
const transforms = state => particles(state).map(particle => particle.attributes.transform);

test("a restored evening keeps its geographic sun anchor across camera movement and mode changes", () => {
  const anchor = { lng: 35, lat: 27 };
  const expected = createEarthLightingData("evening", 0, anchor).shade;
  const s = fixture({ mode: "evening", eveningCenter: anchor, recordLighting: true });
  try {
    assert.deepEqual(s.shadeUpdates.at(-1), expected, "a remounted scene uses the saved evening rather than the restored camera centre");
    s.scene.setReady(true);
    s.move({ lng: -90, lat: 40 }); s.advance(125);
    s.scene.setLighting("evening");
    assert.deepEqual(s.shadeUpdates.at(-1), expected, "panning and a repeated mode effect do not move the sun");
    s.scene.setLighting("day");
    assert.equal(s.shadeUpdates.at(-1).features.length, 0);
    s.scene.setLighting("evening");
    assert.deepEqual(s.shadeUpdates.at(-1), expected, "a mode without a new anchor preserves the existing selection");
    const nextAnchor = { lng: 120, lat: -20 };
    s.scene.setLighting("evening", nextAnchor);
    assert.deepEqual(s.shadeUpdates.at(-1), createEarthLightingData("evening", 0, nextAnchor).shade,
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
    const cloudPositions = s.markers.slice(0, 8).map(marker => marker.positions.length);
    const uploads = s.imageUpdates;
    s.setZoom(4.2);
    assert.equal(s.timers.size, 0, "globe decor stops at the street-detail boundary");
    s.setZoom(12);
    s.scene.setWeather(rain);
    assert.equal(s.markers.filter(marker => marker.options.element.dataset.earthWeather).length, 9);
    assert.equal(s.timers.size, 1, "the shared clock supports street-level rain");
    const previous = transforms(s);
    s.advance(500);
    assert.notDeepEqual(transforms(s), previous);
    assert.equal(s.imageUpdates, uploads);
    assert.deepEqual(s.markers.slice(0, 8).map(marker => marker.positions.length), cloudPositions);
  } finally { s.restore(); }
});

test("panning out of a weather cell stops street motion immediately and panning back resumes it", () => {
  const s = fixture({ zoom: 12 });
  try {
    s.scene.setReady(true); s.scene.setWeather(rain);
    assert.equal(s.timers.size, 1);
    s.move({ lng: 39, lat: 55 });
    assert.equal(s.weatherMarker.options.element.style.display, "none");
    assert.ok(s.markers.filter(marker => marker.options.element.dataset.earthWeather).every(marker => marker.options.element.style.display === "none"));
    assert.equal(s.timers.size, 0, "a hidden old forecast cannot retain a background clock");
    s.advance(60_000);
    s.move({ lng: 38, lat: 55 });
    assert.equal(s.weatherMarker.options.element.style.display, "");
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
    assert.equal(s.weatherMarker.options.element.style.display, "none");
    assert.ok(s.markers.filter(marker => marker.options.element.dataset.earthWeather).every(marker => marker.options.element.style.display === "none"));
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
