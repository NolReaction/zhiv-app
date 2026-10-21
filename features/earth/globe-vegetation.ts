import type { FeatureCollection, MultiPolygon } from "geojson";
import type { FillLayerSpecification } from "maplibre-gl";
import vegetation from "./data/vegetation-illustrated.json";

export const EARTH_VEGETATION_SOURCE = "earth-local-vegetation";
export const EARTH_VEGETATION_LAYER = "earth-illustrated-vegetation";
export const EARTH_VEGETATION_MAX_ZOOM = 5.5;

/** Ornamental tree groups on biome artwork, not mapped forest/land-use data. */
export const earthVegetationData = vegetation as FeatureCollection<MultiPolygon>;

/** One native fill pass; shadows precede trunks, crowns and their lit facets. */
export function earthVegetationLayer(): FillLayerSpecification {
  return { id: EARTH_VEGETATION_LAYER, type: "fill", source: EARTH_VEGETATION_SOURCE,
    maxzoom: EARTH_VEGETATION_MAX_ZOOM, layout: { "fill-sort-key": ["get", "order"] },
    paint: {
      "fill-color": ["case", ["==", ["get", "tone"], "shadow"], "rgba(49, 86, 66, 0.2)",
        ["==", ["get", "tone"], "trunk"], "rgba(102, 103, 68, 0.7)",
        ["==", ["get", "family"], "boreal"],
        ["case", ["==", ["get", "tone"], "light"], "#83af92", "#437c6b"],
        ["==", ["get", "family"], "rainforest"],
        ["case", ["==", ["get", "tone"], "light"], "#80b58b", "#3d8065"],
        ["case", ["==", ["get", "tone"], "light"], "#c1ce89", "#8b9e5c"]],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 1.5, 0.9, 3, 0.9, 4.2, 0.45, EARTH_VEGETATION_MAX_ZOOM, 0],
      "fill-antialias": true,
    },
  };
}
