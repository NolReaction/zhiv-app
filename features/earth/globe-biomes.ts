import type { FeatureCollection, MultiPolygon } from "geojson";
import type { FillLayerSpecification } from "maplibre-gl";
import biomes from "./data/biomes-illustrated.json";
import { EARTH_BIOME_LAYER, earthSeasonBiomeColor } from "./earth-seasons";
export { EARTH_BIOME_LAYER, EARTH_BIOME_PALETTE } from "./earth-seasons";

export const EARTH_BIOME_SOURCE = "earth-local-biomes";
export const EARTH_BIOME_MAX_ZOOM = 6;

/**
 * Authored biome colours, not a climate/season dataset. Contours and feather
 * rings are clipped to land minus local lakes/ice before bundling. No browser
 * clipping, image generation, network service or ongoing simulation is needed.
 */
export const earthBiomeData = biomes as FeatureCollection<MultiPolygon>;

export function earthBiomeLayer(now = Date.now()): FillLayerSpecification {
  const opacity = ["to-number", ["get", "opacity"], 0] as const;
  return { id: EARTH_BIOME_LAYER, type: "fill", source: EARTH_BIOME_SOURCE, maxzoom: EARTH_BIOME_MAX_ZOOM,
    paint: {
      "fill-color": earthSeasonBiomeColor(now),
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, [...opacity], 3.5, [...opacity], EARTH_BIOME_MAX_ZOOM, 0],
      "fill-antialias": false,
    },
  };
}
