import type { FeatureCollection, MultiPolygon } from "geojson";
import type { FillLayerSpecification } from "maplibre-gl";
import vegetation from "./data/vegetation-illustrated.json";
import { EARTH_VEGETATION_LAYER, earthSeasonVegetationColor } from "./earth-seasons";
export { EARTH_VEGETATION_LAYER } from "./earth-seasons";

export const EARTH_VEGETATION_SOURCE = "earth-local-vegetation";
export const EARTH_VEGETATION_MAX_ZOOM = 5.5;

/** Ornamental tree groups on biome artwork, not mapped forest/land-use data. */
export const earthVegetationData = vegetation as FeatureCollection<MultiPolygon>;

/** One native fill pass; shadows precede trunks, crowns and their lit facets. */
export function earthVegetationLayer(now = Date.now()): FillLayerSpecification {
  return { id: EARTH_VEGETATION_LAYER, type: "fill", source: EARTH_VEGETATION_SOURCE,
    maxzoom: EARTH_VEGETATION_MAX_ZOOM, layout: { "fill-sort-key": ["get", "order"] },
    paint: {
      "fill-color": earthSeasonVegetationColor(now),
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 1.5, 0.9, 3, 0.9, 4.2, 0.45, EARTH_VEGETATION_MAX_ZOOM, 0],
      "fill-antialias": true,
    },
  };
}
