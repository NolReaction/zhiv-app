import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon, Position } from "geojson";
import type { LineLayerSpecification } from "maplibre-gl";

export const EARTH_COAST_SOURCE = "earth-local-coast";

function isArtificialEdge(a: Position, b: Position): boolean {
  return Math.abs(a[0] - b[0]) > 180
    || (Math.abs(a[0]) >= 179.9999 && Math.abs(b[0]) >= 179.9999)
    || Math.abs(a[1]) >= 89.9999 || Math.abs(b[1]) >= 89.9999;
}

/** Exclude GeoJSON's date-line and south-pole closing segments from the visible coast. */
export function createEarthCoastlineData(land: FeatureCollection<Polygon | MultiPolygon>): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (const feature of land.features) {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) {
      let segment: Position[] = [];
      const finish = () => {
        if (segment.length > 1) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: segment } });
        segment = [];
      };
      for (let index = 1; index < ring.length; index += 1) {
        const a = ring[index - 1]; const b = ring[index];
        if (isArtificialEdge(a, b)) { finish(); continue; }
        if (segment.length === 0) segment.push(a);
        segment.push(b);
      }
      finish();
    }
  }
  return { type: "FeatureCollection", features };
}

/** Coarse coast treatment fades out before precise vector coastlines take over. */
export function earthCoastMaterialLayers(): { shadow: LineLayerSpecification; edge: LineLayerSpecification } {
  const shared = { type: "line" as const, source: EARTH_COAST_SOURCE, maxzoom: 4,
    layout: { "line-cap": "round" as const, "line-join": "round" as const } };
  return {
    shadow: { ...shared, id: "earth-coast-soft-shadow", paint: {
      "line-color": "#386d61", "line-width": 5, "line-blur": 2.5,
      "line-translate": [0, 1], "line-translate-anchor": "viewport",
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.3, 2.5, 0.3, 4, 0],
    } },
    edge: { ...shared, id: "earth-coast-soft-edge", paint: {
      "line-color": "#e9eec5", "line-width": 1.6, "line-blur": 0.7,
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.7, 2.5, 0.7, 4, 0],
    } },
  };
}
