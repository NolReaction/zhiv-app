import type { FeatureCollection, Polygon } from "geojson";
import type { FillLayerSpecification } from "maplibre-gl";
import relief from "./data/relief-illustrated.json";

export const EARTH_RELIEF_SOURCE = "earth-local-relief";
export const EARTH_RELIEF_LAYER = "earth-overview-relief";
export const EARTH_RELIEF_MAX_ZOOM = 4;

/**
 * Precomputed artistic mountain-region, plateau, volcano, glacier and desert accents, not measured elevation or a DEM.
 * Prepared by scripts/prepare-earth-relief.mjs; no browser geometry generation,
 * coastal loops, terrain mesh, network fetch, timer or per-frame updates.
 */
export const earthReliefData = relief as FeatureCollection<Polygon>;

export function earthReliefLayer(): FillLayerSpecification {
  return { id: EARTH_RELIEF_LAYER, type: "fill", source: EARTH_RELIEF_SOURCE, maxzoom: EARTH_RELIEF_MAX_ZOOM,
    paint: {
      "fill-color": ["match", ["get", "tone"],
        "light", "rgba(242, 235, 188, 0.8)", "shade", "rgba(70, 110, 76, 0.52)",
        "valley", "rgba(91, 126, 79, 0.32)", "spur", "rgba(228, 226, 170, 0.42)",
        "snow", "rgba(244, 247, 225, 0.96)", "snow-shade", "rgba(179, 210, 202, 0.92)",
        "plateau-cool", "rgba(184, 184, 148, 0.48)", "plateau-warm", "rgba(208, 179, 126, 0.5)",
        "plateau-green", "rgba(121, 157, 106, 0.42)", "plateau-rim-light", "rgba(236, 221, 171, 0.56)",
        "plateau-rim-shade", "rgba(79, 111, 83, 0.36)", "volcano-light", "rgba(204, 190, 151, 0.7)",
        "volcano-shade", "rgba(104, 120, 96, 0.62)", "volcano-apron", "rgba(77, 111, 88, 0.12)",
        "volcano-snow", "rgba(244, 247, 230, 0.93)", "volcano-snow-shade", "rgba(190, 211, 204, 0.9)",
        "volcano-crater", "rgba(88, 105, 90, 0.63)", "glacier-light", "rgba(232, 244, 225, 0.88)",
        "glacier-shade", "rgba(150, 199, 193, 0.72)", "dune-light", "rgba(251, 226, 168, 0.72)",
        "dune-shade", "rgba(180, 132, 80, 0.43)", "rock-top", "rgba(217, 179, 122, 0.73)",
        "rock-light", "rgba(231, 196, 142, 0.68)", "rock-shade", "rgba(126, 102, 76, 0.53)",
        "rgba(118, 146, 90, 0.22)"],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.42, 2, 0.85, 3, 0.85, EARTH_RELIEF_MAX_ZOOM, 0],
      "fill-antialias": false,
    },
  };
}
