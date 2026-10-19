import type { ExpressionSpecification, FilterSpecification, FillExtrusionLayerSpecification } from "maplibre-gl";

export const EARTH_BUILDINGS_3D_LAYER = "earth-buildings-3d";
export const EARTH_BUILDINGS_3D_MIN_ZOOM = 15;
export const EARTH_BUILDINGS_HEIGHT_LIMIT = 300;

// OpenMapTiles approximates render_height/render_min_height from OSM heights
// and levels. Keep malformed data finite, and cap the stylized skyline at 300m.
const height: ExpressionSpecification = ["max", 0, ["min", EARTH_BUILDINGS_HEIGHT_LIMIT,
  // to-number(null) is zero, so a missing height needs a nonnumeric sentinel
  // before conversion or MapLibre would silently flatten unknown buildings.
  ["to-number", ["coalesce", ["get", "render_height"], "unknown"], ["coalesce", ["get", "height"], "unknown"], 8]]];
const base: ExpressionSpecification = ["max", 0, ["min", height,
  ["to-number", ["coalesce", ["get", "render_min_height"], "unknown"], ["coalesce", ["get", "min_height"], "unknown"], 0]]];
const ramp = (value: ExpressionSpecification): ExpressionSpecification =>
  ["interpolate", ["linear"], ["zoom"], EARTH_BUILDINGS_3D_MIN_ZOOM, 0, EARTH_BUILDINGS_3D_MIN_ZOOM + 1, value];

export const EARTH_BUILDING_FILTER: FilterSpecification = ["all",
  // Building outlines duplicate their detailed building:part geometry; the
  // provider explicitly flags those outlines so they do not become solid boxes.
  ["match", ["to-string", ["get", "hide_3d"]], ["true", "1", "yes"], false, true],
  ["match", ["to-string", ["get", "indoor"]], ["true", "1", "yes"], false, true],
  ["!=", ["get", "location"], "underground"],
  [">", height, 0],
];

export function createEarthBuildingLayer(source: string, color: string): FillExtrusionLayerSpecification {
  return {
    id: EARTH_BUILDINGS_3D_LAYER, type: "fill-extrusion", source, "source-layer": "building",
    minzoom: EARTH_BUILDINGS_3D_MIN_ZOOM, filter: EARTH_BUILDING_FILTER,
    layout: { visibility: "visible" },
    paint: {
      "fill-extrusion-color": color,
      "fill-extrusion-height": ramp(height), "fill-extrusion-base": ramp(base),
      // Opaque single-pass geometry avoids the additional transparent pass.
      "fill-extrusion-opacity": 1, "fill-extrusion-vertical-gradient": true,
    },
  };
}
