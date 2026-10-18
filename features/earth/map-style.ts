import type { FeatureCollection, Polygon } from "geojson";
import type { SkySpecification } from "maplibre-gl";
import type { EarthPosition } from "./location";

export const EARTH_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
export const EARTH_CENTER: [number, number] = [35, 27];
export const EARTH_ACCURACY_SOURCE = "earth-position-accuracy";
const EARTH_RADIUS_METERS = 6_371_008.8;

export const EARTH_SKY: SkySpecification = {
  "sky-color": "#071c24",
  "horizon-color": "#a6ded5",
  "fog-color": "#c4e6df",
  "sky-horizon-blend": 0.35,
  "horizon-fog-blend": 0.6,
  "fog-ground-blend": 0.85,
  "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.8, 5, 0.65, 8, 0],
};

/** Fit the whole globe on a narrow phone as well as a wide desktop panel. */
export function globeZoom(width: number, height: number): number {
  return Math.max(-1.5, Math.min(1.4, Math.log2(Math.max(180, Math.min(width, height)) / 512) + 0.4));
}

/** Keep a coarse fix in view instead of suggesting street-level precision. */
export function positionZoom(accuracy: number): number {
  return Math.max(3, Math.min(15, 18 - Math.log2(Math.max(1, accuracy) / 10)));
}

/**
 * A geodesic radius in meters, not a screen-space circle. Longitudes are
 * unwrapped so a fix beside the date line does not fill the entire world.
 */
export function positionAccuracyData(position: EarthPosition | null): FeatureCollection<Polygon> {
  const empty: FeatureCollection<Polygon> = { type: "FeatureCollection", features: [] };
  if (!position || !Number.isFinite(position.latitude) || !Number.isFinite(position.longitude)
    || !Number.isFinite(position.accuracy) || Math.abs(position.latitude) > 90
    || Math.abs(position.longitude) > 180 || position.accuracy <= 0) return empty;

  // A fix whose radius exceeds a hemisphere is not useful to draw as a local area.
  if (position.accuracy >= Math.PI * EARTH_RADIUS_METERS / 2) return empty;
  const latitude = position.latitude * Math.PI / 180;
  const longitude = position.longitude * Math.PI / 180;
  const radius = position.accuracy / EARTH_RADIUS_METERS;
  const ring: number[][] = [];
  const segments = 64;
  for (let index = 0; index < segments; index += 1) {
    const bearing = index / segments * Math.PI * 2;
    const pointLatitude = Math.asin(Math.max(-1, Math.min(1,
      Math.sin(latitude) * Math.cos(radius) + Math.cos(latitude) * Math.sin(radius) * Math.cos(bearing))));
    const pointLongitude = longitude + Math.atan2(
      Math.sin(bearing) * Math.sin(radius) * Math.cos(latitude),
      Math.cos(radius) - Math.sin(latitude) * Math.sin(pointLatitude),
    );
    let degrees = pointLongitude * 180 / Math.PI;
    const previous = ring.at(-1)?.[0] ?? position.longitude;
    while (degrees - previous > 180) degrees -= 360;
    while (degrees - previous < -180) degrees += 360;
    ring.push([degrees, pointLatitude * 180 / Math.PI]);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  // Circles containing a pole need a closure along that pole, not across Earth.
  if (Math.abs(last[0] - first[0]) > 180) {
    const pole = position.latitude >= 0 ? 90 : -90;
    ring.push([last[0], pole], [first[0], pole]);
  }
  ring.push([...first]);
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }],
  };
}
