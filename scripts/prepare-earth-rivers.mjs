import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Offline-only conversion of a pinned Natural Earth 110m physical dataset.
// Runtime receives only the compact local lines, never the upstream metadata.
const source = new URL("../art/earth/hydrology/ne-110m-rivers-v5.1.2.geojson", import.meta.url);
const bytes = readFileSync(source);
if (createHash("sha256").update(bytes).digest("hex") !== "55aa4497405afc07cdc931b7fbe062c4d6693ba2a550c0d24899953f5d507c8d") {
  throw new Error("Pinned Natural Earth river data changed: review provenance before regenerating");
}
const upstream = JSON.parse(bytes.toString("utf8"));
const data = { type: "FeatureCollection", features: upstream.features.map(feature => {
  if (feature.geometry.type !== "LineString") throw new Error("Unexpected river geometry");
  return { type: "Feature", properties: { name: feature.properties.name, rank: feature.properties.scalerank },
    geometry: { type: "LineString", coordinates: feature.geometry.coordinates.map(point => point.map(value => Math.round(value * 10000) / 10000)) } };
}) };
const serialized = `${JSON.stringify(data)}\n`;
const vertices = data.features.reduce((count, feature) => count + feature.geometry.coordinates.length, 0);
if (data.features.length > 20 || vertices > 1300 || Buffer.byteLength(serialized) > 30_000) throw new Error("Overview rivers exceed their local budget");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--check")) throw new Error("Usage: node scripts/prepare-earth-rivers.mjs [--check]");
const output = new URL("../features/earth/data/rivers-110m.json", import.meta.url);
if (args.includes("--check")) {
  if (readFileSync(output, "utf8") !== serialized) throw new Error("Overview river data is stale");
} else writeFileSync(output, serialized);
console.log(`Overview rivers ${args.includes("--check") ? "checked" : "prepared"}: ${data.features.length} lines, ${vertices} vertices, ${Buffer.byteLength(serialized)} bytes`);
