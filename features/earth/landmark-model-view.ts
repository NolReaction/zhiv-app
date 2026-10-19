import eiffelModel from "./data/eiffel-model.json";

/** Imported buildings use real metres only at street zoom; atlas miniatures keep their own scale. */
export const EARTH_EIFFEL_STREET_MIN_ZOOM = 15;
export const EARTH_EIFFEL_HEIGHT_METERS = eiffelModel.coordinates.heightMeters;
const EARTH_CIRCUMFERENCE = 40_030_228.884;

export function isEarthEiffelStreetZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom >= EARTH_EIFFEL_STREET_MIN_ZOOM;
}

export function earthEiffelStreetOpacity(zoom: number): number {
  if (!isEarthEiffelStreetZoom(zoom)) return 0;
  const value = Math.max(0, Math.min(1, (zoom - EARTH_EIFFEL_STREET_MIN_ZOOM) / .6));
  return value * value * (3 - 2 * value);
}

/** Conservative loading bounds, not screen clipping: an offscreen foot can have
 * a visible roof. Extend the ground viewport by the tallest corner camera ray
 * plus one building height for the footprint, using only public camera data. */
export function isEarthEiffelNearBounds(location: readonly [number, number], bounds: {
  west: number; east: number; south: number; north: number;
}, camera: { width: number; height: number; pitch: number; verticalFieldOfView: number;
  padding?: Partial<{ top: number; bottom: number; left: number; right: number }> },
  heightMeters = EARTH_EIFFEL_HEIGHT_METERS, elevationMeters = 0): boolean {
  const padding = { top: camera.padding?.top ?? 0, bottom: camera.padding?.bottom ?? 0,
    left: camera.padding?.left ?? 0, right: camera.padding?.right ?? 0 };
  if (![...location, ...Object.values(bounds), camera.width, camera.height, camera.pitch,
    camera.verticalFieldOfView, heightMeters, elevationMeters, ...Object.values(padding)].every(Number.isFinite)
    || camera.width <= 0 || camera.height <= 0 || heightMeters <= 0 || bounds.north < bounds.south) return false;
  const pitch = Math.max(0, Math.min(85, Math.abs(camera.pitch))) * Math.PI / 180;
  const tangent = Math.tan(Math.max(1, Math.min(179.9, camera.verticalFieldOfView)) * Math.PI / 360);
  const x = tangent * (camera.width + Math.abs(padding.left - padding.right)) / camera.height;
  const y = tangent * (1 + Math.abs(padding.top - padding.bottom) / camera.height);
  const downward = Math.cos(pitch) - y * Math.sin(pitch);
  // If a camera ray crosses the horizon, no finite ground-padding bound can
  // guarantee that the silhouette is absent. One bounded model may load then.
  const ray = downward > 0 ? Math.hypot(x, y * Math.cos(pitch) + Math.sin(pitch)) / downward : Infinity;
  const latitudePadding = (heightMeters + Math.abs(elevationMeters)) * (1 + ray) * 360 / EARTH_CIRCUMFERENCE;
  if (location[1] < bounds.south - latitudePadding || location[1] > bounds.north + latitudePadding) return false;
  const longitudePadding = latitudePadding / Math.max(.00001, Math.cos(location[1] * Math.PI / 180));
  const east = bounds.east < bounds.west ? bounds.east + 360 : bounds.east;
  const middle = (bounds.west + east) / 2;
  const longitude = location[0] + Math.round((middle - location[0]) / 360) * 360;
  return longitude >= bounds.west - longitudePadding && longitude <= east + longitudePadding;
}
