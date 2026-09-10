import { FOREST_MAP, type MapPoint } from "@/features/world/map-manifest";
import { HOME_AREA, worldToHome } from "@/features/world/map-layout";
/** Animation/effect units stay 256; background retains all source pixels. */
export const HOME_CANVAS_SIZE = 256;
export const homePixel = (point: MapPoint) => { const p = worldToHome(point); return { x: p.x * HOME_CANVAS_SIZE, y: p.y * HOME_CANVAS_SIZE }; };
const lamp = { ...homePixel(FOREST_MAP.house.lamp), width: FOREST_MAP.house.lamp.width * HOME_CANVAS_SIZE / HOME_AREA.size, height: FOREST_MAP.house.lamp.height * HOME_CANVAS_SIZE / HOME_AREA.size };
export const HOUSE_ANCHORS = {
  inside: worldToHome(FOREST_MAP.house.inside),
  doorstep: worldToHome(FOREST_MAP.house.doorstep),
  doorway: FOREST_MAP.house.doorway.map(homePixel),
  sleep: homePixel(FOREST_MAP.house.sleep),
  lamp,
  lampHighlight: { x: lamp.x + 1, y: lamp.y, width: 1, height: lamp.height - 1 },
  lampGlow: [{ x: lamp.x - 3, y: lamp.y - 2, width: lamp.width + 6, height: lamp.height + 4 }],
} as const;
export const BUSH_FOLIAGE = FOREST_MAP.bush.foliage.map(homePixel);
