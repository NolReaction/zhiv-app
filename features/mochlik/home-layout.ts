import { FOREST_MAP, type MapPoint } from "@/features/world/map-manifest";
import { HOME_AREA, worldToHome } from "@/features/world/map-layout";
/** Animation/effect units stay 256; background retains all source pixels. */
export const HOME_CANVAS_SIZE = 256;
export const homePixel = (point: MapPoint) => { const p = worldToHome(point); return { x: p.x * HOME_CANVAS_SIZE, y: p.y * HOME_CANVAS_SIZE }; };
const lamp = { ...homePixel(FOREST_MAP.house.lamp), width: FOREST_MAP.house.lamp.width * HOME_CANVAS_SIZE / HOME_AREA.size, height: FOREST_MAP.house.lamp.height * HOME_CANVAS_SIZE / HOME_AREA.size };
export const HOUSE_ANCHORS = {
  inside: worldToHome(FOREST_MAP.house.inside),
  doorstep: worldToHome(FOREST_MAP.house.doorstep),
  threshold: worldToHome({ x: 667, y: 616 }),
  doorway: FOREST_MAP.house.doorway.map(homePixel),
  sleep: homePixel(FOREST_MAP.house.sleep),
  lamp,
} as const;
export const BUSH_FOLIAGE = FOREST_MAP.bush.foliage.map(homePixel);

/** Retained streak gifts follow the detailed house instead of the old scene's offsets. */
export const HOME_DECOR = {
  flower: homePixel({ x: 643, y: 623 }),
  bed: homePixel({ x: 667, y: 612 }),
  keepsakes: homePixel({ x: 690, y: 634 }),
  garland: { left: homePixel({ x: 651, y: 580 }), right: homePixel({ x: 682, y: 582 }), sag: 1.5 },
} as const;

/** Depth follows the threshold, so the same position has the same occlusion in both directions. */
export function isBehindDoorThreshold(position: { y: number }): boolean {
  return position.y <= HOUSE_ANCHORS.threshold.y;
}
