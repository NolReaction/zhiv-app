import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createExpression, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { earthSunPosition, earthEveningSun, earthSolarFacing, createEarthLightingData,
  earthLightingSources, earthLightingLayers, earthLightingSky, earthLightingLight,
  createEarthLightingController, EARTH_LIGHTS_SOURCE } = await vite.ssrLoadModule("/features/earth/globe-lighting.ts");
const { earthNightAlpha, EARTH_NIGHT_SHADE_LAYER } = await vite.ssrLoadModule("/features/earth/night-shade-layer.ts");
const noon = Date.UTC(2026, 5, 21, 12);

test("solar time follows UTC and seasons while evening retains a world-space anchor", () => {
  assert.equal(earthSunPosition(noon)[0], 0);
  assert.equal(earthSunPosition(noon - 6 * 3_600_000)[0], 90);
  assert.ok(earthSunPosition(noon)[1] > 23);
  assert.ok(earthSunPosition(Date.UTC(2026, 11, 21, 12))[1] < -23);
  for (const center of [{ lng: 35, lat: 27 }, { lng: 179.9, lat: 80 }, { lng: -179.9, lat: -80 }, { lng: 0, lat: 90 }]) {
    const sun = earthEveningSun(center);
    assert.ok(sun.every(Number.isFinite));
    assert.ok(Math.abs(earthSolarFacing([center.lng, center.lat], sun) - Math.cos(112 * Math.PI / 180)) < 1e-10);
    assert.equal(earthNightAlpha(earthSolarFacing([center.lng, center.lat], sun)), 0.36);
  }
  assert.throws(() => earthSunPosition(NaN), RangeError);
});

test("night lights are decorative fresh points on the dark side and day clears them", () => {
  for (const month of [0, 2, 5, 8, 11]) for (const hour of [0, 6, 12, 18]) {
    const now = Date.UTC(2026, month, 21, hour), sun = earthSunPosition(now);
    const data = createEarthLightingData("auto", now);
    assert.ok(data.lights.features.length > 0 && data.lights.features.length <= 44);
    for (const light of data.lights.features) {
      assert.ok(earthSolarFacing(light.geometry.coordinates, sun) < 0.06);
      assert.ok(light.properties.strength > 0 && light.properties.strength <= 1);
    }
  }
  assert.deepEqual(createEarthLightingData("day", noon), { lights: { type: "FeatureCollection", features: [] } });
});

test("the style has no overlapping night polygons or camera-distance night cutoff", () => {
  const style = { version: 8, sources: earthLightingSources(noon), layers: earthLightingLayers(), sky: earthLightingSky("evening"), light: earthLightingLight("evening") };
  assert.deepEqual(validateStyleMin(style).map(error => error.message), []);
  assert.deepEqual(Object.keys(style.sources), [EARTH_LIGHTS_SOURCE]);
  assert.ok(style.layers.every(layer => layer.type === "circle"));
  for (const layer of style.layers) {
    const opacity = createExpression(layer.paint["circle-opacity"], "circle-opacity");
    assert.equal(opacity.result, "success");
    assert.ok(opacity.value.evaluate({ zoom: 0 }, { properties: { strength: 1 } }) > 0);
    assert.equal(opacity.value.evaluate({ zoom: 6 }, { properties: { strength: 1 } }), 0);
  }
});

test("controller installs night below labels and city lights, minute-bounds updates and removes its layer", () => {
  const calls = { lights: [], sky: [], light: [], installed: [], removed: [], repaint: 0 };
  const layers = new Map([["earth-city-lights-glow", {}]]);
  const map = {
    getSource: id => id === EARTH_LIGHTS_SOURCE ? { setData: data => calls.lights.push(data) } : undefined,
    getCenter: () => ({ lng: 35, lat: 27 }), getLayer: id => layers.get(id),
    addLayer(layer, before) { calls.installed.push([layer, before]); layers.set(layer.id, layer); },
    removeLayer(id) { calls.removed.push(id); layers.delete(id); }, triggerRepaint() { calls.repaint++; },
    setSky: value => calls.sky.push(value), setLight: value => calls.light.push(value),
  };
  const lighting = createEarthLightingController(map, { now: noon });
  assert.equal(calls.installed[0][0].id, EARTH_NIGHT_SHADE_LAYER);
  assert.equal(calls.installed[0][0].type, "custom");
  assert.equal(calls.installed[0][1], "earth-city-lights-glow");
  for (let offset = 0; offset < 60_000; offset += 250) lighting.update(noon + offset);
  assert.equal(calls.lights.length, 1);
  lighting.update(noon + 60_000); assert.equal(calls.lights.length, 2);
  lighting.setMode("evening", { lng: 35, lat: 27 }, noon);
  const evening = calls.lights.at(-1);
  for (let index = 1; index < 120; index++) lighting.update(noon + index * 60_000);
  assert.equal(calls.lights.length, 3);
  lighting.setVisible(false); lighting.setVisible(true);
  lighting.setMode("day", undefined, noon); assert.equal(calls.lights.at(-1).features.length, 0);
  lighting.setMode("evening", undefined, noon); assert.deepEqual(calls.lights.at(-1), evening);
  lighting.dispose(); lighting.dispose();
  assert.deepEqual(calls.removed, [EARTH_NIGHT_SHADE_LAYER]);
  const count = calls.lights.length;
  lighting.update(noon + 1e8); lighting.setMode("auto", undefined, noon);
  assert.equal(calls.lights.length, count);
});
