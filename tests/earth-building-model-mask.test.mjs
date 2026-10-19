import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { featureFilter, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createEarthBuildingModelMask, earthBuildingModelFilter } = await vite.ssrLoadModule("/features/earth/building-model-mask.ts");
const { createEarthBuildingLayer, EARTH_BUILDING_FILTER, EARTH_BUILDINGS_3D_LAYER } = await vite.ssrLoadModule("/features/earth/building-style.ts");

const placement = (values = {}) => ({ id: "eiffel-tower", longitude: 2.29444, latitude: 48.85826,
  heightMeters: 330, headingDegrees: 0, elevationMeters: 0, exclusionRadiusMeters: 110, excludeBuildings: true, ...values });
const active = new Set(["eiffel-tower"]);
const tilePoint = ([longitude, latitude], canonical) => ({
  x: ((longitude / 360 + 0.5) * 2 ** canonical.z - canonical.x) * 8192,
  y: ((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 2 ** canonical.z - canonical.y) * 8192,
});
function polygonFeature(ring, canonical, properties = {}) {
  return { type: 3, geometry: [ring.map(point => tilePoint(point, canonical))], properties: { render_height: 300, ...properties } };
}
function localRing(longitude, latitude, eastMeters, northMeters, widthMeters = 20) {
  const longitudeMeter = 1 / (111_320 * Math.cos(latitude * Math.PI / 180));
  const latitudeMeter = 1 / 111_320;
  return [[eastMeters - widthMeters, northMeters - widthMeters], [eastMeters + widthMeters, northMeters - widthMeters],
    [eastMeters + widthMeters, northMeters + widthMeters], [eastMeters - widthMeters, northMeters + widthMeters],
    [eastMeters - widthMeters, northMeters - widthMeters]].map(([east, north]) => [longitude + east * longitudeMeter, latitude + north * latitudeMeter]);
}
function canonicalFor(longitude, latitude, z = 16) {
  return { z, x: Math.floor((longitude / 360 + 0.5) * 2 ** z),
    y: Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 2 ** z) };
}

test("native distance filters polygon footprints, retaining surrounding buildings and every existing provider condition", () => {
  const model = placement();
  const filter = earthBuildingModelFilter(EARTH_BUILDING_FILTER, [model], active);
  const layer = { ...createEarthBuildingLayer("vector", "#fff"), filter };
  assert.deepEqual(validateStyleMin({ version: 8, sources: { vector: { type: "vector", tiles: ["https://example.test/{z}/{x}/{y}.pbf"] } }, layers: [layer] }), []);
  const compiled = featureFilter(filter, "filter");
  assert.equal(compiled.needGeometry, true);
  const canonical = canonicalFor(model.longitude, model.latitude);
  const visible = (east, north, width = 20, properties = {}) => compiled.filter({ zoom: 16 },
    polygonFeature(localRing(model.longitude, model.latitude, east, north, width), canonical, properties), canonical);
  assert.equal(visible(0, 0), false, "anchor inside a polygon has distance zero");
  assert.equal(visible(120, 0), false, "a polygon crossing the edge of the exclusion circle is removed");
  assert.equal(visible(170, 0), true, "a nearby building outside the circle stays 3D");
  assert.equal(visible(300, 0, 20, { hide_3d: true }), false);
  assert.equal(visible(300, 0, 20, { indoor: "yes" }), false);
  assert.equal(visible(300, 0, 20, { location: "underground" }), false);
  assert.equal(visible(300, 0, 20, { render_height: 0 }), false);
});

test("mask uses geographic geometry on both sides of a tile boundary and at high latitudes", () => {
  for (const [longitude, latitude] of [[0, 0], [2.29444, 48.85826], [179.999, 70]]) {
    const model = placement({ longitude, latitude });
    const compiled = featureFilter(earthBuildingModelFilter(EARTH_BUILDING_FILTER, [model], active), "filter");
    const origin = canonicalFor(longitude, latitude);
    // The same geographic fragment can occur in adjacent buffered source tiles.
    for (const canonical of [origin, { ...origin, x: origin.x - 1 }, { ...origin, y: origin.y - 1 }]) {
      assert.equal(compiled.filter({ zoom: 16 }, polygonFeature(localRing(longitude, latitude, 0, 0), canonical), canonical), false);
      assert.equal(compiled.filter({ zoom: 16 }, polygonFeature(localRing(longitude, latitude, 250, 0), canonical), canonical), true);
    }
  }
});

test("local masks reach canonical building polygons across the international date line", () => {
  for (const longitude of [-179.9997, 179.9997]) {
    const model = placement({ longitude, latitude: 0 });
    const opposite = -longitude;
    const canonical = canonicalFor(opposite, 0);
    const compiled = featureFilter(earthBuildingModelFilter(EARTH_BUILDING_FILTER, [model], active), "filter");
    const feature = polygonFeature(localRing(opposite, 0, 0, 0, 5), canonical);
    assert.equal(compiled.filter({ zoom: 16 }, feature, canonical), false);
    const outside = polygonFeature(localRing(opposite, 0, Math.sign(opposite) * -300, 0, 5), canonical);
    assert.equal(compiled.filter({ zoom: 16 }, outside, canonical), true);
  }
});

test("moving or disabling a model restores its old area and masks only its new position", () => {
  const original = placement();
  const moved = placement({ longitude: original.longitude + 0.01 });
  const canonical = canonicalFor(original.longitude, original.latitude);
  const feature = polygonFeature(localRing(original.longitude, original.latitude, 0, 0), canonical);
  assert.equal(featureFilter(earthBuildingModelFilter(EARTH_BUILDING_FILTER, [original], active), "filter").filter({ zoom: 16 }, feature, canonical), false);
  assert.equal(featureFilter(earthBuildingModelFilter(EARTH_BUILDING_FILTER, [moved], active), "filter").filter({ zoom: 16 }, feature, canonical), true);
  assert.equal(earthBuildingModelFilter(EARTH_BUILDING_FILTER, [original], new Set()), EARTH_BUILDING_FILTER);
  assert.equal(earthBuildingModelFilter(EARTH_BUILDING_FILTER, [placement({ excludeBuildings: false })], active), EARTH_BUILDING_FILTER);
  assert.equal(earthBuildingModelFilter(EARTH_BUILDING_FILTER, [placement({ exclusionRadiusMeters: NaN })], active), EARTH_BUILDING_FILTER);
});

function mapStub(filter = EARTH_BUILDING_FILTER) {
  let layer = { type: "fill-extrusion", sourceLayer: "building" };
  let current = structuredClone(filter);
  const calls = [];
  return { calls, getLayer: () => layer, getFilter: () => current,
    setFilter(id, next) { calls.push([id, structuredClone(next)]); current = next; },
    changeLayer(nextFilter) { layer = { type: "fill-extrusion", sourceLayer: "building" }; current = structuredClone(nextFilter); },
    get current() { return current; },
  };
}

test("controller changes only its 3D layer, skips identical updates, and restores the exact original filter", () => {
  const map = mapStub();
  const controller = createEarthBuildingModelMask(map);
  controller.setPlacements([placement()], active);
  controller.setPlacements([placement()], active);
  assert.equal(map.calls.length, 1);
  assert.equal(map.calls[0][0], EARTH_BUILDINGS_3D_LAYER);
  controller.setPlacements([placement({ headingDegrees: 90 })], active);
  assert.equal(map.calls.length, 1, "rotation does not change a circular exclusion");
  controller.setPlacements([placement({ longitude: 3 })], active);
  assert.equal(map.calls.length, 2);
  controller.setPlacements([placement()], new Set());
  assert.deepEqual(map.current, EARTH_BUILDING_FILTER);
  controller.dispose();
  controller.dispose();
  controller.setPlacements([placement()], active);
  assert.deepEqual(map.current, EARTH_BUILDING_FILTER);
});

test("style replacement captures the new filter and dispose does not overwrite another owner's filter", () => {
  const map = mapStub();
  const controller = createEarthBuildingModelMask(map);
  controller.setPlacements([placement()], active);
  const replacement = ["all", EARTH_BUILDING_FILTER, ["==", ["get", "class"], "building"]];
  map.changeLayer(replacement);
  controller.setPlacements([placement()], active);
  controller.dispose();
  assert.deepEqual(map.current, replacement);
  const other = createEarthBuildingModelMask(map);
  other.setPlacements([placement()], active);
  map.setFilter(EARTH_BUILDINGS_3D_LAYER, ["==", ["get", "test"], true]);
  other.dispose();
  assert.deepEqual(map.current, ["==", ["get", "test"], true]);
});

test("incomplete embedding adapters and old map mocks remain a safe no-op", () => {
  const controller = createEarthBuildingModelMask({ getLayer: () => ({ type: "fill-extrusion", sourceLayer: "building" }) });
  assert.doesNotThrow(() => controller.setPlacements([placement()], active));
  assert.doesNotThrow(() => controller.dispose());
});
