import { FOREST_MAP, type MapPoint } from "./map-manifest";
import runtimeArt from "./runtime-art.json";
export const MAP_SIZE = FOREST_MAP.size;
export const HOME_AREA = FOREST_MAP.homeCrop;
export const MAP_PLACES = { house: FOREST_MAP.house, bush: FOREST_MAP.bush, cave: FOREST_MAP.cave, fishing: FOREST_MAP.water } as const;
export const worldToHome = (point: MapPoint): MapPoint => ({ x: (point.x - HOME_AREA.x) / HOME_AREA.size, y: (point.y - HOME_AREA.y) / HOME_AREA.size });
export const homeToWorld = (point: MapPoint): MapPoint => ({ x: HOME_AREA.x + point.x * HOME_AREA.size, y: HOME_AREA.y + point.y * HOME_AREA.size });
export const containsPoint = (point: MapPoint, bounds: { left: number; right: number; top: number; bottom: number }) =>
  point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;

/** Boundary-inclusive polygon test: shoreline pixels and canvas edges remain clickable. */
export function pointInPolygon(point: MapPoint, polygon: readonly MapPoint[]) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-7 && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x)
      && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function mapPlaceAt(point: MapPoint): "house" | "bush" | "cave" | "fishing" | null {
  if (pointInPolygon(point, FOREST_MAP.water.hitArea)) return "fishing";
  if (pointInPolygon(point, FOREST_MAP.cave.hitArea)) return "cave";
  if (pointInPolygon(point, FOREST_MAP.house.hitArea)) return "house";
  if (pointInPolygon(point, FOREST_MAP.bush.foliage)) return "bush";
  return null;
}
export const HOME_BACKGROUND_STYLE = {
  backgroundImage: `url(${runtimeArt.homePreview})`,
  backgroundSize: "cover",
  backgroundPosition: "center",
} as const;
