import type { FeatureCollection, Polygon } from "geojson";
import type { FillLayerSpecification } from "maplibre-gl";
import relief from "./data/relief-illustrated.json";

export const EARTH_RELIEF_SOURCE = "earth-local-relief";
export const EARTH_RELIEF_LAYER = "earth-overview-relief";
export const EARTH_RELIEF_MAX_ZOOM = 4;

/**
 * Precomputed artistic mountain-region accents, not measured elevation or a DEM.
 * Prepared by scripts/prepare-earth-relief.mjs; no browser geometry generation,
 * coastal loops, terrain mesh, network fetch, timer or per-frame updates.
 */
export const earthReliefData = relief as FeatureCollection<Polygon>;

export function earthReliefLayer(): FillLayerSpecification {
  return { id: EARTH_RELIEF_LAYER, type: "fill", source: EARTH_RELIEF_SOURCE, maxzoom: EARTH_RELIEF_MAX_ZOOM,
    paint: {
      "fill-color": ["match", ["get", "tone"],
        "light", "rgba(242, 235, 188, 0.8)", "shade", "rgba(70, 110, 76, 0.52)",
        "valley", "rgba(91, 126, 79, 0.32)", "spur", "rgba(228, 226, 170, 0.42)", "rgba(118, 146, 90, 0.22)"],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.42, 2, 0.85, 3, 0.85, EARTH_RELIEF_MAX_ZOOM, 0],
      "fill-antialias": false,
    },
  };
}
