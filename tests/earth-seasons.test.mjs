import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createExpression, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const cacheDir = mkdtempSync(join(tmpdir(), "zhiv-earth-seasons-"));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { earthSeasonAt, earthSeasonBiomeColor, earthSeasonVegetationColor, earthSeasonLightColor,
  createEarthSeasonsController, EARTH_BIOME_LAYER, EARTH_VEGETATION_LAYER } = await vite.ssrLoadModule("/features/earth/earth-seasons.ts");
const { earthBiomeLayer, earthBiomeData, EARTH_BIOME_SOURCE } = await vite.ssrLoadModule("/features/earth/globe-biomes.ts");
const { earthVegetationLayer, earthVegetationData, EARTH_VEGETATION_SOURCE } = await vite.ssrLoadModule("/features/earth/globe-vegetation.ts");
const { earthLightingLight, createEarthLightingController, EARTH_LIGHTS_SOURCE } = await vite.ssrLoadModule("/features/earth/globe-lighting.ts");
const DAY = 86_400_000;
const YEAR = 365.2422 * DAY;
const winter = Date.UTC(2026, 0, 15, 12), summer = Date.UTC(2026, 6, 16, 12);
const autumn = Date.UTC(2026, 9, 15, 12), spring = Date.UTC(2026, 3, 16, 12);
const dates = [winter, Date.UTC(2026, 2, 20, 12), summer, Date.UTC(2026, 8, 22, 12), autumn];

function colorAt(expression, properties) {
  const compiled = createExpression(expression, "fill-color");
  assert.equal(compiled.result, "success", JSON.stringify(compiled.value, Object.getOwnPropertyNames(compiled.value[0] ?? {})));
  return compiled.value.evaluate({ zoom: 2 }, { properties });
}

test("artistic seasons oppose hemispheres, fade outside temperate latitudes and stay bounded", () => {
  assert.ok(earthSeasonAt(65, winter).winter > 0.95);
  assert.equal(earthSeasonAt(65, summer).winter, 0);
  assert.ok(earthSeasonAt(-65, summer).winter > 0.95);
  assert.equal(earthSeasonAt(-65, winter).winter, 0);
  assert.ok(earthSeasonAt(55, autumn).autumn > 0.99);
  assert.ok(earthSeasonAt(-55, spring).autumn > 0.99);
  for (const date of dates) for (const latitude of [-90, -65, -45, -30, -23.4, 0, 23.4, 30, 45, 65, 90]) {
    const season = earthSeasonAt(latitude, date);
    assert.ok(Object.values(season).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    if (Math.abs(latitude) <= 30) assert.deepEqual(season, { autumn: 0, winter: 0, spring: 0 });
    const opposite = earthSeasonAt(-latitude, date + YEAR / 2);
    for (const key of Object.keys(season)) assert.ok(Math.abs(season[key] - opposite[key]) < 1e-10);
  }
});

test("the annual cycle is smooth across equinoxes, solstices, leap day and New Year", () => {
  for (const date of [...dates, Date.UTC(2026, 11, 31, 23, 59), Date.UTC(2024, 1, 29), Date.UTC(2024, 2, 1)]) {
    for (const latitude of [-75, -45, 0, 45, 75]) {
      const before = earthSeasonAt(latitude, date - 60_000), after = earthSeasonAt(latitude, date + 60_000);
      for (const key of Object.keys(before)) assert.ok(Math.abs(before[key] - after[key]) < 0.0001);
    }
  }
  assert.deepEqual(earthSeasonAt(NaN, winter), { autumn: 0, winter: 0, spring: 0 });
  assert.deepEqual(earthSeasonAt(65, NaN), { autumn: 0, winter: 0, spring: 0 });
});

test("both native fill expressions validate in every season without extra sources or layers", () => {
  for (const now of dates) {
    const biome = earthBiomeLayer(now), vegetation = earthVegetationLayer(now);
    const style = { version: 8, sources: {
      [EARTH_BIOME_SOURCE]: { type: "geojson", data: earthBiomeData },
      [EARTH_VEGETATION_SOURCE]: { type: "geojson", data: earthVegetationData },
    }, layers: [biome, vegetation] };
    assert.deepEqual(validateStyleMin(style).map(error => error.message), []);
    assert.deepEqual(biome.paint["fill-color"], earthSeasonBiomeColor(now));
    assert.deepEqual(vegetation.paint["fill-color"], earthSeasonVegetationColor(now));
    for (const feature of earthBiomeData.features) colorAt(biome.paint["fill-color"], feature.properties);
    for (const feature of earthVegetationData.features) colorAt(vegetation.paint["fill-color"], feature.properties);
  }
});

test("tropical, dry and unrecognised artwork keeps its palette, trunks and shadows keep their contrast", () => {
  for (const biome of ["rainforest", "desert", "savanna", "unknown"]) for (const seasonLatitude of [-75, 0, 75]) {
    const properties = { biome, seasonLatitude };
    const expected = colorAt(earthSeasonBiomeColor(winter), properties);
    for (const date of dates) assert.deepEqual(colorAt(earthSeasonBiomeColor(date), properties), expected);
  }
  for (const biome of ["boreal", "tundra", "steppe"]) for (const seasonLatitude of [-30, -23.4, 0, 23.4, 30]) {
    const properties = { biome, seasonLatitude };
    const expected = colorAt(earthSeasonBiomeColor(winter), properties);
    for (const date of dates) assert.deepEqual(colorAt(earthSeasonBiomeColor(date), properties), expected);
  }
  for (const family of ["boreal", "rainforest", "savanna"]) for (const tone of ["shadow", "trunk", "crown", "light"]) {
    if (family === "boreal" && ["crown", "light"].includes(tone)) continue;
    const properties = { family, tone, seasonLatitude: 65 };
    const expected = colorAt(earthSeasonVegetationColor(winter), properties);
    for (const date of dates) assert.deepEqual(colorAt(earthSeasonVegetationColor(date), properties), expected);
  }
  assert.notDeepEqual(colorAt(earthSeasonBiomeColor(winter), { biome: "boreal", seasonLatitude: 65 }),
    colorAt(earthSeasonBiomeColor(summer), { biome: "boreal", seasonLatitude: 65 }));
  assert.notDeepEqual(colorAt(earthSeasonBiomeColor(winter), { biome: "steppe", seasonLatitude: -55 }),
    colorAt(earthSeasonBiomeColor(summer), { biome: "steppe", seasonLatitude: -55 }));
  assert.deepEqual(colorAt(earthSeasonBiomeColor(NaN), { biome: "boreal", seasonLatitude: 65 }),
    colorAt(earthSeasonBiomeColor(winter), { biome: "boreal" }));
});

test("prepared region/cluster latitude is finite, hemisphere-correct and independent of the dateline", () => {
  const regions = JSON.parse(readFileSync(join(root, "art/earth/biomes/regions.json"))).regions;
  const clusters = new Map(JSON.parse(readFileSync(join(root, "art/earth/vegetation/clusters.json"))).clusters.map(cluster => [cluster.id, cluster]));
  const regionLatitudes = new Map(regions.map(region => [region.id,
    Math.round(region.points.reduce((sum, point) => sum + point[1], 0) / region.points.length * 100) / 100]));
  for (const feature of earthBiomeData.features) assert.equal(feature.properties.seasonLatitude, regionLatitudes.get(feature.properties.region));
  for (const feature of earthVegetationData.features) assert.equal(feature.properties.seasonLatitude, clusters.get(feature.properties.cluster).location[1]);
  for (const region of ["alaska-tundra", "chukotka-tundra"]) {
    const feature = earthBiomeData.features.find(feature => feature.properties.region === region);
    assert.ok(feature.properties.seasonLatitude > 60);
    assert.ok(earthSeasonAt(feature.properties.seasonLatitude, winter).winter > 0.9);
  }
  const west = { biome: "tundra", seasonLatitude: 65, longitude: -179.9 };
  const east = { ...west, longitude: 179.9 };
  for (const date of dates) assert.deepEqual(colorAt(earthSeasonBiomeColor(date), west), colorAt(earthSeasonBiomeColor(date), east));
});

test("controller shares initial style, changes paint once daily, retries missing/replaced layers and disposes", () => {
  const layers = new Map([[EARTH_BIOME_LAYER, {}], [EARTH_VEGETATION_LAYER, {}]]), calls = [];
  const map = { getLayer: id => layers.get(id), setPaintProperty: (...args) => calls.push(args) };
  const controller = createEarthSeasonsController(map, { now: winter });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [EARTH_BIOME_LAYER, "fill-color", earthBiomeLayer(winter).paint["fill-color"]]);
  assert.deepEqual(calls[1], [EARTH_VEGETATION_LAYER, "fill-color", earthVegetationLayer(winter).paint["fill-color"]]);
  for (let step = 0; step < 1000; step++) controller.update(winter + step * 100);
  assert.equal(calls.length, 2);
  controller.update(winter + DAY); assert.equal(calls.length, 4);
  controller.update(NaN); assert.equal(calls.length, 4);
  layers.delete(EARTH_VEGETATION_LAYER); controller.update(winter + DAY);
  layers.set(EARTH_VEGETATION_LAYER, {}); controller.update(winter + DAY); assert.equal(calls.length, 5);
  layers.set(EARTH_BIOME_LAYER, {}); controller.update(winter + DAY); assert.equal(calls.length, 6);
  controller.dispose(); controller.dispose(); controller.update(autumn); assert.equal(calls.length, 6);
  const missingCalls = [], absent = new Map();
  const pending = createEarthSeasonsController({ getLayer: id => absent.get(id), setPaintProperty: (...args) => missingCalls.push(args) }, { now: winter });
  assert.equal(missingCalls.length, 0);
  absent.set(EARTH_BIOME_LAYER, {}); pending.update(winter); assert.equal(missingCalls.length, 1);
  pending.dispose();
});

test("season light is subtle, preserves modes and updates through the existing controller without a timer", () => {
  assert.equal(earthSeasonLightColor("#fff7e9", 0, winter), "#fff7e9");
  const northern = earthLightingLight("day", winter, 65), southern = earthLightingLight("day", winter, -65);
  assert.notEqual(northern.color, southern.color);
  assert.deepEqual({ ...northern, color: southern.color }, southern);
  const calls = [], layers = new Map(), source = { setData() {} };
  let latitude = 65;
  const lighting = createEarthLightingController({ getLayer: id => layers.get(id),
    addLayer(layer) { layers.set(layer.id, layer); }, removeLayer(id) { layers.delete(id); },
    getCenter: () => ({ lng: 179.9, lat: latitude }), getSource: id => id === EARTH_LIGHTS_SOURCE ? source : undefined,
    triggerRepaint() {}, setSky() {}, setLight: light => calls.push(light) }, { mode: "day", now: winter });
  for (let index = 0; index < 100; index++) lighting.update(winter + index * 1000);
  assert.equal(calls.length, 1);
  latitude = -65; lighting.update(winter); assert.equal(calls.length, 2);
  assert.notEqual(calls[0].color, calls[1].color);
  lighting.update(winter + DAY); assert.equal(calls.length, 3);
  lighting.dispose(); lighting.update(summer); assert.equal(calls.length, 3);
  const sourceText = readFileSync(join(root, "features/earth/earth-seasons.ts"), "utf8");
  assert.doesNotMatch(sourceText, /requestAnimationFrame|setInterval|setTimeout|fetch\(|setData\(|addSource\(|addLayer\(/);
});
