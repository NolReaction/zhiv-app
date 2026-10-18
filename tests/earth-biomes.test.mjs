import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createExpression, latest, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createEarthBiomeOverview, EARTH_BIOME_SOURCE, EARTH_BIOME_MAX_ZOOM } = await vite.ssrLoadModule("/features/earth/globe-biomes.ts");
const overview = createEarthBiomeOverview();
const data = overview.source.data;

test("miniature biomes are one bounded local globe tile with no images, models or remote data", () => {
  assert.equal(overview.source.type, "geojson");
  assert.equal(overview.source.maxzoom, 0);
  assert.equal(typeof data, "object");
  assert.deepEqual(createEarthBiomeOverview(), overview);
  assert.equal(overview.layers.length, 2);
  assert.deepEqual(overview.layers.map(layer => layer.type), ["fill", "fill-extrusion"]);
  assert.ok(data.features.length <= 198);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 100_000);
  assert.ok(data.features.reduce((count, feature) => count + feature.geometry.coordinates[0].length, 0) < 2_000);
  assert.deepEqual(validateStyleMin({ version: 8, projection: { type: "globe" },
    sources: { [EARTH_BIOME_SOURCE]: overview.source }, layers: overview.layers }).map(error => error.message), []);
});

test("curated forests, mountains and dunes have different solid silhouettes and bounded positive height", () => {
  const regions = new Map();
  for (const feature of data.features) {
    const { region, kind, part, base, height, tint } = feature.properties;
    const previous = regions.get(region) ?? { kind, parts: new Set(), count: 0 };
    assert.equal(previous.kind, kind);
    previous.parts.add(part); previous.count += 1; regions.set(region, previous);
    assert.ok(/^#[\da-f]{6}$/i.test(tint));
    assert.ok(Number.isFinite(base) && Number.isFinite(height));
    assert.ok(base >= 0 && height >= base && height <= 350_000);
    if (part !== "shadow") assert.ok(height > base, "each model tier has actual volume");
  }
  assert.equal(regions.size, 14);
  assert.deepEqual(new Set([...regions.values()].map(region => region.kind)), new Set(["forest", "mountain", "dune"]));
  for (const region of regions.values()) {
    const expected = region.kind === "forest" ? ["shadow", "trunk", "crown-0", "crown-1", "crown-2"]
      : region.kind === "mountain" ? ["shadow", "rock-0", "rock-1", "rock-2", "rock-3"] : ["shadow", "sand-0", "sand-1", "sand-2"];
    assert.deepEqual(region.parts, new Set(expected));
    assert.equal(region.count, expected.length * 3);
  }
});

const insideRing = ([x, y], ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

test("all miniature footprints remain inland with finite closed rings away from polar and date-line seams", async () => {
  const land = JSON.parse(await readFile(new URL("../features/earth/data/land-110m.json", import.meta.url), "utf8"));
  const onLand = point => land.features.some(feature => insideRing(point, feature.geometry.coordinates[0])
    && !feature.geometry.coordinates.slice(1).some(hole => insideRing(point, hole)));
  for (const feature of data.features) {
    const ring = feature.geometry.coordinates[0];
    assert.deepEqual(ring[0], ring.at(-1));
    assert.ok(ring.length >= 4 && ring.length <= 10);
    let area = 0;
    for (let index = 1; index < ring.length; index += 1) {
      const a = ring[index - 1]; const b = ring[index];
      assert.ok(a.every(Number.isFinite));
      assert.ok(Math.abs(a[0]) < 170 && Math.abs(a[1]) < 75);
      assert.ok(Math.abs(a[0] - b[0]) < 10);
      area += a[0] * b[1] - b[0] * a[1];
      assert.ok(onLand(a), `${feature.properties.region}/${feature.properties.part} footprint ${a} must remain on land`);
    }
    assert.ok(area > 0, "GeoJSON exterior rings are counterclockwise and nondegenerate");
  }
});

test("miniatures retain volume at global zoom and disappear smoothly before detailed maps", () => {
  const layer = overview.layers.find(value => value.type === "fill-extrusion");
  const compile = property => {
    const result = createExpression(layer.paint[property], property, latest["paint_fill-extrusion"][property]);
    assert.equal(result.result, "success"); return result.value;
  };
  const height = compile("fill-extrusion-height");
  const base = compile("fill-extrusion-base");
  const opacity = compile("fill-extrusion-opacity");
  assert.equal(opacity.evaluate({ zoom: 0 }), 1);
  assert.equal(opacity.evaluate({ zoom: 2.5 }), 1);
  assert.ok(opacity.evaluate({ zoom: 3 }) > opacity.evaluate({ zoom: 3.5 }));
  assert.equal(opacity.evaluate({ zoom: EARTH_BIOME_MAX_ZOOM }), 0);
  for (const feature of data.features.filter(feature => feature.properties.part !== "shadow")) {
    assert.equal(height.evaluate({ zoom: 0 }, feature), feature.properties.height);
    for (const zoom of [0, 2.5, 3, 3.5, EARTH_BIOME_MAX_ZOOM]) {
      assert.ok(base.evaluate({ zoom }, feature) <= height.evaluate({ zoom }, feature));
    }
    assert.equal(height.evaluate({ zoom: EARTH_BIOME_MAX_ZOOM }, feature), 0);
  }
  assert.ok(overview.layers.every(value => value.maxzoom === EARTH_BIOME_MAX_ZOOM && value.maxzoom < 4));
});
