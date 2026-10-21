import type { FeatureCollection, LineString } from "geojson";
import type { LineLayerSpecification } from "maplibre-gl";
import rivers from "./data/rivers-110m.json";

export const EARTH_OVERVIEW_RIVER_SOURCE = "earth-local-rivers";
export const EARTH_OVERVIEW_RIVER_LAYER = "earth-overview-rivers";
export const EARTH_OVERVIEW_RIVER_MAX_ZOOM = 5;

/** Pinned Natural Earth 110m lines: a small-scale atlas, never walking navigation. */
export const earthOverviewRiverData = rivers as FeatureCollection<LineString>;

/** Above illustrated land/relief, below physical lakes/ice and precise water. */
export function earthOverviewRiverLayer(): LineLayerSpecification {
  return { id: EARTH_OVERVIEW_RIVER_LAYER, type: "line", source: EARTH_OVERVIEW_RIVER_SOURCE,
    maxzoom: EARTH_OVERVIEW_RIVER_MAX_ZOOM,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#68b8bd",
      "line-width": ["interpolate", ["linear"], ["zoom"], 0,
        ["match", ["get", "rank"], 1, 0.65, 0.45], 2,
        ["match", ["get", "rank"], 1, 1.3, 0.9], 4,
        ["match", ["get", "rank"], 1, 1.8, 1.25], 5, 1.9],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.62, 2, 0.86, 3, 0.8, 4, 0.25, EARTH_OVERVIEW_RIVER_MAX_ZOOM, 0],
    },
  };
}
