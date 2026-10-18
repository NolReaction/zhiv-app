import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { positionAccuracyData, globeZoom, positionZoom, prepareEarthStyle } = await vite.ssrLoadModule("/features/earth/map-style.ts");
const position = { latitude: 55.75, longitude: 37.61, accuracy: 150, timestamp: 1000 };

test("local style keeps the provider vector metadata without downloading glyphs, raster or sprites", () => {
  const source = { version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sprite: "https://tiles.openfreemap.org/sprites/liberty", sources: { osm: { type: "vector", attribution: "OSM", tiles: ["https://tiles.openfreemap.org/{z}/{x}/{y}.pbf"] } },
    layers: [{ id: "label", type: "symbol", layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"] } },
      { id: "icon", type: "symbol", layout: { "icon-image": "park" } }] };
  const style = prepareEarthStyle(source);
  assert.equal(style.glyphs, undefined);
  assert.match(source.glyphs, /fonts/, "cached provider JSON remains untouched");
  assert.deepEqual(style.sources["earth-streets"], source.sources.osm);
  assert.equal(style.sprite, undefined);
  assert.ok(style.layers.every(layer => !layer.layout?.["icon-image"]));
  assert.ok(style.layers.filter(layer => layer.type === "symbol").every(layer => layer.layout["text-font"].includes("Arial")));
  for (const value of [null, "<html>", {}, { ...source, version: 7 }, { ...source, layers: null }]) assert.throws(() => prepareEarthStyle(value));
});

function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const latitudeDelta = (b[1] - a[1]) * radians;
  const longitudeDelta = (b[0] - a[0]) * radians;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

test("uncertainty boundary stays at the reported radius in meters at different latitudes", () => {
  for (const latitude of [-75, -20, 0, 55.75, 80]) {
    for (const accuracy of [1, 150, 5000, 100000]) {
      const value = { ...position, latitude, accuracy };
      const ring = positionAccuracyData(value).features[0].geometry.coordinates[0];
      assert.equal(ring.length, 65);
      assert.deepEqual(ring.at(-1), ring[0]);
      for (const point of ring) assert.ok(Math.abs(distanceMeters([value.longitude, latitude], point) - accuracy) < .01);
    }
  }
});

test("date-line fixes draw a local area instead of a world-spanning polygon", () => {
  for (const longitude of [179.999, -179.999]) {
    const value = { ...position, latitude: 35, longitude, accuracy: 5000 };
    const ring = positionAccuracyData(value).features[0].geometry.coordinates[0];
    assert.ok(Math.max(...ring.map(point => point[0])) - Math.min(...ring.map(point => point[0])) < 1);
    for (let index = 1; index < ring.length; index += 1) assert.ok(Math.abs(ring[index][0] - ring[index - 1][0]) < 1);
  }
});

test("pole-enclosing fixes have a finite closed cap without crossing Earth's interior", () => {
  for (const latitude of [89.999, -89.999]) {
    const ring = positionAccuracyData({ ...position, latitude, accuracy: 5000 }).features[0].geometry.coordinates[0];
    assert.deepEqual(ring.at(-1), ring[0]);
    assert.ok(ring.every(point => point.every(Number.isFinite) && Math.abs(point[1]) <= 90));
    for (let index = 1; index < ring.length; index += 1) {
      if (Math.abs(ring[index][0] - ring[index - 1][0]) > 180) {
        assert.equal(Math.abs(ring[index][1]), 90);
        assert.equal(Math.abs(ring[index - 1][1]), 90);
      }
    }
  }
});

test("clearing or invalidating the fix removes its uncertainty feature", () => {
  for (const value of [null, { ...position, accuracy: 0 }, { ...position, accuracy: -1 }, { ...position, accuracy: Infinity }, { ...position, latitude: NaN }, { ...position, latitude: 91 }, { ...position, longitude: -181 }]) {
    assert.deepEqual(positionAccuracyData(value), { type: "FeatureCollection", features: [] });
  }
});

test("camera accommodates both small viewports and low-accuracy fixes", () => {
  assert.ok(globeZoom(320, 200) < globeZoom(900, 700));
  assert.equal(globeZoom(300, 600), globeZoom(600, 300));
  assert.ok(Number.isFinite(globeZoom(0, 0)));
  assert.ok(positionZoom(5000) < positionZoom(20));
  assert.equal(positionZoom(0), 15);
  assert.ok(positionZoom(200000) >= 3);
});
