import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createExpression, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { earthSunPosition, earthEveningSun, earthSolarFacing, createEarthLightingData,
  earthLightingSources, earthLightingLayers, earthLightingSky, earthLightingLight,
  createEarthLightingController, EARTH_LIGHTING_SOURCE, EARTH_LIGHTS_SOURCE } = await vite.ssrLoadModule("/features/earth/globe-lighting.ts");
const noon = Date.UTC(2026, 5, 21, 12);

function insideRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]; const b = ring[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

test("decorative auto lighting follows UTC and the seasons; manual evening is tied to a selected world position", () => {
  assert.equal(earthSunPosition(noon)[0], 0);
  assert.equal(earthSunPosition(noon - 6 * 3_600_000)[0], 90);
  assert.ok(earthSunPosition(noon)[1] > 23);
  assert.ok(earthSunPosition(Date.UTC(2026, 11, 21, 12))[1] < -23);
  for (const center of [{ lng: 35, lat: 27 }, { lng: 179.9, lat: 80 }, { lng: -179.9, lat: -80 }, { lng: 0, lat: 90 }]) {
    const sun = earthEveningSun(center);
    assert.ok(sun.every(Number.isFinite));
    assert.ok(Math.abs(earthSolarFacing([center.lng, center.lat], sun) - Math.cos(112 * Math.PI / 180)) < 1e-10);
  }
});

test("night caps remain finite and closed beside the date line and both poles without interior crossings", () => {
  for (const month of [0, 2, 5, 8, 11]) for (const hour of [0, 3, 6, 12, 18, 23]) {
    const data = createEarthLightingData("auto", Date.UTC(2026, month, 21, hour));
    assert.equal(data.shade.features.length, 64);
    assert.ok(data.shade.features.every(feature => feature.properties.alpha <= 0.022), "individual gradient boundaries stay subtle");
    for (const feature of data.shade.features) {
      const ring = feature.geometry.coordinates[0];
      assert.deepEqual(ring.at(-1), ring[0]);
      assert.ok(ring.length <= 100);
      assert.ok(ring.every(point => point.every(Number.isFinite) && Math.abs(point[1]) <= 90));
      for (let index = 1; index < ring.length; index += 1) {
        if (Math.abs(ring[index][0] - ring[index - 1][0]) > 180) {
          assert.equal(Math.abs(ring[index][1]), 90);
          assert.equal(Math.abs(ring[index - 1][1]), 90);
        }
      }
    }
    assert.ok(data.lights.features.length > 0 && data.lights.features.length <= 44);
    const sun = earthSunPosition(Date.UTC(2026, month, 21, hour));
    for (const light of data.lights.features) {
      assert.ok(earthSolarFacing(light.geometry.coordinates, sun) < 0.06);
      assert.ok(light.properties.strength > 0 && light.properties.strength <= 1);
    }
  }
  assert.deepEqual(createEarthLightingData("day", noon), {
    shade: { type: "FeatureCollection", features: [] }, lights: { type: "FeatureCollection", features: [] },
  });
});

test("manual evening visibly darkens the selected view while preserving a warm daylight rim", () => {
  const center = { lng: 35, lat: 27 };
  const data = createEarthLightingData("evening", noon, center);
  const covers = point => data.shade.features.filter(feature => [-720, -360, 0, 360, 720]
    .some(offset => insideRing([point[0] + offset, point[1]], feature.geometry.coordinates[0])));
  const transmittance = features => features.reduce((value, feature) => value * (1 - feature.properties.alpha), 1);
  assert.ok(transmittance(covers([center.lng, center.lat])) < 0.3, "view centre belongs to a clearly visible night");
  assert.equal(covers([-35, 27]).length, 0, "the western edge still has a daylight crescent");
  assert.ok(data.lights.features.some(feature => Math.abs(feature.geometry.coordinates[0] - center.lng) < 10), "nearby inhabited regions glow in the selected evening");
});

test("caps cover the correct spherical side, including the final arc of a polar cap", () => {
  for (const month of [0, 2, 5, 8, 11]) for (const hour of [0, 6, 12, 18]) {
    const now = Date.UTC(2026, month, 21, hour);
    const sun = earthSunPosition(now);
    for (const feature of createEarthLightingData("auto", now).shade.features) {
      const ring = feature.geometry.coordinates[0];
      const radius = Math.acos(Math.max(-1, Math.min(1, -earthSolarFacing(ring[0], sun)))) * 180 / Math.PI;
      for (let latitude = -87; latitude <= 87; latitude += 12) for (let longitude = -177; longitude <= 177; longitude += 12) {
        const angle = Math.acos(Math.max(-1, Math.min(1, -earthSolarFacing([longitude, latitude], sun)))) * 180 / Math.PI;
        // Native GeoJSON edges are short projected chords; do not judge samples
        // within their small approximation band at the cap's boundary.
        if (Math.abs(angle - radius) < 1.5) continue;
        const inside = [-720, -360, 0, 360, 720].some(offset => insideRing([longitude + offset, latitude], ring));
        assert.equal(inside, angle < radius, `cap at ${month}/${hour}, sample ${longitude},${latitude}`);
      }
    }
  }
});

test("lighting validates in the pinned SDK, uses only local bounded data and disappears before streets", () => {
  const style = { version: 8, sources: earthLightingSources(noon), layers: earthLightingLayers(),
    sky: earthLightingSky("evening"), light: earthLightingLight("evening") };
  assert.deepEqual(validateStyleMin(style).map(error => error.message), []);
  for (const source of Object.values(style.sources)) {
    assert.equal(source.type, "geojson");
    assert.equal(source.maxzoom, 0);
    assert.equal(typeof source.data, "object");
  }
  for (const layer of style.layers) {
    const property = layer.type === "fill" ? "fill-opacity" : "circle-opacity";
    const opacity = createExpression(layer.paint[property], property);
    assert.equal(opacity.result, "success");
    assert.ok(opacity.value.evaluate({ zoom: 0 }, { properties: { alpha: 0.12, strength: 1 } }) > 0);
    assert.equal(opacity.value.evaluate({ zoom: 6 }, { properties: { alpha: 0.12, strength: 1 } }), 0);
    assert.ok(layer.maxzoom <= 6);
  }
});

test("shared-clock updates are minute bounded; fixed evening, day and disposed scenes never churn sources", () => {
  const calls = { shade: [], lights: [], sky: [], light: [] };
  const sources = {
    [EARTH_LIGHTING_SOURCE]: { setData: data => calls.shade.push(data) },
    [EARTH_LIGHTS_SOURCE]: { setData: data => calls.lights.push(data) },
  };
  const map = { getSource: id => sources[id], setSky: value => calls.sky.push(value), setLight: value => calls.light.push(value) };
  const lighting = createEarthLightingController(map, { now: noon });
  assert.equal(calls.shade.length, 1);
  for (let offset = 0; offset < 60_000; offset += 250) lighting.update(noon + offset);
  assert.equal(calls.shade.length, 1);
  lighting.update(noon + 60_000);
  assert.equal(calls.shade.length, 2);
  assert.equal(calls.sky.length, 1);
  lighting.setMode("evening", { lng: 35, lat: 27 }, noon);
  assert.equal(calls.shade.length, 3);
  for (let index = 1; index < 120; index += 1) lighting.update(noon + index * 60_000);
  assert.equal(calls.shade.length, 3);
  assert.equal(calls.sky.length, 2);
  lighting.setMode("day", undefined, noon);
  assert.equal(calls.shade.at(-1).features.length, 0);
  lighting.update(noon + 10_000_000);
  assert.equal(calls.shade.length, 4);
  lighting.dispose();
  lighting.update(noon + 20_000_000);
  lighting.setMode("auto", undefined, noon);
  assert.equal(calls.shade.length, 4);
});
