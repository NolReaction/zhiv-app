import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import polygonClipping from "polygon-clipping";
import { createServer } from "vite";
import { createExpression, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const cacheDir = mkdtempSync(join(tmpdir(), "zhiv-earth-vegetation-"));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { EARTH_VEGETATION_SOURCE, EARTH_VEGETATION_LAYER, EARTH_VEGETATION_MAX_ZOOM,
  earthVegetationData, earthVegetationLayer } = await vite.ssrLoadModule("/features/earth/globe-vegetation.ts");
const json = path => JSON.parse(readFileSync(join(root, path), "utf8"));
const polygons = geometry => geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
const land = json("features/earth/data/land-110m.json").features.flatMap(feature => polygons(feature.geometry));
const excluded = json("features/earth/data/physical-110m.json").features.flatMap(feature => polygons(feature.geometry));
const cores = new Map(json("features/earth/data/biomes-illustrated.json").features
  .filter(feature => feature.properties.band === 4).map(feature => [feature.properties.region, feature]));
const ringArea = ring => Math.abs(ring.reduce((sum, point, index) => {
  const next = ring[(index + 1) % ring.length];
  return sum + point[0] * next[1] - next[0] * point[1];
}, 0)) / 2;
const area = geometry => geometry.reduce((sum, rings) => sum + ringArea(rings[0])
  - rings.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0);

test("ornamental vegetation is reproducible, bounded static geometry", () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ["scripts/prepare-earth-vegetation.mjs", "--check"], { cwd: root }));
  const serialized = JSON.stringify(earthVegetationData);
  assert.ok(Buffer.byteLength(serialized) < 220_000);
  assert.ok(gzipSync(serialized).length < 55_000);
  assert.ok(earthVegetationData.features.length <= 256);
  assert.equal(new Set(earthVegetationData.features.map(feature => feature.properties.cluster)).size, 49);
  assert.deepEqual(new Set(earthVegetationData.features.map(feature => feature.properties.family)), new Set(["boreal", "rainforest", "savanna"]));
  let vertices = 0;
  for (const feature of earthVegetationData.features) {
    assert.equal(feature.geometry.type, "MultiPolygon");
    assert.equal(feature.properties.family, cores.get(feature.properties.region).properties.biome);
    for (const polygon of feature.geometry.coordinates) for (const ring of polygon) {
      vertices += ring.length;
      assert.ok(ring.length >= 4);
      assert.deepEqual(ring[0], ring.at(-1));
      for (let index = 1; index < ring.length; index += 1) {
        assert.ok(ring[index].every(Number.isFinite));
        assert.ok(Math.abs(ring[index][0]) <= 180 && Math.abs(ring[index][1]) <= 75);
        assert.ok(Math.abs(ring[index][0] - ring[index - 1][0]) < 10, "each ornamental group is local, never a globe-spanning closure");
      }
    }
  }
  assert.ok(vertices < 8_000);
});

test("all canopies, shadows and trunks stay on their biome's land and outside lake/ice masks", () => {
  const all = earthVegetationData.features.flatMap(feature => feature.geometry.coordinates);
  assert.ok(area(polygonClipping.difference(all, land)) < 0.001, "only five-decimal clipping slivers are tolerated");
  assert.ok(area(polygonClipping.intersection(all, excluded)) < 0.001);
  for (const feature of earthVegetationData.features) {
    assert.ok(area(polygonClipping.difference(feature.geometry.coordinates, cores.get(feature.properties.region).geometry.coordinates)) < 0.0001,
      `${feature.properties.cluster}/${feature.properties.tone} cannot escape its biome core`);
  }
});

test("native sort order keeps shadows and trunks beneath crowns and lit facets", () => {
  const layer = earthVegetationLayer();
  assert.equal(layer.type, "fill");
  assert.equal(layer.id, EARTH_VEGETATION_LAYER);
  assert.equal(layer.source, EARTH_VEGETATION_SOURCE);
  const style = { version: 8, sources: { [EARTH_VEGETATION_SOURCE]: { type: "geojson", data: earthVegetationData,
    maxzoom: 0, buffer: 0, tolerance: 0 } }, layers: [layer] };
  assert.deepEqual(validateStyleMin(style).map(error => error.message), []);
  const order = { shadow: 0, trunk: 1, crown: 2, light: 3 };
  for (const feature of earthVegetationData.features) assert.equal(feature.properties.order, order[feature.properties.tone]);
  const color = createExpression(layer.paint["fill-color"], "fill-color");
  assert.equal(color.result, "success");
  const crowns = ["boreal", "rainforest", "savanna"].map(family => color.value.evaluate({ zoom: 2 }, { properties: { tone: "crown", family } }));
  assert.equal(new Set(crowns.map(value => JSON.stringify(value))).size, 3, "families keep distinct palettes");
});

test("vegetation fades smoothly before street detail without runtime work or DOM markers", () => {
  const layer = earthVegetationLayer();
  const expression = createExpression(layer.paint["fill-opacity"], "fill-opacity");
  assert.equal(expression.result, "success");
  const at = zoom => expression.value.evaluate({ zoom });
  assert.equal(layer.maxzoom, EARTH_VEGETATION_MAX_ZOOM);
  assert.ok(at(0) > 0 && at(0) < at(1.5));
  assert.ok(at(3) > at(4.2) && at(4.2) > at(5));
  assert.equal(at(EARTH_VEGETATION_MAX_ZOOM), 0);
  assert.equal(at(15), 0);
  const source = readFileSync(join(root, "features/earth/globe-vegetation.ts"), "utf8");
  assert.doesNotMatch(source, /polygon-clipping|requestAnimationFrame|setInterval|fetch\(|new Marker|document\./);
});
