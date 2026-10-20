import type { FeatureCollection, MultiPolygon } from "geojson";
import type { FillLayerSpecification } from "maplibre-gl";
import biomes from "./data/biomes-illustrated.json";

export const EARTH_BIOME_SOURCE = "earth-local-biomes";
export const EARTH_BIOME_LAYER = "earth-illustrated-biomes";
export const EARTH_BIOME_MAX_ZOOM = 6;
export const EARTH_BIOME_PALETTE = {
  rainforest: "#589b76", boreal: "#6f9c89", tundra: "#c3c5a0",
  desert: "#dfc28c", savanna: "#c4ca88", steppe: "#a9c18b",
} as const;

/**
 * Authored biome colours, not a climate/season dataset. Contours and feather
 * rings are clipped to land minus local lakes/ice before bundling. No browser
 * clipping, image generation, network service or ongoing simulation is needed.
 */
export const earthBiomeData = biomes as FeatureCollection<MultiPolygon>;

export function earthBiomeLayer(): FillLayerSpecification {
  const p = EARTH_BIOME_PALETTE;
  const opacity = ["to-number", ["get", "opacity"], 0] as const;
  return { id: EARTH_BIOME_LAYER, type: "fill", source: EARTH_BIOME_SOURCE, maxzoom: EARTH_BIOME_MAX_ZOOM,
    paint: {
      "fill-color": ["match", ["get", "biome"], "rainforest", p.rainforest, "boreal", p.boreal,
        "tundra", p.tundra, "desert", p.desert, "savanna", p.savanna, "steppe", p.steppe, "#b5d39b"],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, [...opacity], 3.5, [...opacity], EARTH_BIOME_MAX_ZOOM, 0],
      "fill-antialias": false,
    },
  };
}
