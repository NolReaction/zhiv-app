import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";
import physical from "./data/physical-110m.json";

export const EARTH_OVERVIEW_SOURCE = "earth-local-overview";

/** Sparse atlas labels: screen placement aids, not boundaries or precise centroids. */
const labels: [string, "continent" | "ocean", number, number][] = [
  ["Европа", "continent", 19, 51], ["Азия", "continent", 93, 43],
  ["Африка", "continent", 20, 5], ["Северная Америка", "continent", -106, 43],
  ["Южная Америка", "continent", -60, -18], ["Австралия", "continent", 134, -25],
  ["Антарктида", "continent", 35, -78],
  ["Атлантический океан", "ocean", -35, 8], ["Тихий океан", "ocean", -145, 0],
  ["Индийский океан", "ocean", 78, -27], ["Северный Ледовитый океан", "ocean", -5, 79],
  ["Южный океан", "ocean", 20, -57],
];

const features: Feature<Polygon | LineString | Point>[] = [
  ...physical.features as Feature<Polygon>[],
  ...labels.map(([name, kind, longitude, latitude]): Feature<Point> => ({
    type: "Feature", properties: { kind, "name:ru": name },
    geometry: { type: "Point", coordinates: [longitude, latitude] },
  })),
];

// A small geographic grid under land gives the oceans scale and curvature. It
// is built once, uses the same local z0 tile, and disappears before street zoom.
for (let longitude = -180; longitude < 180; longitude += 30) {
  const coordinates = Array.from({ length: 35 }, (_, index) => [longitude, -85 + index * 5]);
  features.push({ type: "Feature", properties: { kind: "grid" }, geometry: { type: "LineString", coordinates } });
}
for (let latitude = -60; latitude <= 60; latitude += 30) {
  const coordinates = Array.from({ length: 73 }, (_, index) => [-180 + index * 5, latitude]);
  features.push({ type: "Feature", properties: { kind: "grid" }, geometry: { type: "LineString", coordinates } });
}

export const earthOverviewData: FeatureCollection<Polygon | LineString | Point> = { type: "FeatureCollection", features };
