import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createExpression, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { createEarthOceanMaterialImage, registerEarthOceanMaterialImage, earthOceanBackgroundLayer,
  earthOceanWaterLayer, earthOceanPoint, createEarthOceanMotion, EARTH_OCEAN_MATERIAL_IMAGE } = await vite.ssrLoadModule("/features/earth/globe-ocean.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
globalThis.document = { createElement: tag => ({ tag, style: {}, attributes: {}, children: [],
  setAttribute(name, value) { this.attributes[name] = value; }, append(child) { this.children.push(child); } }) };
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
  await vite.close();
});

function fixture() {
  const images = new Map(), uploads = [], markers = [], queried = [];
  const state = { zoom: 2, features: [], offset: 0, repaints: 0, layers: new Set(["earth-land", "earth-water", "earth-overview-ice", "earth-overview-lakes", "earth-detail-land"]) };
  const map = {
    hasImage: id => images.has(id),
    addImage(id, image, options) { assert.ok(!images.has(id)); images.set(id, { image, options }); },
    updateImage(id, image) { assert.ok(images.has(id)); uploads.push({ id, pixels: image.data.slice() }); },
    triggerRepaint() { state.repaints++; },
    getZoom: () => state.zoom,
    unproject: point => ({ lng: Array.isArray(point) ? point[0] : point.x, lat: Array.isArray(point) ? point[1] : point.y }),
    project: point => ({ x: point.lng + state.offset, y: point.lat }),
    getLayer: id => state.layers.has(id) ? { id } : undefined,
    queryRenderedFeatures: (point, options) => { queried.push({ point, options }); return state.features; },
  };
  class Marker {
    constructor(options) { this.options = options; this.removed = 0; markers.push(this); }
    setLngLat(location) { this.location = location; return this; }
    addTo(owner) { assert.equal(owner, map); return this; }
    remove() { this.removed++; return this; }
  }
  return { map, Marker, state, images, uploads, markers, queried };
}

test("ocean frames are independent small translucent images with deterministic seamless movement", () => {
  const first = createEarthOceanMaterialImage(), next = createEarthOceanMaterialImage(4_000);
  assert.equal(first.width, 128); assert.equal(first.height, 128); assert.equal(first.data.byteLength, 65_536);
  assert.deepEqual(first.data, createEarthOceanMaterialImage(48_000).data);
  assert.notDeepEqual(first.data, next.data);
  assert.notEqual(first.data.buffer, next.data.buffer);
  assert.ok(first.data.every((value, index) => index % 4 !== 3 || value === 46), "the base ocean colour remains visible");
  assert.ok(first.data.every((value, index) => index % 4 !== 1 || value >= 110), "bright crests must not overflow RGB channels into coloured specks");
  for (const frame of [first, next]) {
    const value = (x, y) => frame.data[(y * frame.width + x) * 4];
    let inner = 0, seam = 0, count = 0;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      if (x) { inner += Math.abs(value(x, y) - value(x - 1, y)); count++; }
      if (y) { inner += Math.abs(value(x, y) - value(x, y - 1)); count++; }
    }
    for (let i = 0; i < 128; i++) seam += Math.abs(value(0, i) - value(127, i)) + Math.abs(value(i, 0) - value(i, 127));
    assert.ok(seam / 256 < inner / count * 1.6, "periodic texture edges must not create a grid");
  }
  structuredClone(first, { transfer: [first.data.buffer] });
  assert.equal(first.data.byteLength, 0);
  assert.equal(createEarthOceanMaterialImage().data.byteLength, 65_536);
});

test("water overlays keep geographic masks, match the background and disappear before street zoom", () => {
  const filter = ["==", ["get", "kind"], "lake"];
  const background = earthOceanBackgroundLayer();
  const lake = earthOceanWaterLayer("lake-material", "local", undefined, filter);
  const detail = earthOceanWaterLayer("water-material", "streets", "water", ["!=", ["get", "brunnel"], "tunnel"]);
  const style = { version: 8, sources: { local: { type: "geojson", data: { type: "FeatureCollection", features: [] } }, streets: { type: "vector", tiles: ["https://example.com/{z}/{x}/{y}.pbf"] } }, layers: [background, lake, detail] };
  assert.deepEqual(validateStyleMin(style).map(error => error.message), []);
  assert.deepEqual(lake.filter, filter);
  assert.equal(detail["source-layer"], "water"); assert.equal(detail.minzoom, 4);
  assert.equal(background.paint["background-pattern"], EARTH_OCEAN_MATERIAL_IMAGE);
  assert.deepEqual(background.paint["background-opacity"], lake.paint["fill-opacity"]);
  assert.deepEqual(lake.paint, detail.paint);
  const opacity = createExpression(lake.paint["fill-opacity"], "fill-opacity");
  assert.equal(opacity.result, "success");
  assert.ok(opacity.value.evaluate({ zoom: 2 }) > 0.5);
  assert.equal(opacity.value.evaluate({ zoom: 8 }), 0);
});

test("water taps respect topmost land, ice and detailed water instead of treating all background as ocean", () => {
  const s = fixture();
  const feature = id => ({ layer: { id } });
  assert.deepEqual(earthOceanPoint(s.map, [20, 10]), { lng: 20, lat: 10 });
  s.state.layers.add("earth-fallback-ice"); s.state.layers.add("earth-fallback-lakes");
  for (const land of ["earth-land", "earth-overview-ice", "earth-fallback-ice", "earth-detail-land"]) {
    s.state.features = [feature(land)];
    assert.equal(earthOceanPoint(s.map, [20, 10]), null);
  }
  for (const water of ["earth-water", "earth-overview-lakes", "earth-fallback-lakes"]) {
    s.state.features = [feature(water), feature("earth-land")];
    assert.ok(earthOceanPoint(s.map, [20, 10]));
    s.state.features.reverse();
    assert.equal(earthOceanPoint(s.map, [20, 10]), null);
  }
  assert.ok(s.queried.every(query => query.options.layers.every(id => s.state.layers.has(id))));
  s.state.layers.clear();
  assert.equal(earthOceanPoint(s.map, [20, 10]), null, "style replacement must not create an unmasked water hit");
});

test("a clamped globe horizon or invalid pointer never creates a ripple in space", () => {
  const s = fixture();
  s.state.offset = 8;
  assert.equal(earthOceanPoint(s.map, { x: 20, y: 10 }), null);
  assert.equal(earthOceanPoint(s.map, [NaN, 10]), null);
  assert.equal(s.queried.length, 0, "reject sky before querying geographic features");
});

test("the shared clock starts explicitly, uploads at most four frames per second, and freezes without style/source mutations", () => {
  const s = fixture();
  registerEarthOceanMaterialImage(s.map); registerEarthOceanMaterialImage(s.map);
  assert.equal(s.images.size, 1);
  const motion = createEarthOceanMotion(s.map, s.Marker);
  motion.update(0); assert.equal(motion.ripple([1, 1], 0), false);
  assert.equal(s.uploads.length, 0);
  motion.setEnabled(true);
  for (let timestamp = 0; timestamp < 1_000; timestamp += 10) motion.update(timestamp);
  assert.equal(s.uploads.length, 4); assert.equal(s.state.repaints, 4);
  assert.notDeepEqual(s.uploads[0].pixels, s.uploads[3].pixels);
  motion.setEnabled(false); motion.update(2_000);
  motion.setEnabled(true); s.state.zoom = 8; motion.update(3_000);
  assert.equal(motion.ripple([1, 1], 3_000), false);
  assert.equal(s.uploads.length, 4);
  s.state.zoom = 2; s.images.clear(); motion.update(4_000);
  assert.equal(s.uploads.length, 4, "a style reset waits for explicit image registration");
  registerEarthOceanMaterialImage(s.map); motion.update(4_250);
  assert.equal(s.uploads.length, 5);
  motion.dispose(); motion.setEnabled(true); motion.update(5_000);
  assert.equal(s.uploads.length, 5);
});

test("adaptive ocean cadence preserves the full texture and absolute wave phase while halving uploads", () => {
  const s = fixture(); registerEarthOceanMaterialImage(s.map);
  const motion = createEarthOceanMotion(s.map, s.Marker);
  motion.setEnabled(true); motion.setIntervalMs(500);
  for (let timestamp = 0; timestamp <= 1_000; timestamp += 125) motion.update(timestamp);
  assert.equal(s.uploads.length, 3);
  assert.equal(s.uploads.at(-1).pixels.byteLength, 65_536);
  assert.deepEqual(s.uploads.at(-1).pixels, createEarthOceanMaterialImage(1_000).data,
    "slower cadence samples the same movement, not a slowed or degraded texture");
  motion.setIntervalMs(250); motion.update(1_250); assert.equal(s.uploads.length, 4);
  motion.setEnabled(false); motion.update(5_000); assert.equal(s.uploads.length, 4);
  motion.dispose(); motion.setIntervalMs(250); motion.update(6_000); assert.equal(s.uploads.length, 4);
});

test("tap ripples are bounded, short-lived native markers and are removed on pause/disposal", () => {
  const s = fixture();
  const motion = createEarthOceanMotion(s.map, s.Marker);
  motion.setEnabled(true);
  assert.equal(motion.ripple([4, 5], 0), true);
  assert.equal(motion.ripple([4, 5], 100), false, "a double-click must not allocate a burst of effects");
  for (const timestamp of [300, 600, 900]) assert.equal(motion.ripple([4, 5], timestamp), true);
  assert.equal(s.markers.length, 4); assert.equal(s.markers[0].removed, 1);
  assert.equal(s.markers.filter(marker => !marker.removed).length, 3);
  for (const marker of s.markers) {
    assert.equal(marker.options.pitchAlignment, "map"); assert.equal(marker.options.rotationAlignment, "map");
    assert.equal(marker.options.opacityWhenCovered, 0);
    assert.equal(marker.options.element.attributes["aria-hidden"], "true");
    assert.equal(marker.options.element.children.length, 2);
    assert.deepEqual(marker.location, { lng: 4, lat: 5 });
  }
  motion.update(2_200);
  assert.equal(s.markers.filter(marker => !marker.removed).length, 1);
  motion.setEnabled(false);
  assert.ok(s.markers.every(marker => marker.removed === 1));
  motion.setEnabled(true); assert.equal(motion.ripple([4, 5], 2_500), true);
  motion.dispose(); motion.dispose();
  assert.ok(s.markers.every(marker => marker.removed === 1));
  assert.equal(motion.ripple([4, 5], 3_000), false);
});
