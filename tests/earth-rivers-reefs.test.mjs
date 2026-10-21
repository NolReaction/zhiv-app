import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createServer } from "vite";
import { createExpression, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const river = await vite.ssrLoadModule("/features/earth/globe-rivers.ts");
const reef = await vite.ssrLoadModule("/features/earth/globe-reefs.ts");
const { earthCoastMaterialLayers } = await vite.ssrLoadModule("/features/earth/coast-material.ts");

test("overview rivers are a reproducible bounded pinned atlas dataset", () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ["scripts/prepare-earth-rivers.mjs", "--check"], { cwd: root }));
  const data = river.earthOverviewRiverData;
  assert.equal(data.features.length, 13);
  const names = data.features.map(feature => feature.properties.name);
  for (const name of ["Amazonas", "Nile", "Congo", "Mississippi", "Lena", "Yangtze", "Mekong"]) assert.ok(names.includes(name));
  let vertices = 0;
  for (const feature of data.features) {
    assert.equal(feature.geometry.type, "LineString");
    assert.ok([1, 2].includes(feature.properties.rank));
    const points = feature.geometry.coordinates;
    vertices += points.length;
    for (let index = 0; index < points.length; index++) {
      const [lng, lat] = points[index];
      assert.ok(Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) < 85);
      if (index) assert.ok(Math.abs(lng - points[index - 1][0]) < 20, "river cannot jump across the map");
    }
  }
  assert.ok(vertices < 1300);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 30_000);
  assert.ok(gzipSync(JSON.stringify(data)).length < 12_000);
});

test("rivers and sparse reef illustrations validate and fade before local navigation", () => {
  const layers = [river.earthOverviewRiverLayer(), ...reef.earthReefLayers()];
  const sources = {
    [river.EARTH_OVERVIEW_RIVER_SOURCE]: { type: "geojson", data: river.earthOverviewRiverData, maxzoom: 0 },
    [reef.EARTH_REEF_SOURCE]: { type: "geojson", data: reef.earthReefData, maxzoom: 0 },
  };
  assert.deepEqual(validateStyleMin({ version: 8, sources, layers }).map(error => error.message), []);
  assert.equal(reef.earthReefData.features.length, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(reef.earthReefData)) < 1500);
  const riverOpacity = createExpression(river.earthOverviewRiverLayer().paint["line-opacity"], "line-opacity");
  assert.ok(riverOpacity.value.evaluate({ zoom: 4.3 }) < 0.2, "generalized river bends must recede on detailed regional maps");
  for (const layer of layers) {
    const expression = createExpression(layer.paint["line-opacity"], "line-opacity");
    assert.equal(expression.result, "success");
    assert.ok(expression.value.evaluate({ zoom: 2 }) > 0);
    assert.equal(expression.value.evaluate({ zoom: layer.maxzoom }), 0);
    assert.ok(layer.maxzoom <= 6);
  }
});

test("outer shelf reuses the cut coastline without a new source or depth claim", () => {
  const coast = earthCoastMaterialLayers();
  assert.equal(coast.depth.source, coast.shelf.source);
  assert.equal(coast.depth.maxzoom, coast.shelf.maxzoom);
  assert.ok(coast.depth.paint["line-blur"] > coast.shelf.paint["line-blur"]);
  const opacity = createExpression(coast.depth.paint["line-opacity"], "line-opacity");
  assert.equal(opacity.result, "success");
  assert.ok(opacity.value.evaluate({ zoom: 2 }) < 0.4);
  assert.equal(opacity.value.evaluate({ zoom: 4 }), 0);
});
