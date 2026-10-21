import type { Map as LibreMap } from "maplibre-gl";
import type { EarthWeatherArea } from "./weather";
import type { EarthCloudClip } from "./cloud-art";

export type WeatherPixel = { x: number; y: number };
type ProjectionMap = Pick<LibreMap, "getCenter" | "project" | "unproject">;
export const EARTH_WEATHER_MAX_PIXELS = 1_048_576;
export const EARTH_WEATHER_MAX_SIDE = 1536;
const finite = (point: WeatherPixel | null | undefined): point is WeatherPixel => !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
export const weatherMercatorY = (latitude: number) => (1 - Math.asinh(Math.tan(Math.max(-89.9999, Math.min(89.9999, latitude)) * Math.PI / 180)) / Math.PI) / 2;
export const weatherLatitude = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
export const weatherLongitudeNear = (longitude: number, center: number) => longitude + 360 * Math.round((center - longitude) / 360);

export function earthWeatherCanvasSize(width: number, height: number, deviceRatio = 1) {
  if (![width, height, deviceRatio].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const ratio = Math.min(Math.max(.25, deviceRatio), 1.25, Math.sqrt(EARTH_WEATHER_MAX_PIXELS / (width * height)),
    EARTH_WEATHER_MAX_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), ratio };
}
function clipViewport(points: WeatherPixel[], width: number, height: number) {
  let result = points;
  for (const [axis, edge, greater] of [["x", 0, true], ["x", width, false], ["y", 0, true], ["y", height, false]] as const) {
    const input = result; result = [];
    const inside = (point: WeatherPixel) => greater ? point[axis] >= edge : point[axis] <= edge;
    for (let index = 0; index < input.length; index++) {
      const a = input[index], b = input[(index + 1) % input.length];
      if (inside(a)) result.push(a);
      if (inside(a) !== inside(b)) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
  }
  const edge = (value: number, maximum: number) => Math.abs(value) < 1e-6 ? 0
    : Math.abs(value - maximum) < 1e-6 ? maximum : Math.max(0, Math.min(maximum, value));
  return result.map(point => ({ x: edge(point.x, width), y: edge(point.y, height) }));
}

function convexHull(points: WeatherPixel[]) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: WeatherPixel, b: WeatherPixel, c: WeatherPixel) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (items: WeatherPixel[]) => {
    const result: WeatherPixel[] = [];
    for (const point of items) {
      while (result.length > 1 && cross(result[result.length - 2], result[result.length - 1], point) <= 0) result.pop();
      result.push(point);
    }
    return result;
  };
  const lower = half(sorted), upper = half([...sorted].reverse()); lower.pop(); upper.pop();
  return [...lower, ...upper];
}

/** Sample the actual public globe projection, including its curved cell edges. */
export function earthWeatherFootprint(map: ProjectionMap, area: EarthWeatherArea, width: number, height: number) {
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const center = map.getCenter();
  const longitude = weatherLongitudeNear(area.longitude, center.lng);
  const north = area.latitude === 89 ? 89.9999 : area.latitude + .5;
  const south = area.latitude === -89 ? -89.9999 : area.latitude - .5;
  const positions: [number, number][] = [];
  for (let index = 0; index < 4; index++) for (let step = 0; step < 4; step++) {
    const t = step / 4;
    positions.push(index === 0 ? [longitude - .5 + t, north] : index === 1 ? [longitude + .5, north + (south - north) * t]
      : index === 2 ? [longitude + .5 - t, south] : [longitude - .5, south + (north - south) * t]);
  }
  const points: WeatherPixel[] = [];
  for (const position of positions) {
    const point = map.project(position);
    if (!finite(point)) continue;
    const back = map.unproject(point);
    if (!back || !Number.isFinite(back.lng) || !Number.isFinite(back.lat)) continue;
    const longitudeError = Math.abs(weatherLongitudeNear(back.lng, position[0]) - position[0]);
    if (longitudeError > .001 || Math.abs(back.lat - position[1]) > .001) continue;
    points.push({ x: point.x, y: point.y });
  }
  // A street-level forecast cell is much larger than the viewport. Some of
  // its corners can lie behind a pitched camera: intersect its visible ground
  // rather than dropping the whole cell or unprojecting a bounding box in sky.
  for (let edge = 0; edge < 4; edge++) for (let step = 0; step <= 8; step++) {
    const t = step / 8;
    const point = edge === 0 ? { x: t * width, y: 0 } : edge === 1 ? { x: width, y: t * height }
      : edge === 2 ? { x: (1 - t) * width, y: height } : { x: 0, y: (1 - t) * height };
    const back = map.unproject([point.x, point.y]);
    if (!back || !Number.isFinite(back.lng) || !Number.isFinite(back.lat)) continue;
    const lng = weatherLongitudeNear(back.lng, longitude);
    if (lng < longitude - .5 || lng > longitude + .5 || back.lat < south || back.lat > north) continue;
    const projected = map.project(back);
    if (finite(projected) && Math.hypot(projected.x - point.x, projected.y - point.y) <= .75) points.push(point);
  }
  const polygon = clipViewport(convexHull(points), width, height);
  if (polygon.length < 3) return null;
  const surface = Math.abs(polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length]; return sum + point.x * next.y - point.y * next.x;
  }, 0)) / 2;
  if (!Number.isFinite(surface) || surface < 16) return null;
  return { points: polygon, surface, bounds: {
    left: Math.min(...polygon.map(point => point.x)), right: Math.max(...polygon.map(point => point.x)),
    top: Math.min(...polygon.map(point => point.y)), bottom: Math.max(...polygon.map(point => point.y)),
  } };
}
export type EarthWeatherFootprint = NonNullable<ReturnType<typeof earthWeatherFootprint>>;

/** Local world-to-screen basis keeps material anchored through camera pans/rotation. */
export function earthWeatherFrame(map: ProjectionMap, area: EarthWeatherArea, zoom: number, footprint: EarthWeatherFootprint) {
  const worldSize = 512 * 2 ** Math.floor(zoom), center = map.getCenter();
  const origin = { x: (center.lng + 180) / 360 * worldSize, y: weatherMercatorY(center.lat) * worldSize };
  const base = map.project([center.lng, center.lat]);
  const px = map.project([center.lng + 64 / worldSize * 360, center.lat]);
  const py = map.project([center.lng, weatherLatitude(origin.y / worldSize + 64 / worldSize)]);
  if (![base, px, py].every(finite)) return null;
  const basis = { a: (px.x - base.x) / 64, b: (px.y - base.y) / 64, c: (py.x - base.x) / 64, d: (py.y - base.y) / 64 };
  const samples = footprint.points.map(point => {
    const p = map.unproject([point.x, point.y]);
    if (!p || !Number.isFinite(p.lng) || !Number.isFinite(p.lat)) return null;
    return { x: (weatherLongitudeNear(p.lng, center.lng) + 180) / 360 * worldSize, y: weatherMercatorY(p.lat) * worldSize };
  });
  if (!samples.every(finite)) return null;
  const bounds = { left: Math.min(...samples.map(point => point.x)), right: Math.max(...samples.map(point => point.x)),
    top: Math.min(...samples.map(point => point.y)), bottom: Math.max(...samples.map(point => point.y)) };
  const longitude = weatherLongitudeNear(area.longitude, center.lng);
  const clip: EarthCloudClip = {
    left: (longitude + 179.5) / 360 * worldSize, right: (longitude + 180.5) / 360 * worldSize,
    top: weatherMercatorY(area.latitude === 89 ? 89.9999 : area.latitude + .5) * worldSize,
    bottom: weatherMercatorY(area.latitude === -89 ? -89.9999 : area.latitude - .5) * worldSize, feather: 24,
  };
  clip.feather = Math.max(.1, Math.min(24, (clip.right - clip.left) / 5, (clip.bottom - clip.top) / 5));
  return { worldSize, origin, base, basis, bounds, clip };
}
