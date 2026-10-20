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
const cacheDir = mkdtempSync(join(tmpdir(), "zhiv-earth-biomes-"));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { EARTH_BIOME_SOURCE, EARTH_BIOME_LAYER, EARTH_BIOME_MAX_ZOOM, EARTH_BIOME_PALETTE,
  earthBiomeData, earthBiomeLayer } = await vite.ssrLoadModule("/features/earth/globe-biomes.ts");
const json = path => JSON.parse(readFileSync(new URL(path, new URL("..", import.meta.url)), "utf8"));
const polygons = geometry => geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
const land = json("features/earth/data/land-110m.json").features.flatMap(feature => polygons(feature.geometry));
const excluded = json("features/earth/data/physical-110m.json").features.flatMap(feature => polygons(feature.geometry));

function ringArea(ring) {
  return Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
}
function area(geometry) {
  return geometry.reduce((sum, polygon) => sum + ringArea(polygon[0])
    - polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0);
}
function insideRing([x, y], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [a, b] = ring[index], [c, d] = ring[previous];
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside;
  }
  return inside;
}
const contains = (geometry, point) => geometry.some(rings => insideRing(point, rings[0]) && !rings.slice(1).some(ring => insideRing(point, ring)));
const regionsAt = point => earthBiomeData.features.filter(feature => contains(feature.geometry.coordinates, point));

test("illustrated biomes are reproducible static geometry within explicit mobile budgets", () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ["scripts/prepare-earth-biomes.mjs", "--check"], { cwd: root }));
  const serialized = JSON.stringify(earthBiomeData);
  assert.ok(Buffer.byteLength(serialized) < 350_000);
  assert.ok(gzipSync(serialized).length < 65_000);
  assert.ok(earthBiomeData.features.length > 100 && earthBiomeData.features.length <= 500);
  assert.equal(new Set(earthBiomeData.features.map(feature => feature.properties.region)).size, 40);
  let vertices = 0;
  for (const feature of earthBiomeData.features) {
    assert.equal(feature.geometry.type, "MultiPolygon");
    assert.ok(Object.hasOwn(EARTH_BIOME_PALETTE, feature.properties.biome));
    assert.ok(feature.properties.opacity > 0 && feature.properties.opacity <= 1);
    assert.ok(Number.isInteger(feature.properties.band) && feature.properties.band >= 0 && feature.properties.band < 5);
    for (const polygon of feature.geometry.coordinates) for (const ring of polygon) {
      vertices += ring.length;
      assert.ok(ring.length >= 4);
      assert.deepEqual(ring[0], ring.at(-1));
      for (let index = 1; index < ring.length; index += 1) {
        assert.ok(ring[index].every(Number.isFinite));
        assert.ok(Math.abs(ring[index][0]) <= 180 && Math.abs(ring[index][1]) <= 84);
        assert.ok(Math.abs(ring[index][0] - ring[index - 1][0]) <= 180, "no contour crosses the dateline across the globe");
      }
    }
  }
  assert.ok(vertices < 20_000);
});

test("biomes follow the bundled land and preserve ice and lake holes at overview precision", () => {
  const all = earthBiomeData.features.flatMap(feature => feature.geometry.coordinates);
  // Coordinates use the same four-decimal precision as the 110m land. Boolean
  // clipping happens before quantization; tolerate only subpixel coastline
  // rounding slivers, never whole islands, inlets or lake/ice polygons.
  assert.ok(area(polygonClipping.difference(all, land)) < 0.01);
  assert.ok(area(polygonClipping.intersection(all, excluded)) < 0.002);
  for (const point of [[0, 0], [-30, 25], [80, -20], [-43, 73], [-89, 48], [33, -1], [107.5, 53]]) {
    assert.equal(regionsAt(point).length, 0, `ocean/ice/lake point ${point} must remain uncovered`);
  }
  assert.ok(earthBiomeData.features.some(feature => feature.geometry.coordinates.some(polygon => polygon.length > 1)), "clipping retains real holes rather than painting across them");
});

test("regional climate accents have recognisable geographic coverage instead of latitude stripes", () => {
  const samples = [
    ["desert", [12, 24]], ["desert", [47, 23]], ["desert", [131, -25]],
    ["desert", [18, -23]], ["desert", [-69.8, -24]], ["desert", [104, 42]],
    ["rainforest", [-62, -5]], ["rainforest", [23, 0]], ["rainforest", [113, 0]],
    ["rainforest", [144, -5]], ["steppe", [-102, 41]], ["steppe", [64, 49]],
    ["boreal", [-121, 59]], ["boreal", [125, 60]], ["boreal", [17, 64]],
    ["tundra", [-151, 69]], ["tundra", [175, 67]],
    ["savanna", [-49, -15]], ["savanna", [35, -5]],
  ];
  for (const [biome, point] of samples) assert.ok(regionsAt(point).some(feature => feature.properties.biome === biome), `${biome} should cover ${point}`);
  assert.ok(!regionsAt([-80, 24]).some(feature => feature.properties.biome === "desert"), "a matching latitude cannot turn the Caribbean into Sahara");
  const sahara = earthBiomeData.features.filter(feature => feature.properties.region === "sahara");
  assert.equal(sahara.length, 5);
  assert.ok(sahara.every((feature, index) => index === 0 || feature.properties.opacity > sahara[index - 1].properties.opacity));
  assert.ok(regionsAt([12, 24]).some(feature => feature.properties.opacity > 0.7));
});

test("broad natural biome cores use narrow feathered edges rather than nested radar rings", () => {
  for (const id of ["sahara", "amazon-rainforest", "congo-rainforest", "west-siberian-taiga", "scandinavian-taiga"]) {
    const features = earthBiomeData.features.filter(feature => feature.properties.region === id);
    const core = features.find(feature => feature.properties.band === 4);
    const wholeArea = features.reduce((sum, feature) => sum + area(feature.geometry.coordinates), 0);
    assert.ok(area(core.geometry.coordinates) / wholeArea > 0.8, `${id} must keep its colour across a broad continuous core`);
  }
  for (const feature of earthBiomeData.features) {
    if (feature.properties.biome === "rainforest") assert.ok(feature.properties.opacity <= 0.72);
    if (feature.properties.biome === "boreal") assert.ok(feature.properties.opacity <= 0.61);
  }
});

test("one fill layer uses native per-feature colour and feather opacity and fades before street detail", () => {
  const layer = earthBiomeLayer();
  assert.equal(layer.id, EARTH_BIOME_LAYER);
  assert.equal(layer.source, EARTH_BIOME_SOURCE);
  assert.equal(layer.type, "fill");
  assert.equal(layer.maxzoom, EARTH_BIOME_MAX_ZOOM);
  const style = { version: 8, sources: { [EARTH_BIOME_SOURCE]: { type: "geojson", data: earthBiomeData, maxzoom: 0, buffer: 0, tolerance: 0 } }, layers: [layer] };
  assert.deepEqual(validateStyleMin(style).map(error => error.message), []);
  const expression = createExpression(layer.paint["fill-opacity"], "fill-opacity");
  assert.equal(expression.result, "success");
  const feature = { properties: { opacity: 0.88, biome: "desert" } };
  const at = zoom => expression.value.evaluate({ zoom }, feature);
  assert.equal(at(0), 0.88);
  assert.equal(at(3.5), 0.88);
  assert.ok(at(4.5) > 0 && at(4.5) < at(3.5));
  assert.equal(at(EARTH_BIOME_MAX_ZOOM), 0);
  assert.equal(at(15), 0);
  const source = readFileSync(new URL("features/earth/globe-biomes.ts", new URL("..", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /import.+polygon-clipping|requestAnimationFrame|setInterval|fetch\(/);
});
