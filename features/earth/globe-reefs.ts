import type { FeatureCollection, LineString } from "geojson";
import type { ExpressionSpecification, LineLayerSpecification } from "maplibre-gl";
import reefs from "./data/reefs-illustrated.json";

export const EARTH_REEF_SOURCE = "earth-local-reefs";
export const EARTH_REEF_MAX_ZOOM = 4;

/** A handful of authored offshore accents, not surveyed reef/bathymetry data. */
export const earthReefData = reefs as FeatureCollection<LineString>;

/** Paint before land so even generalized shorelines mask the water illustration. */
export function earthReefLayers(): LineLayerSpecification[] {
  const shared = { type: "line" as const, source: EARTH_REEF_SOURCE, maxzoom: EARTH_REEF_MAX_ZOOM,
    layout: { "line-cap": "round" as const, "line-join": "round" as const } };
  const opacity: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 0, 0.16, 1.5, 0.44, 2.8, 0.46, 4, 0];
  return [
    { ...shared, id: "earth-reef-lagoons", paint: { "line-color": "#8cd9cb", "line-blur": 1.8,
      "line-width": ["interpolate", ["linear"], ["zoom"], 0, 2.5, 2, 7, 4, 10], "line-opacity": [...opacity] } },
    { ...shared, id: "earth-reef-edges", paint: { "line-color": "#d4e8bd", "line-blur": 0.6,
      "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 2, 1.4, 4, 1.8], "line-opacity": [...opacity] } },
  ];
}
