import type { Feature, FeatureCollection, Polygon, Position } from "geojson";
import type { ExpressionSpecification, GeoJSONSourceSpecification, LayerSpecification } from "maplibre-gl";

export const EARTH_BIOME_SOURCE = "earth-local-biomes";
export const EARTH_BIOME_MAX_ZOOM = 3.8;

type Biome = "forest" | "mountain" | "dune";
type Anchor = readonly [number, number];
type Region = { id: string; kind: Biome; center: Anchor; scale: number; angle: number };
type BiomeProperties = { region: string; kind: Biome; part: string; tint: string; base: number; height: number };

/**
 * Hand-placed atlas miniatures, not surveyed vegetation or elevation data.
 * Their deliberately enlarged scale makes a few silhouettes legible on a phone.
 * Inland anchors avoid coastlines, polar/dateline seams and the overview labels.
 */
const regions: readonly Region[] = [
  { id: "canadian-boreal", kind: "forest", center: [-108, 59], scale: 1, angle: 15 },
  { id: "appalachian-forest", kind: "forest", center: [-83, 36], scale: 0.8, angle: -20 },
  { id: "fennoscandian-forest", kind: "forest", center: [29, 65], scale: 0.6, angle: 30 },
  { id: "siberian-taiga", kind: "forest", center: [108, 60], scale: 1.1, angle: -15 },
  { id: "amazon-forest", kind: "forest", center: [-61, -4], scale: 1.05, angle: 10 },
  { id: "congo-forest", kind: "forest", center: [23, -5], scale: 0.95, angle: -10 },
  { id: "rocky-mountains", kind: "mountain", center: [-110, 44], scale: 0.9, angle: 70 },
  { id: "andes", kind: "mountain", center: [-68, -25], scale: 0.65, angle: 80 },
  { id: "alps", kind: "mountain", center: [10, 47], scale: 0.55, angle: 5 },
  { id: "himalaya", kind: "mountain", center: [86, 29], scale: 1, angle: -10 },
  { id: "sahara", kind: "dune", center: [12, 25], scale: 1.15, angle: 20 },
  { id: "arabian-desert", kind: "dune", center: [48, 23], scale: 0.8, angle: -10 },
  { id: "gobi", kind: "dune", center: [107, 42], scale: 0.9, angle: -15 },
  { id: "australian-interior", kind: "dune", center: [124, -24], scale: 1, angle: 25 },
];

const radians = Math.PI / 180;
const radiusKm = 6371.0088;

/** Spherical local offsets keep the same miniature proportions at every latitude. */
function offset(center: Anchor, eastKm: number, northKm: number): [number, number] {
  const distance = Math.hypot(eastKm, northKm) / radiusKm;
  const bearing = Math.atan2(eastKm, northKm);
  const latitude = center[1] * radians;
  const nextLatitude = Math.asin(Math.sin(latitude) * Math.cos(distance)
    + Math.cos(latitude) * Math.sin(distance) * Math.cos(bearing));
  const nextLongitude = center[0] * radians + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(latitude),
    Math.cos(distance) - Math.sin(latitude) * Math.sin(nextLatitude));
  return [Number((nextLongitude / radians).toFixed(5)), Number((nextLatitude / radians).toFixed(5))];
}

function rotate(x: number, y: number, angle: number): [number, number] {
  const cos = Math.cos(angle * radians); const sin = Math.sin(angle * radians);
  return [x * cos - y * sin, x * sin + y * cos];
}

function polygon(center: Anchor, width: number, depth: number, sides: number, angle: number): Position[] {
  const ring = Array.from({ length: sides }, (_, index) => {
    const phase = index / sides * Math.PI * 2;
    return offset(center, ...rotate(Math.cos(phase) * width, Math.sin(phase) * depth, angle));
  });
  return [...ring, ring[0]];
}

// A small curved ridge, with a shallow concave lee side rather than a round coin.
const duneOutline = [[-1, -0.15], [-0.85, 0.45], [-0.35, 0.8], [0.3, 0.65], [0.9, 0.15],
  [1, -0.4], [0.4, -0.1], [-0.1, 0.05], [-0.55, -0.05]];

function dunePolygon(center: Anchor, size: number, angle: number): Position[] {
  const ring = duneOutline.map(([x, y]) => offset(center, ...rotate(x * size, y * size, angle)));
  // GeoJSON exterior rings are counterclockwise; the curved ridge was drawn clockwise.
  ring.reverse();
  return [...ring, ring[0]];
}

function createBiomeData(): FeatureCollection<Polygon, BiomeProperties> {
  const features: Feature<Polygon, BiomeProperties>[] = [];
  const add = (region: Region, part: string, ring: Position[], tint: string, base: number, height: number) => {
    features.push({ type: "Feature", properties: { region: region.id, kind: region.kind, part, tint, base, height },
      geometry: { type: "Polygon", coordinates: [ring] } });
  };
  for (const region of regions) {
    const placements = region.kind === "forest" ? [[-170, -80], [170, -30], [0, 170]]
      : region.kind === "mountain" ? [[-205, -25], [25, 50], [220, -20]] : [[-210, 75], [25, -70], [235, 90]];
    for (let index = 0; index < placements.length; index += 1) {
      const [x, y] = placements[index];
      const center = offset(region.center, ...rotate(x * region.scale, y * region.scale, region.angle));
      const size = region.scale * [0.88, 1.12, 0.94][index];
      // Broader silhouettes and gentler height scaling keep small models legible
      // on a phone. Their footprints are tested against the bundled land mask.
      const footprintSize = size * 1.35;
      const heightSize = Math.max(size, Math.sqrt(size));
      add(region, "shadow", polygon(offset(center, 25 * size, -22 * size), 145 * size, 100 * size, 8, region.angle), "#426e58", 0, 0);
      if (region.kind === "forest") {
        add(region, "trunk", polygon(center, 25 * size, 25 * size, 5, 18), "#967c55", 0, 65_000 * heightSize);
        const tiers = [[110, 40_000, 145_000, "#3f8c69"], [77, 125_000, 220_000, "#58a576"], [41, 200_000, 280_000, "#83bd85"]] as const;
        for (let tier = 0; tier < tiers.length; tier += 1) {
          const [radius, base, height, tint] = tiers[tier];
          add(region, `crown-${tier}`, polygon(center, radius * footprintSize, radius * footprintSize, 6, 30), tint, base * heightSize, height * heightSize);
        }
      } else if (region.kind === "mountain") {
        const tiers = [[180, 0, 90_000, "#8f9e8a"], [131, 75_000, 180_000, "#acb5a2"],
          [79, 165_000, 265_000, "#c7cbb8"], [35, 250_000, 310_000, "#f0f1da"]] as const;
        for (let tier = 0; tier < tiers.length; tier += 1) {
          const [radius, base, height, tint] = tiers[tier];
          add(region, `rock-${tier}`, polygon(center, radius * footprintSize, radius * footprintSize * 0.82, 5, region.angle + 18), tint, base * heightSize, height * heightSize);
        }
      } else {
        const tiers = [[150, 0, 28_000, "#d3b97c"], [111, 22_000, 53_000, "#e4cb90"], [68, 47_000, 73_000, "#f3dda9"]] as const;
        for (let tier = 0; tier < tiers.length; tier += 1) {
          const [radius, base, height, tint] = tiers[tier];
          add(region, `sand-${tier}`, dunePolygon(center, radius * footprintSize, region.angle), tint, base * heightSize, height * heightSize);
        }
      }
    }
  }
  return { type: "FeatureCollection", features };
}

// One generated local tile, without timers, network assets or per-frame updates.
const biomeData = createBiomeData();
const scaleHeight = (property: string): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"],
  2.5, ["get", property], EARTH_BIOME_MAX_ZOOM, 0];

/** Insert these two layers below the overview/country labels, above geographic fills. */
export function createEarthBiomeOverview(): { source: GeoJSONSourceSpecification; layers: LayerSpecification[] } {
  return {
    source: { type: "geojson", data: biomeData, maxzoom: 0, tolerance: 0, buffer: 0 },
    layers: [
      { id: "earth-biome-shadows", type: "fill", source: EARTH_BIOME_SOURCE, maxzoom: EARTH_BIOME_MAX_ZOOM,
        filter: ["==", ["get", "part"], "shadow"],
        paint: { "fill-color": "#426e58", "fill-antialias": false,
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 2.5, 0.14, EARTH_BIOME_MAX_ZOOM, 0] } },
      { id: "earth-biome-miniatures", type: "fill-extrusion", source: EARTH_BIOME_SOURCE, maxzoom: EARTH_BIOME_MAX_ZOOM,
        filter: ["!=", ["get", "part"], "shadow"],
        paint: { "fill-extrusion-color": ["get", "tint"], "fill-extrusion-height": scaleHeight("height"),
          "fill-extrusion-base": scaleHeight("base"), "fill-extrusion-vertical-gradient": true,
          // Opaque overview uses a single geometry pass; only the short zoom fade needs two.
          "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 2.5, 1, EARTH_BIOME_MAX_ZOOM, 0] } },
    ],
  };
}
