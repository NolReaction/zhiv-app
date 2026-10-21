import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import Point from "@mapbox/point-geometry";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { earthLoadedTileCoverage, earthLoadingTileFootprint, createEarthTileLoadingOverlay } = await vite.ssrLoadModule("/features/earth/tile-loading-overlay.ts");
const { appendEarthTileBase, EARTH_TILE_BASE_LAYER } = await vite.ssrLoadModule("/features/earth/tile-base.ts");
after(() => vite.close());

const emptyTile = new VectorTile(new PbfReader(appendEarthTileBase(new ArrayBuffer(0))));
const base = (x, y, z) => emptyTile.layers[EARTH_TILE_BASE_LAYER].feature(0).toGeoJSON(x, y, z);
const mercatorY = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
const latitude = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
const event = (type, x = 8, y = 8, z = 4, overscaledZ = z) => ({ type, sourceId: "earth-streets", coord: { canonical: { x, y, z }, overscaledZ, wrap: 0 } });

function fixture() {
  const svg = { attributes: {}, style: {}, innerHTML: "", removed: 0,
    setAttribute(key, value) { this.attributes[key] = value; }, remove() { this.removed++; } };
  const container = { clientWidth: 600, clientHeight: 400,
    ownerDocument: { createElementNS(namespace, tag) { assert.equal(namespace, "http://www.w3.org/2000/svg"); assert.equal(tag, "svg"); return svg; } },
    append(element) { assert.equal(element, svg); } };
  const state = { features: [], queries: 0, zoom: 4, worldSize: 8192, center: { lng: 0, lat: 0 }, source: true };
  const map = {
    getContainer: () => container, getCanvasContainer: () => container,
    getSource: () => state.source ? {} : undefined,
    getCenter: () => state.center, getZoom: () => state.zoom,
    project(position) {
      const lng = Array.isArray(position) ? position[0] : position.lng;
      const lat = Array.isArray(position) ? position[1] : position.lat;
      return { x: (lng - state.center.lng) / 360 * state.worldSize + container.clientWidth / 2,
        y: (mercatorY(lat) - mercatorY(state.center.lat)) * state.worldSize + container.clientHeight / 2 };
    },
    unproject(point) { return { lng: (point.x - container.clientWidth / 2) / state.worldSize * 360 + state.center.lng,
      lat: latitude((point.y - container.clientHeight / 2) / state.worldSize + mercatorY(state.center.lat)) }; },
    querySourceFeatures(source, options) {
      assert.equal(source, "earth-streets"); assert.equal(options.sourceLayer, EARTH_TILE_BASE_LAYER);
      state.queries++; return state.features;
    },
  };
  const overlay = createEarthTileLoadingOverlay(map);
  overlay.setVisible(true);
  return { map, state, svg, overlay, container };
}

test("coverage derives canonical IDs from real decoded empty MVT base geometry, including the date line", () => {
  const tiles = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 8, z: 4 }, { x: 15, y: 7, z: 4 }, { x: 8278, y: 5235, z: 14 }];
  const features = tiles.map(tile => base(tile.x, tile.y, tile.z));
  assert.deepEqual(earthLoadedTileCoverage([...features, features[0]]), tiles);
  assert.deepEqual(earthLoadedTileCoverage([{ geometry: { type: "Point", coordinates: [0, 0] } }, { geometry: { type: "Polygon", coordinates: [[[NaN, 0], [1, 1], [2, 1], [NaN, 0]]] } }]), []);
});

test("only real pending tile events create footprints; a loaded empty ocean tile stays uncovered", () => {
  const s = fixture();
  s.overlay.refresh(); assert.equal(s.svg.attributes["data-patch-count"], "0");
  s.overlay.observe({ ...event("sourcedataloading"), sourceId: "unrelated-glyphs" });
  s.overlay.refresh(); assert.equal(s.svg.attributes["data-patch-count"], "0");
  s.overlay.observe(event("sourcedataloading")); s.overlay.refresh();
  assert.equal(s.svg.attributes["data-patch-count"], "1");
  assert.match(s.svg.innerHTML, /data-loading-tile="4\/8\/8"/);
  assert.match(s.svg.innerHTML, /Загружаем/);
  s.state.features = [base(8, 8, 4)]; s.overlay.refresh();
  assert.equal(s.svg.attributes["data-patch-count"], "0", "the injected tile base proves that even featureless ocean has loaded");
  s.state.features = []; s.overlay.observe(event("sourcedata")); s.overlay.refresh();
  assert.equal(s.svg.attributes["data-patch-count"], "0");
});

test("actual SVG masks subtract loaded child tiles instead of covering their rendered map", async () => {
  const s = fixture();
  s.overlay.observe(event("sourcedataloading"));
  s.state.features = [base(16, 16, 5)];
  s.overlay.refresh();
  assert.equal(s.svg.attributes["data-patch-count"], "1");
  const pixels = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">${s.svg.innerHTML}</svg>`)).ensureAlpha().raw().toBuffer();
  const alpha = (x, y) => pixels[(y * 600 + x) * 4 + 3];
  assert.equal(alpha(400, 300), 0, "loaded child geography is excluded by the real mask renderer");
  assert.ok(alpha(580, 300) > 0, "the remaining missing strip still has a loading treatment");
  assert.equal(alpha(100, 100), 0, "other map areas are untouched");
  s.state.features = [base(16, 16, 5), base(17, 16, 5), base(16, 17, 5), base(17, 17, 5)];
  s.overlay.refresh(); assert.equal(s.svg.attributes["data-patch-count"], "0");
});

test("aborting an old overscaled request does not erase a new request for the same canonical tile", () => {
  const s = fixture();
  s.overlay.observe(event("sourcedataloading", 8, 8, 4, 4));
  s.overlay.observe(event("sourcedataloading", 8, 8, 4, 5));
  s.overlay.observe(event("sourcedataabort", 8, 8, 4, 4));
  s.overlay.refresh(); assert.equal(s.svg.attributes["data-patch-count"], "1");
  s.overlay.observe(event("sourcedataabort", 8, 8, 4, 5));
  s.overlay.refresh(); assert.equal(s.svg.attributes["data-patch-count"], "0");
});

test("failure and offline patches remain honest until data arrives or the source is replaced", () => {
  const s = fixture();
  s.overlay.observe({ type: "error", sourceId: "earth-streets", tile: { tileID: event("error").coord } });
  s.overlay.refresh(); assert.match(s.svg.innerHTML, /data-state="failed"/); assert.match(s.svg.innerHTML, /Не загрузилось/);
  s.overlay.setStatus("waiting", false); s.overlay.refresh(); assert.match(s.svg.innerHTML, /Нет сети/);
  s.overlay.setStatus("retrying", true); s.overlay.observe(event("sourcedataloading")); s.overlay.refresh();
  assert.match(s.svg.innerHTML, /data-state="loading"/);
  s.overlay.setStatus("failed"); s.overlay.refresh(); assert.match(s.svg.innerHTML, /Не загрузилось/);
  s.overlay.observe({ type: "sourcedata", sourceId: "earth-streets", sourceDataType: "metadata" });
  s.overlay.refresh(); assert.equal(s.svg.attributes["data-patch-count"], "0");
});

test("hidden/overview/disposed overlays do no coverage work and geometry stays bounded to 16 visible patches", () => {
  const s = fixture();
  s.container.clientWidth = 512; s.container.clientHeight = 512; s.state.worldSize = 512;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s.overlay.observe(event("sourcedataloading", x, y, 4));
  s.overlay.refresh(); assert.equal(s.svg.attributes["data-patch-count"], "16");
  const queries = s.state.queries;
  s.overlay.setVisible(false); s.overlay.refresh();
  assert.equal(s.svg.style.display, "none"); assert.equal(s.state.queries, queries);
  s.overlay.setVisible(true); s.state.zoom = 3.9; s.overlay.refresh();
  assert.equal(s.svg.attributes["data-patch-count"], "0"); assert.equal(s.state.queries, queries);
  s.overlay.dispose(); s.overlay.dispose(); s.overlay.observe(event("sourcedataloading")); s.overlay.refresh();
  assert.equal(s.svg.removed, 1); assert.equal(s.state.queries, queries);
});

test("many missing tiles keep a sparse loading treatment with at most two spaced badges", async () => {
  const s = fixture();
  s.container.clientWidth = 900; s.container.clientHeight = 600; s.state.worldSize = 4096;
  for (let y = 5; y <= 10; y++) for (let x = 5; x <= 10; x++) s.overlay.observe(event("sourcedataloading", x, y, 4));
  s.overlay.refresh();
  assert.ok(Number(s.svg.attributes["data-patch-count"]) > 2);
  assert.ok(Number(s.svg.attributes["data-badge-count"]) <= 2);
  assert.ok((s.svg.innerHTML.match(/data-loading-badge=/g) ?? []).length <= 2);
  const badges = [...s.svg.innerHTML.matchAll(/data-loading-badge="" transform="translate\(([^ ]+) ([^)]+)\)"/g)];
  if (badges.length === 2) assert.ok(Math.hypot(Number(badges[0][1]) - Number(badges[1][1]), Number(badges[0][2]) - Number(badges[1][2])) > 220);
  const pixels = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">${s.svg.innerHTML}</svg>`)).ensureAlpha().raw().toBuffer();
  const nonBadgeAlpha = pixels[(590 * 900 + 890) * 4 + 3];
  assert.ok(nonBadgeAlpha < 80, "unloaded geography remains readable through a light mist instead of an opaque repeated texture");
});

test("native globe projection rejects the reverse hemisphere and keeps date-line tile boundaries near the viewport", async () => {
  const load = path => vite.ssrLoadModule(`/node_modules/maplibre-gl/src/${path}.ts`);
  const { Camera } = await load("ui/camera");
  const { LngLat } = await load("geo/lng_lat");
  const { createProjectionFromName } = await load("geo/projection/projection_factory");
  const camera = new Camera({ minZoom: -1.5, maxZoom: 18, minPitch: 0, maxPitch: 60, bearingSnap: 0, zoomSnap: 0,
    terrain: null, transformConstrain: null, requestRenderFrame: () => 0, cancelRenderFrame: () => {} });
  camera.transform.resize(800, 600, true);
  const globe = createProjectionFromName("globe", undefined, {});
  camera.migrateProjection(globe.transform, globe.cameraHelper);
  camera.jumpTo({ center: [179, 0], zoom: 4, bearing: 31 });
  const map = { getCenter: () => camera.getCenter(), project: position => camera.transform.locationToScreenPoint(LngLat.convert(position)),
    unproject: point => camera.transform.screenPointToLocation(new Point(point.x, point.y)) };
  const visible = earthLoadingTileFootprint(map, { z: 4, x: 0, y: 8 }, 800, 600);
  assert.ok(visible && visible.area > 64, "wrapped tile immediately east of the date line remains visible");
  assert.ok(visible.points.every(point => point.x >= 0 && point.x <= 800 && point.y >= 0 && point.y <= 600));
  assert.equal(earthLoadingTileFootprint(map, { z: 4, x: 7, y: 8 }, 800, 600), null, "reverse-side projection must not produce a phantom loading square");
});
