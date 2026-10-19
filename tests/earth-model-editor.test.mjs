import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthModelEditorMap, earthModelEditorData, earthModelEditorCamera, EARTH_MODEL_EDITOR_SOURCE, EARTH_MODEL_EDITOR_ANCHOR } = await vite.ssrLoadModule("/features/earth/dev/earth-model-editor-map.ts");
const { EarthModelEditor } = await vite.ssrLoadModule("/features/earth/dev/earth-model-editor.tsx");
const placement = { id: "eiffel-tower", longitude: 2.29444, latitude: 48.85826, heightMeters: 330,
  headingDegrees: 0, elevationMeters: 0, exclusionRadiusMeters: 80, excludeBuildings: true };

function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  const listeners = new Map();
  const windowListeners = new Map();
  let styleLoaded = true;
  let removed = false;
  let panEnabled = true;
  const canvas = { style: { cursor: "default" }, ownerDocument: { defaultView: {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener(type, listener) { if (windowListeners.get(type) === listener) windowListeners.delete(type); },
  } } };
  const attributes = new Map();
  const classes = new Set();
  const container = {
    classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };
  const map = {
    sources, layers, listeners, windowListeners, canvas, container,
    dragPan: { isEnabled: () => panEnabled, enable() { panEnabled = true; }, disable() { panEnabled = false; } },
    getCanvas: () => canvas,
    getContainer: () => container,
    getStyle: () => removed || !styleLoaded ? undefined : {},
    isStyleLoaded: () => styleLoaded,
    getSource: id => sources.get(id),
    addSource(id, source) { assert.ok(!sources.has(id)); sources.set(id, { ...source, setData(data) { this.data = data; } }); },
    removeSource(id) { sources.delete(id); },
    getLayer: id => layers.get(id),
    addLayer(layer) { assert.ok(!layers.has(layer.id)); layers.set(layer.id, layer); },
    removeLayer(id) { layers.delete(id); },
    on(type, layer, listener) {
      if (typeof layer === "function") { listener = layer; layer = ""; }
      const key = `${type}:${layer}`;
      const values = listeners.get(key) ?? new Set();
      values.add(listener); listeners.set(key, values);
    },
    off(type, layer, listener) {
      if (typeof layer === "function") { listener = layer; layer = ""; }
      const key = `${type}:${layer}`;
      listeners.get(key)?.delete(listener);
      if (!listeners.get(key)?.size) listeners.delete(key);
    },
    emit(type, event = {}, layer = "") { for (const listener of listeners.get(`${type}:${layer}`) ?? []) listener(event); },
    unloadStyle() { styleLoaded = false; sources.clear(); layers.clear(); },
    loadStyle() { styleLoaded = true; this.emit("style.load"); },
    remove() { removed = true; sources.clear(); layers.clear(); },
  };
  return map;
}
function event(longitude, latitude, button = 0) {
  return { lngLat: { lng: longitude, lat: latitude }, originalEvent: { button }, prevented: false, preventDefault() { this.prevented = true; } };
}
function distance(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b[1] - a[1]) * rad / 2) ** 2
    + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin((b[0] - a[0]) * rad / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

test("DEV entry starts collapsed and hidden maps expose no editor or focus targets", () => {
  const map = fakeMap();
  assert.equal(renderToStaticMarkup(createElement(EarthModelEditor, { map, visible: false })), "");
  const html = renderToStaticMarkup(createElement(EarthModelEditor, { map, visible: true }));
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /DEV 3D/);
  assert.doesNotMatch(html, /<section|<input|<select/);
  assert.equal(map.listeners.size, 0);
  assert.equal(map.sources.size, 0);
});

test("zone preview uses metres at different latitudes and heading points clockwise from north", () => {
  for (const latitude of [-75, 0, 48.85826, 80]) {
    const data = earthModelEditorData({ ...placement, latitude });
    const zone = data.features.find(feature => feature.properties.role === "zone");
    assert.equal(zone.properties.enabled, true);
    const ring = zone.geometry.coordinates[0];
    assert.deepEqual(ring.at(-1), ring[0]);
    for (const point of ring) assert.ok(Math.abs(distance([placement.longitude, latitude], point) - 80) < .01);
    const tip = data.features.find(feature => feature.properties.role === "heading").geometry.coordinates[1];
    assert.ok(tip[1] > latitude);
    assert.ok(Math.abs(tip[0] - placement.longitude) < 1e-8);
    const east = earthModelEditorData({ ...placement, latitude, headingDegrees: 90 })
      .features.find(feature => feature.properties.role === "heading").geometry.coordinates[1];
    assert.ok(east[0] > placement.longitude);
    assert.ok(Math.abs(east[1] - latitude) < 1e-5);
  }
});

test("preview retains a faint radius when exclusion is off and removes it at zero radius", () => {
  const data = earthModelEditorData({ ...placement, excludeBuildings: false });
  assert.equal(data.features.find(feature => feature.properties.role === "zone").properties.enabled, false);
  assert.equal(earthModelEditorData({ ...placement, exclusionRadiusMeters: 0 }).features.length, 2);
  assert.deepEqual(earthModelEditorData(null), { type: "FeatureCollection", features: [] });
});

test("focus leaves room above a complete tower and moves its base down beside the desktop editor", () => {
  const viewport = { width: 1280, height: 900, verticalFieldOfView: 36.87,
    available: { left: 390, top: 32, right: 1204, bottom: 788 } };
  const camera = earthModelEditorCamera(placement, viewport);
  assert.ok(camera.zoom >= 15.6 && camera.zoom < 16.5, "do not jump into a 330m model at zoom17.5");
  assert.equal(camera.pitch, 55);
  assert.ok(camera.offset[0] > 0 && camera.offset[1] > 0);
  const taller = earthModelEditorCamera({ ...placement, heightMeters: 660 }, viewport);
  assert.ok(taller.zoom <= camera.zoom);
  const raised = earthModelEditorCamera({ ...placement, elevationMeters: 200 }, viewport);
  assert.ok(raised.zoom <= camera.zoom);
  const northern = earthModelEditorCamera({ ...placement, latitude: 65 }, viewport);
  assert.ok(northern.zoom <= camera.zoom);
});

test("phone focus stays in 3D and fits the tower into the free area above the bottom panel", () => {
  const viewport = { width: 390, height: 844, verticalFieldOfView: 36.87,
    available: { left: 20, top: 24, right: 370, bottom: 340 } };
  const camera = earthModelEditorCamera(placement, viewport);
  assert.ok(camera.zoom >= 15.6);
  assert.ok(camera.pitch >= 30 && camera.pitch < 55);
  assert.equal(camera.offset[0], 0);
  const baseY = viewport.height / 2 + camera.offset[1];
  assert.ok(baseY < viewport.available.bottom && baseY > 260);
  // Independent pinhole-camera estimate confirms the complete raised
  // silhouette has room, instead of checking only the chosen zoom constant.
  const metresPerPixel = 40_030_228.884 * Math.cos(placement.latitude * Math.PI / 180) / (512 * 2 ** camera.zoom);
  const cameraDistance = viewport.height * metresPerPixel / (2 * Math.tan(viewport.verticalFieldOfView * Math.PI / 360));
  const angle = camera.pitch * Math.PI / 180;
  const pixels = placement.heightMeters * Math.sin(angle) / metresPerPixel
    / (1 - placement.heightMeters * Math.cos(angle) / cameraDistance);
  assert.ok(baseY - pixels > viewport.available.top, "the roof must stay in the free viewport");
});

test("preview updates while vector tiles are loading instead of waiting for all tiles", () => {
  const map = fakeMap();
  map.isStyleLoaded = () => false;
  const controller = createEarthModelEditorMap(map, { onMove() {}, onPlace() {} });
  controller.update(placement);
  assert.deepEqual(map.sources.get(EARTH_MODEL_EDITOR_SOURCE).data, earthModelEditorData(placement));
  controller.update({ ...placement, headingDegrees: 45 });
  assert.deepEqual(map.sources.get(EARTH_MODEL_EDITOR_SOURCE).data, earthModelEditorData({ ...placement, headingDegrees: 45 }));
  controller.dispose();
});

test("editor releases native landmark pointer areas only during its lifetime and restores the prior attribute", () => {
  const map = fakeMap();
  const attribute = "data-earth-model-editor-active";
  assert.equal(map.container.getAttribute(attribute), null);
  const first = createEarthModelEditorMap(map, { onMove() {}, onPlace() {} });
  assert.equal(map.container.getAttribute(attribute), "true");
  first.update(placement);
  assert.equal(map.container.getAttribute(attribute), "true");
  first.dispose();
  assert.equal(map.container.getAttribute(attribute), null);
  map.container.setAttribute(attribute, "previous-owner");
  const second = createEarthModelEditorMap(map, { onMove() {}, onPlace() {} });
  assert.equal(map.container.getAttribute(attribute), "true");
  second.dispose(); second.dispose();
  assert.equal(map.container.getAttribute(attribute), "previous-owner");
});

test("place mode consumes exactly one map tap, wraps longitude, and cancellation preserves coordinates", () => {
  const map = fakeMap();
  const moved = [];
  const placed = [];
  const controller = createEarthModelEditorMap(map, { onMove: (...point) => moved.push(point), onPlace: (...point) => placed.push(point) });
  controller.update(placement);
  map.emit("click", event(15, 20));
  assert.deepEqual(placed, []);
  controller.update(placement, true);
  assert.equal(map.canvas.style.cursor, "crosshair");
  map.emit("click", event(181, 45));
  map.emit("click", event(17, 25));
  assert.deepEqual(placed, [[-179, 45]]);
  assert.deepEqual(moved, []);
  assert.equal(map.canvas.style.cursor, "default");
  controller.update(placement, true);
  controller.update(placement, false);
  map.emit("click", event(30, 40));
  assert.deepEqual(placed, [[-179, 45]]);
  controller.dispose();
});

test("mouse drag changes the monument only and restores the prior pan state after release outside the map", () => {
  const map = fakeMap();
  const moved = [];
  const controller = createEarthModelEditorMap(map, { onMove: (...point) => moved.push(point), onPlace() {} });
  controller.update(placement);
  map.emit("mousedown", event(0, 0, 2), EARTH_MODEL_EDITOR_ANCHOR);
  map.emit("mousemove", event(10, 20));
  assert.deepEqual(moved, []);
  const down = event(0, 0);
  map.emit("mousedown", down, EARTH_MODEL_EDITOR_ANCHOR);
  assert.equal(down.prevented, true);
  assert.equal(map.dragPan.isEnabled(), false);
  assert.equal(map.canvas.style.cursor, "grabbing");
  map.emit("mousemove", event(10, 20));
  controller.update({ ...placement, longitude: 10, latitude: 20 });
  assert.equal(map.canvas.style.cursor, "grabbing", "a preview update must not interrupt an active drag");
  map.windowListeners.get("mouseup")();
  assert.deepEqual(moved, [[10, 20]]);
  assert.equal(map.dragPan.isEnabled(), true);
  map.emit("mousemove", event(15, 25));
  assert.equal(moved.length, 1);
  map.dragPan.disable();
  map.emit("mousedown", down, EARTH_MODEL_EDITOR_ANCHOR);
  map.windowListeners.get("blur")();
  assert.equal(map.dragPan.isEnabled(), false, "an already disabled camera is never enabled by the editor");
  controller.dispose();
});

test("style recreation restores current preview once and disposal removes all owned resources and handlers", () => {
  const map = fakeMap();
  const controller = createEarthModelEditorMap(map, { onMove() {}, onPlace() {} });
  controller.update(placement, true);
  const changed = { ...placement, headingDegrees: 112, exclusionRadiusMeters: 120 };
  map.unloadStyle();
  controller.update(changed, true);
  assert.equal(map.sources.size, 0);
  map.loadStyle();
  assert.equal(map.sources.size, 1);
  assert.equal(map.layers.size, 3);
  assert.deepEqual(map.sources.get(EARTH_MODEL_EDITOR_SOURCE).data, earthModelEditorData(changed));
  map.loadStyle();
  assert.equal(map.layers.size, 3);
  controller.dispose(); controller.dispose();
  controller.update(placement);
  assert.equal(map.listeners.size, 0);
  assert.equal(map.windowListeners.size, 0);
  assert.equal(map.sources.size, 0);
  assert.equal(map.layers.size, 0);
  assert.equal(map.canvas.style.cursor, "default");
});

test("disposing after the parent removed its map is harmless", () => {
  const map = fakeMap();
  const controller = createEarthModelEditorMap(map, { onMove() {}, onPlace() {} });
  map.remove();
  assert.doesNotThrow(() => controller.dispose());
  assert.equal(map.listeners.size, 0);
});
