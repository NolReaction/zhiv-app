import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import polygonClipping from "polygon-clipping";

const root = new URL("../", import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const FAMILIES = new Set(["boreal", "rainforest", "savanna"]);
const TREES = [[-0.56, -0.08, 0.84], [0.12, 0.22, 1], [0.66, -0.22, 0.8]];
const ORDER = { shadow: 0, trunk: 1, crown: 2, light: 3 };
const polygons = geometry => geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
const close = points => [...points, points[0]];
const round = geometry => geometry.map(polygon => polygon.map(ring => ring.map(point => point.map(value => Math.round(value * 100_000) / 100_000))));

function ellipse(x, y, width, height, lobes = 0) {
  return close(Array.from({ length: 20 }, (_, index) => {
    const angle = index / 20 * Math.PI * 2;
    const radius = 1 + Math.sin(angle * 5) * lobes;
    return [x + Math.cos(angle) * width * radius, y + Math.sin(angle) * height * radius];
  }));
}

/** Small atlas silhouettes, exaggerated in geographic size, not placed models. */
function treeShape(family) {
  const shadow = ellipse(0.12, -0.24, 0.42, 0.14);
  const trunk = close([[-0.035, -0.25], [0.035, -0.25], [0.025, 0.38], [-0.025, 0.38]]);
  if (family === "boreal") {
    return { shadow, trunk,
      crown: close([[-0.34, -0.1], [-0.17, 0.13], [-0.26, 0.13], [-0.1, 0.35], [-0.18, 0.35], [0, 0.78],
        [0.18, 0.35], [0.1, 0.35], [0.26, 0.13], [0.17, 0.13], [0.34, -0.1]]),
      light: close([[0, -0.1], [-0.34, -0.1], [-0.17, 0.13], [-0.26, 0.13], [-0.1, 0.35], [-0.18, 0.35], [0, 0.78]]) };
  }
  if (family === "rainforest") {
    return { shadow, trunk, crown: ellipse(0, 0.32, 0.43, 0.44, 0.09),
      light: close([[-0.35, 0.42], [-0.31, 0.64], [-0.13, 0.75], [0.1, 0.71], [0.22, 0.59], [0.04, 0.61], [-0.1, 0.56], [-0.2, 0.4]]) };
  }
  return { shadow, trunk, crown: ellipse(0, 0.45, 0.58, 0.23, 0.055),
    light: close([[-0.48, 0.51], [-0.3, 0.64], [0.02, 0.69], [0.34, 0.6], [0.48, 0.5], [0.13, 0.55], [-0.2, 0.55]]) };
}

/** Offline only: no clipping library or geometry construction enters the app. */
export function prepareEarthVegetation() {
  const guide = read("art/earth/vegetation/clusters.json");
  if (guide.schemaVersion !== 1 || !Array.isArray(guide.clusters) || guide.clusters.length > 64) throw new Error("Unsupported vegetation guide");
  const cores = new Map(read("features/earth/data/biomes-illustrated.json").features
    .filter(feature => feature.properties.band === 4 && FAMILIES.has(feature.properties.biome))
    .map(feature => [feature.properties.region, feature]));
  const land = read("features/earth/data/land-110m.json").features.flatMap(feature => polygons(feature.geometry));
  const excluded = read("features/earth/data/physical-110m.json").features.flatMap(feature => polygons(feature.geometry));
  const landMask = polygonClipping.difference(land, excluded);
  const features = [], ids = new Set();
  for (const cluster of guide.clusters) {
    const core = cores.get(cluster.region);
    if (!core || !/^[a-z0-9-]+$/.test(cluster.id) || ids.has(cluster.id)
      || !Array.isArray(cluster.location) || cluster.location.length !== 2 || !cluster.location.every(Number.isFinite)
      || Math.abs(cluster.location[0]) > 175 || Math.abs(cluster.location[1]) > 75
      || !Number.isFinite(cluster.size) || cluster.size < 0.5 || cluster.size > 1.2) throw new Error(`Invalid vegetation cluster: ${cluster.id}`);
    ids.add(cluster.id);
    const family = core.properties.biome;
    const shapes = treeShape(family), [longitude, latitude] = cluster.location;
    const stretch = 1 / Math.cos(latitude * Math.PI / 180);
    const mask = polygonClipping.intersection(core.geometry.coordinates, landMask);
    let crowns = 0;
    for (const [tone, shape] of Object.entries(shapes)) {
      const trees = TREES.map(([x, y, scale]) => [shape.map(point => [
        longitude + (x + point[0] * scale) * cluster.size * stretch,
        latitude + (y + point[1] * scale) * cluster.size,
      ])]);
      const merged = polygonClipping.union(...trees);
      const clipped = polygonClipping.intersection(merged, mask);
      if (!clipped.length) continue;
      if (tone === "crown") crowns += 1;
      features.push({ type: "Feature", properties: { cluster: cluster.id, region: cluster.region,
        family, tone, order: ORDER[tone], seasonLatitude: latitude }, geometry: { type: "MultiPolygon", coordinates: round(clipped) } });
    }
    if (!crowns) throw new Error(`Vegetation cluster misses its biome core: ${cluster.id}`);
  }
  const data = { type: "FeatureCollection", features };
  const serialized = `${JSON.stringify(data)}\n`, bytes = Buffer.byteLength(serialized), gzipBytes = gzipSync(serialized).length;
  const vertices = features.reduce((sum, feature) => sum + feature.geometry.coordinates.reduce((n, polygon) => n + polygon.reduce((count, ring) => count + ring.length, 0), 0), 0);
  if (features.length > 256 || bytes > 220_000 || gzipBytes > 55_000 || vertices > 8_000) {
    throw new Error(`Vegetation geometry exceeds budget: ${features.length} features, ${vertices} vertices, ${bytes} bytes (${gzipBytes} gzip)`);
  }
  return { data, serialized, bytes, gzipBytes, vertices, clusters: ids.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--check")) throw new Error("Usage: node scripts/prepare-earth-vegetation.mjs [--check]");
  const output = new URL("features/earth/data/vegetation-illustrated.json", root), result = prepareEarthVegetation();
  if (args.includes("--check")) {
    if (readFileSync(output, "utf8") !== result.serialized) throw new Error("Illustrated vegetation is stale: run node scripts/prepare-earth-vegetation.mjs");
  } else writeFileSync(output, result.serialized);
  console.log(`Illustrated vegetation ${args.includes("--check") ? "checked" : "prepared"}: ${result.clusters} clusters, ${result.data.features.length} features, ${result.vertices} vertices, ${result.bytes} bytes (${result.gzipBytes} gzip)`);
}
