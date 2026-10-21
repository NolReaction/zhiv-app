import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { refreshEarthTileSource, earthTileSourceIds, areEarthTileSourcesReady } = await vite.ssrLoadModule("/features/earth/source-recovery.ts");
const { EARTH_SATELLITE_SOURCE } = await vite.ssrLoadModule("/features/earth/satellite.ts");
after(() => vite.close());

function fixture() {
  const source = { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: "OSM", promoteId: "id" };
  const layer = (id, source) => ({ id, type: "fill", source, paint: { "fill-color": "#abcdab" } });
  const style = { version: 8, sources: { streets: source, land: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    accuracy: { type: "geojson", data: { type: "FeatureCollection", features: [] } } }, layers: [
    { id: "ocean", type: "background" }, layer("land", "land"), layer("detail", "streets"),
    layer("accuracy", "accuracy"), layer("streets", "streets"), layer("labels", "streets"),
  ] };
  const operations = [], sourceInstances = new Map(Object.keys(style.sources).map(id => [id, {}]));
  const original = structuredClone(style);
  const context = {}, camera = { longitude: 90, latitude: 70, bearing: 123, pitch: 50, zoom: 7 };
  const map = {
    getSource(id) { return sourceInstances.get(id); },
    getStyle() { return structuredClone(style); },
    getLayer(id) { return style.layers.find(layer => layer.id === id); },
    refreshTiles(sourceId, tiles) { operations.push(["refresh", sourceId, tiles]); },
    removeLayer(id) { operations.push(["removeLayer", id]); style.layers = style.layers.filter(layer => layer.id !== id); },
    removeSource(id) {
      assert.ok(style.layers.every(layer => layer.source !== id), "dependent layers must be removed first");
      operations.push(["removeSource", id]); delete style.sources[id]; sourceInstances.delete(id);
    },
    addSource(id, definition) { assert.equal(map.getSource(id), undefined); operations.push(["addSource", id]); style.sources[id] = definition; sourceInstances.set(id, {}); },
    addLayer(layer, before) {
      assert.ok(!map.getLayer(layer.id)); assert.ok(map.getSource(layer.source));
      operations.push(["addLayer", layer.id]);
      const position = before ? style.layers.findIndex(layer => layer.id === before) : style.layers.length;
      assert.ok(position >= 0, "insertion anchor must still exist"); style.layers.splice(position, 0, layer);
    },
    context, camera,
  };
  return { map, style, original, operations, sourceInstances, context, camera };
}

test("tile readiness ignores animated local sources and renderer dirty flags, but waits for every downloaded source", () => {
  const s = fixture(), reads = [], loading = new Set(["land", "accuracy"]);
  s.style.sources.satellite = { type: "raster", tiles: ["https://tiles.openfreemap.org/{z}/{x}/{y}.png"] };
  const map = { ...s.map, loaded: () => false, areTilesLoaded: () => false,
    isSourceLoaded(id) { reads.push(id); return !loading.has(id); } };
  assert.deepEqual(earthTileSourceIds(map), ["streets", "satellite"]);
  assert.equal(areEarthTileSourcesReady(map), true, "local lighting/GPS work cannot rebuild successfully loaded streets");
  assert.deepEqual(reads, ["streets", "satellite"], "only public readiness for downloaded tile sources is inspected");
  for (const source of ["streets", "satellite"]) {
    loading.add(source);
    assert.equal(areEarthTileSourcesReady(map), false, `${source} still needs its real network/worker recovery`);
    loading.delete(source);
  }
});

test("optional satellite loading and errors do not block base map readiness or join global recovery", () => {
  const s = fixture();
  s.style.sources[EARTH_SATELLITE_SOURCE] = { type: "raster", tiles: ["https://example.test/{z}/{x}/{y}.jpg"] };
  for (const satelliteState of ["loading", "failed"]) {
    const reads = [];
    const map = { ...s.map, isSourceLoaded(id) {
      reads.push(id);
      if (id === EARTH_SATELLITE_SOURCE) {
        if (satelliteState === "failed") throw new Error("optional imagery unavailable");
        return false;
      }
      return true;
    } };
    assert.deepEqual(earthTileSourceIds(map), ["streets"], "global recovery never targets optional imagery");
    assert.equal(areEarthTileSourcesReady(map), true, `${satelliteState} imagery cannot stall loaded streets`);
    assert.deepEqual(reads, ["streets"], "optional source readiness is independent of the base map");
  }
});

test("late optional satellite repair targets cannot refresh or rebuild the source", () => {
  const s = fixture();
  s.map.addSource(EARTH_SATELLITE_SOURCE, { type: "raster", tiles: ["https://example.test/{z}/{x}/{y}.jpg"] });
  s.map.addLayer({ id: "earth-satellite-imagery", type: "raster", source: EARTH_SATELLITE_SOURCE }, "detail");
  const source = s.map.getSource(EARTH_SATELLITE_SOURCE), expected = structuredClone(s.style);
  s.operations.length = 0;
  for (const target of [
    { sourceId: EARTH_SATELLITE_SOURCE },
    { sourceId: EARTH_SATELLITE_SOURCE, tiles: [{ x: 2, y: 3, z: 4 }] },
  ]) assert.equal(refreshEarthTileSource(s.map, target), false);
  assert.deepEqual(s.operations, []);
  assert.equal(s.map.getSource(EARTH_SATELLITE_SOURCE), source);
  assert.deepEqual(s.style, expected);
});

test("canonical tile repairs keep the source and forward only affected tile IDs", () => {
  const s = fixture(), source = s.map.getSource("streets");
  const tiles = [{ x: 2, y: 3, z: 4 }];
  assert.equal(refreshEarthTileSource(s.map, { sourceId: "streets", tiles }), true);
  assert.deepEqual(s.operations, [["refresh", "streets", tiles]]);
  assert.equal(s.map.getSource("streets"), source);
  assert.deepEqual(s.style, s.original);
});

test("whole-source recovery rebuilds tile actors and restores interleaved layers without touching land, accuracy or camera", () => {
  const s = fixture();
  const streetSource = s.map.getSource("streets"), landSource = s.map.getSource("land"), accuracySource = s.map.getSource("accuracy");
  const landLayer = s.map.getLayer("land"), accuracyLayer = s.map.getLayer("accuracy");
  assert.equal(refreshEarthTileSource(s.map, { sourceId: "streets" }), true);
  assert.notEqual(s.map.getSource("streets"), streetSource);
  assert.equal(s.map.getSource("land"), landSource); assert.equal(s.map.getSource("accuracy"), accuracySource);
  assert.equal(s.map.getLayer("land"), landLayer); assert.equal(s.map.getLayer("accuracy"), accuracyLayer);
  assert.deepEqual(s.style, s.original, "source options, filters, paint and layer order survive recovery");
  assert.equal(s.map.context, s.context); assert.equal(s.map.camera, s.camera);
  assert.ok(s.operations.every(([, id]) => !["land", "accuracy", "ocean"].includes(id)));
  assert.equal(s.operations.filter(([action]) => action === "refresh").length, 0);
});

test("raster source recovery preserves its tile options and layer order", () => {
  const s = fixture();
  s.style.sources.streets = { type: "raster", tiles: ["https://tiles.openfreemap.org/raster/{z}/{x}/{y}.png"], tileSize: 256, minzoom: 0, maxzoom: 8 };
  for (const layer of s.style.layers) if (layer.source === "streets") { layer.type = "raster"; layer.paint = { "raster-opacity": 0.9 }; }
  const expected = structuredClone(s.style);
  assert.equal(refreshEarthTileSource(s.map, { sourceId: "streets" }), true);
  assert.deepEqual(s.style, expected);
});

test("missing sources, independent GeoJSON and empty targeted refreshes leave the map intact", () => {
  const s = fixture();
  for (const target of [{ sourceId: "removed" }, { sourceId: "land" }, { sourceId: "streets", tiles: [] }]) {
    assert.equal(refreshEarthTileSource(s.map, target), false);
  }
  assert.deepEqual(s.operations, []); assert.deepEqual(s.style, s.original);
});
