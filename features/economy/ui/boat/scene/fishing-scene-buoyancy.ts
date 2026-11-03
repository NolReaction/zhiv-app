import type { FishingScenePoint } from "./fishing-scene-types";

export const FISHING_BOAT_PIVOT = { x: 500, y: 535 } as const;
export type FishingBoatTransform = { x: number; y: number; scale: number; roll?: number };

/** Two gentle swells move the entire authored rig; the slower roll lags behind the vertical lift. */
export function fishingBoatMotion(time: number, still: boolean) {
  if (still || !Number.isFinite(time)) return { bob: 0, roll: 0 };
  return { bob: Math.sin(time * 1.05) * 3.8 + Math.sin(time * .57 + .7) * 1.1,
    roll: Math.sin(time * .69 - .28) * .009 + Math.sin(time * 1.07 + .4) * .003 };
}

/** Must match the painter's translate / scale / pivot / rotate order. */
export function transformFishingBoatPoint(point: FishingScenePoint, boat: FishingBoatTransform): FishingScenePoint {
  const roll = boat.roll ?? 0, dx = point.x - FISHING_BOAT_PIVOT.x, dy = point.y - FISHING_BOAT_PIVOT.y;
  return { x: boat.x + (FISHING_BOAT_PIVOT.x + dx * Math.cos(roll) - dy * Math.sin(roll)) * boat.scale,
    y: boat.y + (FISHING_BOAT_PIVOT.y + dx * Math.sin(roll) + dy * Math.cos(roll)) * boat.scale };
}
