import type { FeatureCollection, Polygon } from "geojson";
import type { ExpressionSpecification, LayerSpecification, StyleSpecification, VectorSourceSpecification } from "maplibre-gl";
import land from "./data/land-110m.json";
import { EARTH_TILE_BASE_LAYER } from "./tile-base";
import { EARTH_OVERVIEW_SOURCE, earthOverviewData } from "./globe-overview";
import { createEarthBuildingLayer } from "./building-style";
import { earthLandMaterialLayer } from "./land-material";
import { EARTH_COAST_SOURCE, createEarthCoastlineData, earthCoastMaterialLayers } from "./coast-material";
import { earthOceanBackgroundLayer, earthOceanWaterLayer } from "./globe-ocean";
import { earthLightingSources, earthLightingLayers } from "./globe-lighting";
import { EARTH_RELIEF_SOURCE, earthReliefData, earthReliefLayer } from "./globe-relief";

export const EARTH_LAND_SOURCE = "earth-local-land";
export const EARTH_VECTOR_SOURCE = "earth-streets";
export const EARTH_PALETTE = {
  ocean: "#65bdc7", land: "#b5d39b", forest: "#75b58b", grass: "#9acb91",
  sand: "#efe4ae", ice: "#edf7e4", neighborhood: "#cbe0b2", park: "#94d2a0",
  road: "#fff6da", highway: "#f3cb82", roadEdge: "#b6c89e", building: "#e5c6a7",
  buildingEdge: "#c6a98d", ink: "#315b53", mutedInk: "#4e7970", halo: "#f5fae9",
} as const;

const names: ExpressionSpecification = ["coalesce", ["get", "name:ru"], ["get", "name"], ["get", "name:latin"], ["get", "name_en"], ""];
const zoomWidth = (low: number, high: number): ExpressionSpecification => ["interpolate", ["exponential", 1.4], ["zoom"], 5, low, 18, high];
const textPaint = { "text-color": EARTH_PALETTE.ink, "text-halo-color": EARTH_PALETTE.halo, "text-halo-width": 1.5, "text-halo-blur": 0.3 };

/** A compact, sprite-free OpenMapTiles style with a complete local low-zoom globe. */
export function createCartoonEarthStyle(vector: VectorSourceSpecification): StyleSpecification {
  const p = EARTH_PALETTE;
  const details = { source: EARTH_VECTOR_SOURCE, minzoom: 4 };
  const coast = earthCoastMaterialLayers();
  const textLayout = { "text-field": names, "text-font": ["Arial", "sans-serif"], "text-max-width": 9, "text-padding": 5 };
  const layers: LayerSpecification[] = [
    { id: "earth-ocean", type: "background", paint: { "background-color": p.ocean } },
    earthOceanBackgroundLayer(),
    { id: "earth-ocean-grid", type: "line", source: EARTH_OVERVIEW_SOURCE, maxzoom: 3,
      filter: ["==", ["get", "kind"], "grid"],
      paint: { "line-color": "#c4ece1", "line-width": 0.7,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.26, 2, 0.18, 3, 0] } },
    coast.shadow,
    { id: "earth-land", type: "fill", source: EARTH_LAND_SOURCE,
      paint: { "fill-color": p.land, "fill-antialias": false } },
    earthLandMaterialLayer("earth-land-material", EARTH_LAND_SOURCE),
    earthReliefLayer(),
    coast.edge,
    { id: "earth-overview-ice", type: "fill", source: EARTH_OVERVIEW_SOURCE,
      filter: ["==", ["get", "kind"], "ice"], paint: { "fill-color": p.ice, "fill-antialias": false } },
    { id: "earth-overview-lakes", type: "fill", source: EARTH_OVERVIEW_SOURCE,
      filter: ["==", ["get", "kind"], "lake"], paint: { "fill-color": p.ocean, "fill-antialias": false } },
    earthOceanWaterLayer("earth-overview-lake-waves", EARTH_OVERVIEW_SOURCE, undefined, ["==", ["get", "kind"], "lake"]),
    { id: "earth-detail-land", type: "fill", ...details, "source-layer": EARTH_TILE_BASE_LAYER,
      paint: { "fill-color": p.land, "fill-antialias": false } },
    earthLandMaterialLayer("earth-detail-land-material", EARTH_VECTOR_SOURCE, EARTH_TILE_BASE_LAYER),
    { id: "earth-landcover", type: "fill", ...details, minzoom: 1.5, "source-layer": "landcover",
      paint: { "fill-antialias": false, "fill-color": ["match", ["get", "class"], "wood", p.forest,
        ["grass", "farmland"], p.grass, "ice", p.ice, "sand", p.sand, p.land], "fill-opacity": 0.7 } },
    { id: "earth-neighborhoods", type: "fill", ...details, minzoom: 9, "source-layer": "landuse",
      paint: { "fill-color": ["match", ["get", "class"], ["park", "cemetery", "pitch"], p.park,
        ["school", "hospital"], "#e3ddba", p.neighborhood], "fill-opacity": 0.55 } },
    { id: "earth-parks", type: "fill", ...details, minzoom: 7, "source-layer": "park",
      paint: { "fill-color": p.park, "fill-opacity": 0.6 } },
    { id: "earth-water", type: "fill", ...details, "source-layer": "water",
      filter: ["!=", ["get", "brunnel"], "tunnel"], paint: { "fill-color": p.ocean, "fill-antialias": false } },
    earthOceanWaterLayer("earth-water-waves", EARTH_VECTOR_SOURCE, "water", ["!=", ["get", "brunnel"], "tunnel"]),
    { id: "earth-rivers", type: "line", ...details, minzoom: 8, "source-layer": "waterway",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.ocean, "line-width": zoomWidth(0.4, 5) } },
    { id: "earth-borders", type: "line", source: EARTH_VECTOR_SOURCE, minzoom: 2, "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
      paint: { "line-color": "#80b18f", "line-width": 1, "line-opacity": 0.65, "line-dasharray": [3, 2] } },
    { id: "earth-roads-edge", type: "line", ...details, minzoom: 10, "source-layer": "transportation",
      filter: ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"], true, false],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.roadEdge, "line-width": zoomWidth(0.5, 10) } },
    { id: "earth-roads", type: "line", ...details, minzoom: 10, "source-layer": "transportation",
      filter: ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"], true, false],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.road, "line-width": zoomWidth(0.2, 7) } },
    { id: "earth-main-roads", type: "line", ...details, minzoom: 6, "source-layer": "transportation",
      filter: ["match", ["get", "class"], ["motorway", "trunk", "primary"], true, false],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.highway, "line-width": zoomWidth(0.6, 8) } },
    { id: "earth-paths", type: "line", ...details, minzoom: 14, "source-layer": "transportation",
      filter: ["match", ["get", "class"], ["path", "track", "pedestrian"], true, false],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.road, "line-width": zoomWidth(0.2, 2), "line-dasharray": [2, 1] } },
    { id: "earth-buildings", type: "fill", ...details, minzoom: 14, "source-layer": "building",
      paint: { "fill-color": p.building, "fill-outline-color": p.buildingEdge } },
    createEarthBuildingLayer(EARTH_VECTOR_SOURCE, p.building),
    ...earthLightingLayers(),
    { id: "earth-continent-names", type: "symbol", source: EARTH_OVERVIEW_SOURCE, maxzoom: 2.6,
      filter: ["==", ["get", "kind"], "continent"],
      layout: { ...textLayout, "text-font": ["Arial Bold", "Arial", "sans-serif"], "text-size": 13,
        "text-letter-spacing": 0.08, "text-max-width": 7, "text-pitch-alignment": "map", "text-rotation-alignment": "map" },
      paint: { ...textPaint, "text-halo-width": 1,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0.92, 2.6, 0] } },
    { id: "earth-ocean-names", type: "symbol", source: EARTH_OVERVIEW_SOURCE, maxzoom: 3.5,
      filter: ["==", ["get", "kind"], "ocean"],
      layout: { ...textLayout, "text-font": ["Arial Italic", "Arial", "sans-serif"], "text-size": 11,
        "text-letter-spacing": 0.1, "text-max-width": 10, "text-pitch-alignment": "map", "text-rotation-alignment": "map" },
      paint: { "text-color": "#2d7180", "text-halo-color": "#a0d8d6", "text-halo-width": 0.6,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 2.5, 0.85, 3.5, 0] } },
    { id: "earth-country-names", type: "symbol", source: EARTH_VECTOR_SOURCE, "source-layer": "place", minzoom: 2.4, maxzoom: 8,
      filter: ["==", ["get", "class"], "country"],
      layout: { ...textLayout, "text-font": ["Arial Bold", "Arial", "sans-serif"],
        "text-pitch-alignment": "map", "text-rotation-alignment": "map",
        "text-size": ["interpolate", ["linear"], ["zoom"], 1, 11, 6, 17] },
      paint: { ...textPaint, "text-opacity": ["interpolate", ["linear"], ["zoom"], 2.4, 0, 3, 1] } },
    { id: "earth-city-names", type: "symbol", source: EARTH_VECTOR_SOURCE, "source-layer": "place", minzoom: 3,
      filter: ["==", ["get", "class"], "city"],
      layout: { ...textLayout, "text-size": ["interpolate", ["linear"], ["zoom"], 3, 11, 12, 17] }, paint: textPaint },
    { id: "earth-town-names", type: "symbol", source: EARTH_VECTOR_SOURCE, "source-layer": "place", minzoom: 8,
      filter: ["match", ["get", "class"], ["town", "village", "suburb", "neighbourhood"], true, false],
      layout: { ...textLayout, "text-size": 12 }, paint: textPaint },
    { id: "earth-road-names", type: "symbol", source: EARTH_VECTOR_SOURCE, "source-layer": "transportation_name", minzoom: 14,
      layout: { ...textLayout, "symbol-placement": "line", "text-size": 11, "text-max-angle": 30 },
      paint: { ...textPaint, "text-color": p.mutedInk } },
    { id: "earth-water-names", type: "symbol", source: EARTH_VECTOR_SOURCE, "source-layer": "water_name", minzoom: 6,
      layout: { ...textLayout, "text-font": ["Arial Italic", "Arial", "sans-serif"], "text-size": 12 },
      paint: { ...textPaint, "text-color": "#287e88", "text-halo-width": 1 } },
    { id: "earth-places-dots", type: "circle", source: EARTH_VECTOR_SOURCE, "source-layer": "poi", minzoom: 16,
      filter: ["all", ["==", ["geometry-type"], "Point"], ["<=", ["coalesce", ["get", "rank"], 100], 7]],
      paint: { "circle-radius": 3.5, "circle-color": "#edb86e", "circle-stroke-width": 1.5, "circle-stroke-color": p.halo } },
    { id: "earth-places-names", type: "symbol", source: EARTH_VECTOR_SOURCE, "source-layer": "poi", minzoom: 16,
      filter: ["all", ["==", ["geometry-type"], "Point"], ["<=", ["coalesce", ["get", "rank"], 100], 7]],
      layout: { ...textLayout, "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.7], "text-padding": 8 },
      paint: { ...textPaint, "text-color": p.mutedInk } },
  ];
  return {
    version: 8, name: "Жив — Земля", projection: { type: "globe" },
    light: { anchor: "viewport", color: "#fff7e9", intensity: 0.35, position: [1.5, 210, 35] },
    sources: {
      [EARTH_LAND_SOURCE]: { type: "geojson", data: land as FeatureCollection<Polygon>, maxzoom: 0,
        tolerance: 0, buffer: 0, attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a>' },
      [EARTH_VECTOR_SOURCE]: { ...vector },
      [EARTH_OVERVIEW_SOURCE]: { type: "geojson", data: earthOverviewData, maxzoom: 0, tolerance: 0, buffer: 0 },
      [EARTH_COAST_SOURCE]: { type: "geojson", data: createEarthCoastlineData(land as FeatureCollection<Polygon>), maxzoom: 0, tolerance: 0, buffer: 0 },
      [EARTH_RELIEF_SOURCE]: { type: "geojson", data: earthReliefData, maxzoom: 0, tolerance: 0, buffer: 0 },
      ...earthLightingSources(),
    }, layers,
  };
}
