import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader, PbfWriter } from "pbf";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createCartoonEarthStyle, EARTH_LAND_SOURCE, EARTH_VECTOR_SOURCE, EARTH_PALETTE } = await vite.ssrLoadModule("/features/earth/cartoon-style.ts");
const { appendEarthTileBase, isEarthVectorTileUrl, isEarthTileIndexUrl, prepareEarthTileIndex, EARTH_TILE_BASE_LAYER } = await vite.ssrLoadModule("/features/earth/tile-base.ts");
const source = { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: "OpenStreetMap contributors" };

test("cartoon style validates against installed MapLibre and owns no remote raster, glyph or icon dependency", () => {
  const style = createCartoonEarthStyle(source);
  assert.deepEqual(validateStyleMin(style).map(error => error.message), []);
  assert.ok(style.layers.length <= 24);
  assert.deepEqual(style.sources[EARTH_VECTOR_SOURCE], source);
  assert.equal(style.glyphs, undefined);
  assert.equal(style.sprite, undefined);
  assert.ok(!style.layers.some(layer => ["raster", "fill-extrusion"].includes(layer.type)));
  assert.ok(style.layers.every(layer => !layer.layout?.["icon-image"]));
  assert.ok(style.layers.filter(layer => layer.type === "symbol").every(layer =>
    layer.layout["text-font"].includes("Arial") && layer.layout["text-field"].some(part => Array.isArray(part) && part[1] === "name:ru")));
});

function insideRing([x, y], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [a, b] = ring[index]; const [c, d] = ring[previous];
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside;
  }
  return inside;
}

test("single bundled land tile covers continents and Antarctica without inventing land at the north pole", () => {
  const land = createCartoonEarthStyle(source).sources[EARTH_LAND_SOURCE];
  assert.equal(land.maxzoom, 0);
  assert.equal(typeof land.data, "object");
  assert.ok(Buffer.byteLength(JSON.stringify(land.data)) < 120_000);
  const polygons = land.data.features.flatMap(feature => feature.geometry.type === "Polygon"
    ? [feature.geometry.coordinates] : feature.geometry.coordinates);
  const onLand = point => polygons.some(rings => insideRing(point, rings[0]) && !rings.slice(1).some(ring => insideRing(point, ring)));
  for (const point of [[37, 55], [20, 0], [-100, 40], [-60, -10], [134, -25], [90, 35], [0, -89], [170, -89], [-170, -89]]) {
    assert.ok(onLand(point), `expected land at ${point}`);
  }
  for (const point of [[0, 89], [0, 0], [-140, 0], [80, -40]]) assert.ok(!onLand(point), `expected water at ${point}`);
  for (const rings of polygons) for (const ring of rings) {
    assert.deepEqual(ring[0], ring.at(-1));
    assert.ok(ring.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90));
  }
});

test("coarse land remains beneath loaded detail tiles and water shares their source and visibility", () => {
  const { layers } = createCartoonEarthStyle(source);
  const fallbackIndex = layers.findIndex(layer => layer.source === EARTH_LAND_SOURCE);
  const detailIndex = layers.findIndex(layer => layer["source-layer"] === EARTH_TILE_BASE_LAYER);
  const waterIndex = layers.findIndex(layer => layer["source-layer"] === "water");
  assert.ok(fallbackIndex < detailIndex && detailIndex < waterIndex);
  assert.equal(layers[fallbackIndex].maxzoom, undefined);
  assert.equal(layers[detailIndex].source, layers[waterIndex].source);
  assert.equal(layers[detailIndex].minzoom, layers[waterIndex].minzoom);
  assert.equal(layers[detailIndex].paint["fill-color"], EARTH_PALETTE.land);
  assert.equal(layers[waterIndex].paint["fill-color"], EARTH_PALETTE.ocean);
});

function originalTile() {
  const tile = new PbfWriter();
  tile.writeMessage(3, (_, layer) => {
    layer.writeVarintField(15, 2);
    layer.writeStringField(1, "place");
    layer.writeVarintField(5, 8192);
    layer.writeMessage(2, (_, feature) => {
      feature.writeVarintField(1, 42);
      feature.writeVarintField(3, 1);
      feature.writePackedVarint(4, [9, 256, 512]);
    }, null);
  }, null);
  return tile.finish().slice().buffer;
}

test("MVT decoration adds one clockwise full-tile polygon and preserves provider features and original bytes", () => {
  const original = originalTile(); const before = new Uint8Array(original).slice();
  const decorated = appendEarthTileBase(original);
  assert.notEqual(decorated, original);
  assert.deepEqual(new Uint8Array(original), before);
  assert.deepEqual(new Uint8Array(decorated).slice(0, original.byteLength), before);
  assert.ok(decorated.byteLength - original.byteLength < 100);
  const originalDecoded = new VectorTile(new PbfReader(original));
  const decoded = new VectorTile(new PbfReader(decorated));
  assert.deepEqual(Object.keys(decoded.layers).sort(), [EARTH_TILE_BASE_LAYER, "place"].sort());
  assert.deepEqual(decoded.layers.place.feature(0).toGeoJSON(0, 0, 0), originalDecoded.layers.place.feature(0).toGeoJSON(0, 0, 0));
  const base = decoded.layers[EARTH_TILE_BASE_LAYER];
  assert.equal(base.version, 2); assert.equal(base.extent, 4096); assert.equal(base.length, 1);
  const polygon = base.feature(0);
  assert.equal(polygon.type, 3);
  const ring = polygon.loadGeometry()[0].map(point => [point.x, point.y]);
  assert.deepEqual(ring, [[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]);
  const again = appendEarthTileBase(original);
  assert.deepEqual(new Uint8Array(again), new Uint8Array(decorated));
});

test("tile decoration is scoped to planet vectors and supports the cache protocol without touching fonts or executable files", () => {
  const tile = "https://tiles.openfreemap.org/planet/20261010_001001_pt/14/8278/5235.pbf";
  assert.equal(isEarthVectorTileUrl(tile), true);
  assert.equal(isEarthVectorTileUrl(`earth-cache://resource?url=${encodeURIComponent(tile)}`), true);
  for (const other of ["https://tiles.openfreemap.org/planet", "https://tiles.openfreemap.org/fonts/Arial/0-255.pbf",
    "https://tiles.openfreemap.org/natural_earth/0/0/0.png", "http://tiles.openfreemap.org/planet/v1/0/0/0.pbf",
    "https://example.org/planet/v1/0/0/0.pbf", "https://tiles.openfreemap.org/vendor/maplibre-gl.mjs", "not a url"]) {
    assert.equal(isEarthVectorTileUrl(other), false, other);
  }
});

test("TileJSON announces the synthetic layer without changing cached metadata or duplicating layers", () => {
  const original = { tiles: ["https://tiles.openfreemap.org/planet/v1/{z}/{x}/{y}.pbf"], maxzoom: 15,
    attribution: "OSM", vector_layers: [{ id: "water", fields: { class: "String" } }] };
  const result = prepareEarthTileIndex(original);
  assert.deepEqual(original.vector_layers.map(layer => layer.id), ["water"]);
  assert.deepEqual(result.vector_layers[0], original.vector_layers[0]);
  assert.deepEqual(result.vector_layers[1], { id: EARTH_TILE_BASE_LAYER, fields: {}, minzoom: 0, maxzoom: 15 });
  assert.equal(result.attribution, original.attribution);
  assert.equal(prepareEarthTileIndex(result), result);
  assert.equal(prepareEarthTileIndex({ tiles: [], vector_layers: [] }).vector_layers[0].maxzoom, 14);
  const unlisted = { tiles: [] }; assert.equal(prepareEarthTileIndex(unlisted), unlisted);
  for (const value of [null, "<html>", { version: 8 }]) assert.equal(prepareEarthTileIndex(value), value);
  for (const value of ["https://tiles.openfreemap.org/planet", "https://tiles.openfreemap.org/planet/?version=1",
    "earth-cache://resource?url=https%3A%2F%2Ftiles.openfreemap.org%2Fplanet"]) assert.equal(isEarthTileIndexUrl(value), true);
  for (const value of ["https://tiles.openfreemap.org/styles/liberty", "https://tiles.openfreemap.org/planet/v1/0/0/0.pbf",
    "https://example.org/planet", "http://tiles.openfreemap.org/planet"]) assert.equal(isEarthTileIndexUrl(value), false);
});
