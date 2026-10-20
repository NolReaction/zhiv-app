import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import polygonClipping from "polygon-clipping";

const root = new URL("../", import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const MAX_BYTES = 350_000;
const MAX_GZIP_BYTES = 65_000;
const MAX_FEATURES = 500;
const MAX_VERTICES = 20_000;
const BIOMES = new Set(["rainforest", "boreal", "tundra", "desert", "savanna", "steppe"]);
const STRENGTH = { rainforest: 0.72, boreal: 0.61, tundra: 0.62, desert: 0.88, savanna: 0.6, steppe: 0.54 };
const FEATHER = [
  { scale: 1, opacity: 0.15 },
  { scale: 0.982, opacity: 0.35 },
  { scale: 0.963, opacity: 0.55 },
  { scale: 0.944, opacity: 0.78 },
  { scale: 0.925, opacity: 1 },
];

function multipolygon(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  throw new Error("Biome masks must contain only polygons");
}

/** Chaikin corner rounding preserves the authored contour without noise or a grid. */
function roundContour(points) {
  const open = points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1] ? points.slice(0, -1) : points;
  return open.flatMap((point, index) => {
    const next = open[(index + 1) % open.length];
    return [[point[0] * 0.75 + next[0] * 0.25, point[1] * 0.75 + next[1] * 0.25],
      [point[0] * 0.25 + next[0] * 0.75, point[1] * 0.25 + next[1] * 0.75]];
  });
}

function roundedGeometry(geometry) {
  return geometry.map(polygon => polygon.map(ring => ring.map(point => point.map(number => Math.round(number * 10_000) / 10_000))));
}

function area(geometry) {
  const ringArea = ring => Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
  return geometry.reduce((sum, polygon) => sum + ringArea(polygon[0]) - polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0);
}

/**
 * Development-only clipping. The app imports the prepared data, never this
 * library, the region guides, or coastal/ice/lake geometry computations.
 */
export function prepareEarthBiomes() {
  const guide = read("art/earth/biomes/regions.json");
  if (guide.schemaVersion !== 1 || !Array.isArray(guide.regions) || guide.regions.length > 50) throw new Error("Unsupported illustrated biome guide");
  const land = read("features/earth/data/land-110m.json").features.flatMap(feature => multipolygon(feature.geometry));
  const excluded = read("features/earth/data/physical-110m.json").features.flatMap(feature => multipolygon(feature.geometry));
  const landMask = polygonClipping.difference(land, excluded);
  const features = [], ids = new Set();
  for (const region of guide.regions) {
    if (typeof region.id !== "string" || !/^[a-z0-9-]+$/.test(region.id) || ids.has(region.id) || !BIOMES.has(region.biome)
      || !Array.isArray(region.points) || region.points.length < 5 || region.points.length > 40
      || region.points.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)
        || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 84)) throw new Error("Invalid illustrated biome region");
    ids.add(region.id);
    const contour = roundContour(region.points);
    const center = contour.reduce((sum, point) => [sum[0] + point[0] / contour.length, sum[1] + point[1] / contour.length], [0, 0]);
    // Each inner contour is intersected with the previous one, so concave
    // authored footprints cannot grow outside their outer feather band.
    const levels = [];
    let previous = [contour];
    for (const band of FEATHER) {
      const ring = contour.map(point => [center[0] + (point[0] - center[0]) * band.scale,
        center[1] + (point[1] - center[1]) * band.scale]);
      previous = polygonClipping.intersection(previous, [ring]);
      levels.push(previous);
    }
    for (let band = 0; band < levels.length; band += 1) {
      const feather = band === levels.length - 1 ? levels[band] : polygonClipping.difference(levels[band], levels[band + 1]);
      // Form the bands before clipping them to the coast. Subtracting two
      // independently clipped contours can create near-identical coastal
      // intersection coordinates and unstable microscopic output rings.
      const shell = polygonClipping.intersection(feather, landMask);
      if (shell.length === 0 || area(shell) < 0.00001) continue;
      features.push({ type: "Feature", properties: { region: region.id, biome: region.biome, band,
        opacity: Math.round(FEATHER[band].opacity * STRENGTH[region.biome] * 10_000) / 10_000 },
        geometry: { type: "MultiPolygon", coordinates: roundedGeometry(shell) } });
    }
  }
  const data = { type: "FeatureCollection", features };
  const serialized = `${JSON.stringify(data)}\n`;
  const bytes = Buffer.byteLength(serialized), gzipBytes = gzipSync(serialized).length;
  const vertices = features.reduce((sum, feature) => sum + feature.geometry.coordinates.reduce((count, polygon) => count + polygon.reduce((n, ring) => n + ring.length, 0), 0), 0);
  if (features.length > MAX_FEATURES || bytes > MAX_BYTES || gzipBytes > MAX_GZIP_BYTES || vertices > MAX_VERTICES) {
    throw new Error(`Illustrated biomes exceed local geometry budget: ${features.length} features, ${vertices} vertices, ${bytes} bytes, ${gzipBytes} gzip bytes`);
  }
  return { data, serialized, bytes, gzipBytes, vertices, regions: ids.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--check")) throw new Error("Usage: node scripts/prepare-earth-biomes.mjs [--check]");
  const output = new URL("features/earth/data/biomes-illustrated.json", root);
  const result = prepareEarthBiomes();
  if (args.includes("--check")) {
    if (readFileSync(output, "utf8") !== result.serialized) throw new Error("Illustrated biomes are stale: run node scripts/prepare-earth-biomes.mjs");
  } else writeFileSync(output, result.serialized);
  console.log(`Illustrated biomes ${args.includes("--check") ? "checked" : "prepared"}: ${result.regions} regions, ${result.data.features.length} features, ${result.vertices} vertices, ${result.bytes} bytes (${result.gzipBytes} gzip)`);
}
