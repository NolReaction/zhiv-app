import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import polygonClipping from "polygon-clipping";
import { createServer } from "vite";
import { createExpression, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { EARTH_RELIEF_SOURCE, EARTH_RELIEF_LAYER, EARTH_RELIEF_MAX_ZOOM, earthReliefData } = await vite.ssrLoadModule("/features/earth/globe-relief.ts");
const { createCartoonEarthStyle, EARTH_LAND_SOURCE } = await vite.ssrLoadModule("/features/earth/cartoon-style.ts");
const style = createCartoonEarthStyle({ type: "vector", url: "https://tiles.openfreemap.org/planet" });

test("illustrated relief stays one bounded local fill source without a DEM or street-level terrain", () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ["scripts/prepare-earth-relief.mjs", "--check"], { cwd: root }));
  assert.deepEqual(validateStyleMin(style).map(error => error.message), []);
  const source = style.sources[EARTH_RELIEF_SOURCE];
  assert.equal(source.type, "geojson");
  assert.equal(source.maxzoom, 0);
  assert.equal(source.data, earthReliefData);
  assert.ok(Buffer.byteLength(JSON.stringify(source.data)) < 275_000);
  assert.ok(earthReliefData.features.length > 500 && earthReliefData.features.length <= 1_350);
  assert.equal(style.layers.filter(layer => layer.source === EARTH_RELIEF_SOURCE).length, 1);
  const layer = style.layers.find(layer => layer.id === EARTH_RELIEF_LAYER);
  assert.equal(layer.type, "fill");
  assert.equal(layer.maxzoom, EARTH_RELIEF_MAX_ZOOM);
  assert.equal(style.terrain, undefined);
  const ranges = new Set(earthReliefData.features.map(feature => feature.properties.range));
  for (const range of ["andes", "rockies", "himalaya", "alps", "scandes", "urals", "east-africa", "great-dividing"]) {
    assert.ok(ranges.has(range), `${range} survives coastal clipping`);
  }
});

function insideRing([x, y], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [a, b] = ring[index]; const [c, d] = ring[previous];
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside;
  }
  return inside;
}

test("relief faces remain closed, finite and inside the bundled land silhouette", () => {
  const polygons = style.sources[EARTH_LAND_SOURCE].data.features.map(feature => feature.geometry.coordinates);
  const onLand = point => polygons.some(rings => insideRing(point, rings[0]) && !rings.slice(1).some(ring => insideRing(point, ring)));
  for (const feature of earthReliefData.features) {
    assert.equal(feature.geometry.type, "Polygon");
    assert.equal(feature.geometry.coordinates.length, 1);
    const ring = feature.geometry.coordinates[0];
    assert.ok(ring.length === 4 || ring.length === 5, "each face is only a triangle or quad");
    assert.deepEqual(ring[0], ring.at(-1));
    for (let index = 1; index < ring.length; index += 1) {
      const point = ring[index]; const previous = ring[index - 1];
      assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]));
      assert.ok(Math.abs(point[0]) <= 180 && Math.abs(point[1]) < 85);
      assert.ok(onLand(point), `face of ${feature.properties.range} must not invent an island`);
      assert.ok(onLand([(point[0] + previous[0]) / 2, (point[1] + previous[1]) / 2]));
    }
    assert.equal(feature.properties.elevation, undefined, "artistic faces do not claim measured elevation");
  }
});

test("snow stays a sparse set of authored small summit facets within the existing relief source", () => {
  const snow = earthReliefData.features.filter(feature => ["snow", "snow-shade"].includes(feature.properties.tone));
  assert.ok(snow.length >= 20 && snow.length <= 40, "a few summit accents cannot turn into a white mountain ribbon");
  const snowRanges = new Set(snow.map(feature => feature.properties.range));
  for (const range of ["rockies", "andes", "alps", "caucasus", "himalaya", "scandes", "tian-shan"]) assert.ok(snowRanges.has(range));
  for (const feature of snow) {
    assert.equal(feature.geometry.coordinates[0].length, 4, "snow reuses the existing tiny triangular facets");
    assert.equal(feature.properties.snowDepth, undefined, "illustration does not claim live snow cover");
    assert.equal(feature.properties.elevation, undefined);
  }
  const area = feature => Math.abs(feature.geometry.coordinates[0].reduce((sum, point, index, ring) => index
    ? sum + ring[index - 1][0] * point[1] - point[0] * ring[index - 1][1] : sum, 0)) / 2;
  assert.ok(snow.reduce((sum, feature) => sum + area(feature), 0)
    < earthReliefData.features.reduce((sum, feature) => sum + area(feature), 0) * 0.02,
  "summit snow remains a very small share of the illustrated mountain area");
});

test("overview relief fades before exact detail and remains under water, glaciers, names and night treatment", () => {
  const index = id => style.layers.findIndex(layer => layer.id === id);
  const relief = style.layers[index(EARTH_RELIEF_LAYER)];
  assert.ok(index("earth-land-material") < index(EARTH_RELIEF_LAYER));
  assert.ok(index("earth-detail-land") < index(EARTH_RELIEF_LAYER), "coarse detail base must not cover the illustrated mountains");
  for (const id of ["earth-overview-ice", "earth-overview-lakes", "earth-water", "earth-country-names", "earth-city-lights-glow"]) {
    assert.ok(index(EARTH_RELIEF_LAYER) < index(id), `relief must remain beneath ${id}`);
  }
  const opacity = createExpression(relief.paint["fill-opacity"], "fill-opacity");
  assert.equal(opacity.result, "success");
  const at = zoom => opacity.value.evaluate({ zoom });
  assert.ok(at(2) > 0.5 && at(3) > 0.5);
  assert.ok(at(3.5) > 0 && at(3.5) < at(3));
  assert.equal(at(4), 0);
  assert.equal(at(10), 0);
});

test("plateaus, isolated cones and glacier tongues add different silhouettes within the same static source", () => {
  const grouped = form => earthReliefData.features.filter(feature => feature.properties.form === form);
  const plateaus = grouped("plateau"), volcanoes = grouped("volcano"), glaciers = grouped("glacier");
  assert.ok(plateaus.length > 40 && plateaus.length < 90);
  assert.ok(volcanoes.length > 50 && volcanoes.length < 90);
  assert.ok(glaciers.length > 10 && glaciers.length < 30);
  for (const name of ["tibetan-plateau", "deccan-plateau", "colorado-plateau", "guiana-highlands"]) {
    assert.ok(plateaus.some(feature => feature.properties.range === name));
  }
  for (const name of ["iceland-volcano", "kilimanjaro", "cotopaxi", "fuji"]) {
    assert.ok(volcanoes.some(feature => feature.properties.range === name && feature.properties.tone === "volcano-crater"));
  }
  assert.ok(volcanoes.some(feature => feature.properties.tone === "volcano-apron"));
  assert.ok(glaciers.some(feature => feature.properties.tone === "glacier-shade"));
  assert.ok([...plateaus, ...volcanoes, ...glaciers].every(feature => feature.properties.elevation === undefined
    && feature.properties.snowDepth === undefined && feature.properties.activity === undefined));
});


test("desert accents stay sparse, small and within dry desert masks", () => {
  const accents = earthReliefData.features.filter(feature => ["dune", "outcrop"].includes(feature.properties.form));
  const dunes = accents.filter(feature => feature.properties.form === "dune");
  const rocks = accents.filter(feature => feature.properties.form === "outcrop");
  assert.equal(dunes.length, 72, "four small patches, three crests, six narrow faces each");
  assert.equal(rocks.length, 12, "only two tiny flat-topped rock outcrops");
  assert.equal(new Set(dunes.map(feature => feature.properties.range)).size, 4);
  for (const id of ["sahara-dunes", "arabian-dunes", "namib-dunes", "australian-dunes"]) {
    const patch = dunes.filter(feature => feature.properties.range === id);
    assert.equal(patch.filter(feature => feature.properties.tone === "dune-light").length, 9);
    assert.equal(patch.filter(feature => feature.properties.tone === "dune-shade").length, 9);
  }
  const json = path => JSON.parse(readFileSync(new URL(path, new URL("..", import.meta.url)), "utf8"));
  const polygons = feature => feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const desert = json("features/earth/data/biomes-illustrated.json").features
    .filter(feature => feature.properties.biome === "desert").flatMap(polygons);
  const physical = json("features/earth/data/physical-110m.json").features.flatMap(polygons);
  for (const face of accents) {
    const ring = face.geometry.coordinates[0];
    assert.equal(polygonClipping.difference([ring], desert).length, 0, "the whole accent lies in an authored desert");
    assert.equal(polygonClipping.intersection([ring], physical).length, 0, "sand and rocks cannot cover a lake or ice");
    const xs = ring.map(point => point[0]), ys = ring.map(point => point[1]);
    assert.ok(Math.max(...xs) - Math.min(...xs) < 1.2 && Math.max(...ys) - Math.min(...ys) < 1.2,
      "small narrow facets, not giant desert triangles");
    if (face.properties.form === "dune") assert.equal(ring.length, 5);
  }
});
