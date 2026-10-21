import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader, PbfWriter } from "pbf";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { splitEarthBuildingTileGeometry } = await vite.ssrLoadModule("/features/earth/building-tile-geometry.ts");
const { appendEarthTileBase, EARTH_TILE_BASE_LAYER } = await vite.ssrLoadModule("/features/earth/tile-base.ts");
const { earthBuildingModelFilter } = await vite.ssrLoadModule("/features/earth/building-model-mask.ts");
const { EARTH_BUILDING_FILTER } = await vite.ssrLoadModule("/features/earth/building-style.ts");

function concat(...parts) { return Uint8Array.from(parts.flatMap(part => [...part])); }
function varint(value) {
  let remaining = BigInt(value); const bytes = [];
  do { const byte = Number(remaining & 127n); remaining >>= 7n; bytes.push(byte | (remaining ? 128 : 0)); } while (remaining);
  return bytes;
}
const packed = (tag, bytes) => concat(varint(tag * 8 + 2), varint(bytes.length), bytes);
const scalar = (tag, value) => concat(varint(tag * 8), varint(value));
function commands(rings) {
  const result = []; let x = 0, y = 0;
  const point = ([nextX, nextY]) => {
    for (const delta of [nextX - x, nextY - y]) result.push(delta < 0 ? -delta * 2 - 1 : delta * 2);
    x = nextX; y = nextY;
  };
  for (const ring of rings) {
    result.push(9); point(ring[0]); result.push((ring.length - 1) * 8 + 2);
    for (const next of ring.slice(1)) point(next);
    result.push(15);
  }
  return result;
}
const encoded = values => values.flatMap(value => varint(value));
const outer = (x, y, width = 200) => [[x, y], [x + width, y], [x + width, y + width], [x, y + width]];
const hole = [[1040, 1040], [1040, 1160], [1160, 1160], [1160, 1040]];
const near = outer(1000, 1000), far = outer(6000, 6000);
const UNKNOWN = concat([73], [9, 8, 7, 6, 5, 4, 3, 2]); // unknown fixed64 field9
function feature(rings, { id = 42n, geometryParts = null, rawGeometry = null } = {}) {
  const values = commands(rings);
  const geometries = rawGeometry ? packed(4, rawGeometry) : concat(...(geometryParts ?? [values]).map(part => packed(4, encoded(part))));
  return concat(scalar(1, id), packed(2, [0, 0, 1, 1]), scalar(3, 3), UNKNOWN, geometries);
}
function layer(name, features) {
  const writer = new PbfWriter();
  writer.writeStringField(1, name); writer.writeVarintField(15, 2); writer.writeVarintField(5, 8192);
  writer.writeStringField(3, "render_height"); writer.writeStringField(3, "render_min_height");
  writer.writeMessage(4, (_, value) => value.writeVarintField(4, 4), null);
  writer.writeMessage(4, (_, value) => value.writeVarintField(4, 0), null);
  for (const value of features) writer.writeBytesField(2, value);
  return packed(3, writer.finish());
}
function tile(...layers) { return concat(...layers).buffer; }
function decode(data) { return new VectorTile(new PbfReader(data)); }
const points = value => value.loadGeometry().map(ring => ring.map(point => [point.x, point.y]));
const close = ring => [...ring, ring[0]];
function containsBytes(data, bytes) { return Buffer.from(data).includes(Buffer.from(bytes)); }
const canonical = { z: 14, x: 8192, y: 8192 };
function longitudeLatitude([x, y]) {
  const longitude = ((x / 8192 + canonical.x) / 2 ** canonical.z) * 360 - 180;
  const mercatorY = (y / 8192 + canonical.y) / 2 ** canonical.z;
  return [longitude, Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180 / Math.PI];
}
function visible(feature, anchor, radius = 5) {
  const [longitude, latitude] = longitudeLatitude(anchor);
  const placement = { id: "eiffel-tower", longitude, latitude, exclusionRadiusMeters: radius, excludeBuildings: true };
  const filter = featureFilter(earthBuildingModelFilter(EARTH_BUILDING_FILTER, [placement], new Set([placement.id])), "filter");
  return filter.filter({ zoom: 16 }, { type: 3, geometry: feature.loadGeometry(), properties: feature.properties }, canonical);
}

test("merged building polygons become independent features with their holes, properties and IDs", () => {
  const water = layer("water", [feature([outer(2000, 2000), outer(3000, 3000)])]);
  const input = tile(water, layer("building", [feature([near, hole, far])]));
  const before = new Uint8Array(input).slice();
  const transformed = splitEarthBuildingTileGeometry(input);
  assert.deepEqual(new Uint8Array(input), before, "cached provider bytes remain unchanged");
  assert.ok(containsBytes(transformed, water), "unrelated layer remains exactly the same bytes");
  const buildings = decode(transformed).layers.building;
  assert.equal(buildings.length, 2);
  assert.deepEqual(points(buildings.feature(0)), [close(near), close(hole)]);
  assert.deepEqual(points(buildings.feature(1)), [close(far)], "delta cursor resets for a new feature");
  for (let index = 0; index < 2; index++) {
    assert.equal(buildings.feature(index).id, 42);
    assert.deepEqual({ ...buildings.feature(index).properties }, { render_height: 4, render_min_height: 0 });
  }
  assert.equal(visible(buildings.feature(0), [1010, 1010]), false);
  assert.equal(visible(buildings.feature(1), [1010, 1010]), true, "distant batched building stays 3D");
  assert.equal(visible(buildings.feature(0), [1100, 1100]), true, "a model inside the courtyard does not intersect the footprint");
  assert.equal(buildings.feature(0).toGeoJSON(canonical.x, canonical.y, canonical.z).geometry.type, "Polygon");
});

test("unknown fields and uint64 IDs are copied raw, repeated packed geometry chunks are combined", () => {
  const values = commands([near, hole, far]);
  const id = 18_446_744_073_709_551_615n;
  const raw = feature([near, hole, far], { id, geometryParts: [values.slice(0, 7), values.slice(7)] });
  const output = splitEarthBuildingTileGeometry(tile(layer("building", [raw])));
  const buildings = decode(output).layers.building;
  assert.equal(buildings.length, 2);
  assert.deepEqual(points(buildings.feature(0)), [close(near), close(hole)]);
  assert.deepEqual(points(buildings.feature(1)), [close(far)]);
  const bytes = Buffer.from(output);
  const idBytes = Buffer.from(scalar(1, id));
  assert.equal(bytes.toString("hex").split(idBytes.toString("hex")).length - 1, 2, "uint64 is never rounded through Number");
  assert.equal(bytes.toString("hex").split(Buffer.from(UNKNOWN).toString("hex")).length - 1, 2);
});

test("unchanged polygons, other layers and nonpolygon building features retain their complete original bytes", () => {
  const pointFeature = concat(scalar(1, 7), scalar(3, 1), packed(4, encoded([9, 100, 100])));
  for (const input of [tile(), tile(layer("place", [feature([near, far])])), tile(layer("building", [feature([near, hole])])),
    tile(layer("building", [pointFeature]))]) {
    assert.equal(splitEarthBuildingTileGeometry(input), input);
  }
  const input = tile(layer("building", [pointFeature, feature([near, far])]));
  const output = appendEarthTileBase(input);
  assert.ok(containsBytes(output, packed(2, pointFeature)), "unchanged feature is copied verbatim inside a changed layer");
  assert.equal(decode(output).layers.building.length, 3);
  assert.equal(decode(output).layers[EARTH_TILE_BASE_LAYER].length, 1);
});

test("malformed command streams and overflowing deltas reject atomically without modifying provider bytes", () => {
  const bad = [
    [0], [9, 0], [9, 0, 0, 10, 20, 20, 15], // zero command, missing argument, fewer than 3 vertices
    [17, 0, 0, 2, 2], [9, 0, 0, 3], // Polygon MoveTo count2, unsupported command
    [9, 0, 0, 18, 2, 0, 0, 2], // unclosed ring
    [9, 0, 0, 18, 2, 0, 0, 2, 23], // ClosePath count2
    commands([hole]), // orphan interior
    [9, 4_294_967_294, 0, 18, 4, 0, 0, 4, 15], // int32 cursor overflow
  ];
  for (const values of bad) {
    const input = tile(layer("building", [feature([], { rawGeometry: encoded(values) })]));
    const before = new Uint8Array(input).slice();
    assert.throws(() => splitEarthBuildingTileGeometry(input), /Invalid or oversized/);
    assert.deepEqual(new Uint8Array(input), before);
  }
  for (const bytes of [[26, 128], [26, 255, 255, 255, 255, 31], [0], [26, 1, 255]]) {
    assert.throws(() => splitEarthBuildingTileGeometry(Uint8Array.from(bytes).buffer), /Invalid or oversized/);
  }
  assert.throws(() => splitEarthBuildingTileGeometry(new ArrayBuffer(8 * 1024 * 1024 + 1)), /Invalid or oversized/);
});

test("metadata amplification is bounded before a malicious batch can allocate an oversized worker tile", () => {
  const many = Array.from({ length: 300 }, (_, index) => outer(index * 20, 0, 10));
  const repeatedMetadata = packed(12, new Uint8Array(64 * 1024));
  const input = tile(layer("building", [concat(feature(many), repeatedMetadata)]));
  assert.ok(input.byteLength < 100_000);
  assert.throws(() => splitEarthBuildingTileGeometry(input), /Invalid or oversized/);
});
