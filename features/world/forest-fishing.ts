import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { isForestWater } from "./forest-water";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export const FISHING_WATER_LIMITS = { rings: 13, directions: 48, polygons: 256, edges: 20_000 } as const;
export type FishingAction = "walk" | "idle" | "cast" | "fish" | "bite" | "reel" | "catch" | "pack" | "rest";
export type ForestFishingFrame = WorldPoint & {
  size: number; direction: PixelDirection; action: FishingAction; phase: number; frame: number;
  carryingFish: boolean; basketFilled?: boolean; waterTarget?: WorldPoint;
};

/** Only authored water can receive a float. The whole largest ripple must fit,
 * including exclusions smaller than an animation pixel. This bounded search is
 * called when a place changes, never from the animation's per-frame painter. */
export function fishingWaterTarget(scene: FixedWorldScene, base: WorldPoint, size: number): WorldPoint | undefined {
  if (![base.x, base.y, size].every(Number.isFinite) || size <= 0 || !scene.water
    || !Array.isArray(scene.water.surfaces) || !Array.isArray(scene.water.exclusions) || !scene.water.surfaces.length
    || scene.water.surfaces.length + scene.water.exclusions.length > FISHING_WATER_LIMITS.polygons) return;
  const polygons = [...scene.water.surfaces, ...scene.water.exclusions]; let edgeCount = 0;
  for (const polygon of polygons) {
    if (!polygon || !Array.isArray(polygon.points) || polygon.points.length < 3
      || (edgeCount += polygon.points.length) > FISHING_WATER_LIMITS.edges
      || !polygon.points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) return;
  }
  const clearance = size * .25, start = size * .65, step = size * .13;
  const edges = polygons.flatMap(polygon => polygon.points.map((a, index) =>
    ({ a, b: polygon.points[(index + 1) % polygon.points.length] })));
  for (let ring = 0; ring < FISHING_WATER_LIMITS.rings; ring++) {
    const radius = start + ring * step;
    for (let sample = 0; sample < FISHING_WATER_LIMITS.directions; sample++) {
      const angle = Math.PI * (.25 + sample * 2 / FISHING_WATER_LIMITS.directions);
      const point = { x: base.x + Math.cos(angle) * radius, y: base.y + Math.sin(angle) * radius };
      if (point.x < clearance || point.y < clearance || point.x > scene.width - clearance || point.y > scene.height - clearance
        || !isForestWater(scene, point)) continue;
      const crossesEdge = edges.some(({ a, b }) => {
        if (point.x + clearance < Math.min(a.x, b.x) || point.x - clearance > Math.max(a.x, b.x)
          || point.y + clearance < Math.min(a.y, b.y) || point.y - clearance > Math.max(a.y, b.y)) return false;
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        return (point.x - a.x - dx * t) ** 2 + (point.y - a.y - dy * t) ** 2 <= clearance * clearance;
      });
      if (!crossesEdge) return point;
    }
  }
}

const actions: readonly { action: FishingAction; seconds: number; carryingFish: boolean }[] = [
  { action: "idle", seconds: 1.4, carryingFish: false },
  { action: "cast", seconds: 1.8, carryingFish: false },
  { action: "fish", seconds: 10.5, carryingFish: false },
  { action: "bite", seconds: 1.3, carryingFish: false },
  { action: "reel", seconds: 2.8, carryingFish: false },
  { action: "catch", seconds: 2.4, carryingFish: true },
  { action: "pack", seconds: 2.2, carryingFish: true },
  { action: "rest", seconds: 3.5, carryingFish: true },
];
export const FOREST_FISHING_CYCLE_SECONDS = actions.reduce((sum, action) => sum + action.seconds, 0);
export const FOREST_FISHING_FIRST_CATCH_SECONDS = actions.slice(0, 5).reduce((sum, action) => sum + action.seconds, 0);

/** Pure cosmetic cycle: no inventory, server reward or wall-clock ownership. */
export function fishingActionFrame(elapsed: number, still = false): Pick<ForestFishingFrame, "action" | "phase" | "frame" | "carryingFish" | "basketFilled"> {
  if (still) return { action: "fish", phase: .3, frame: 0, carryingFish: false };
  const time = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
  let age = time % FOREST_FISHING_CYCLE_SECONDS;
  for (const stage of actions) {
    if (age < stage.seconds) return { action: stage.action, phase: age / stage.seconds,
      frame: Math.floor(age * 4) % 4, carryingFish: stage.carryingFish || time >= FOREST_FISHING_CYCLE_SECONDS,
      basketFilled: time >= FOREST_FISHING_CYCLE_SECONDS || stage.action === "rest"
        || stage.action === "pack" && age / stage.seconds > .65 };
    age -= stage.seconds;
  }
  return { action: "idle", phase: 0, frame: 0, carryingFish: false };
}

export function fishingDirection(base: WorldPoint, water?: WorldPoint): PixelDirection {
  if (!water) return "front";
  const dx = water.x - base.x, dy = water.y - base.y;
  return Math.abs(dx) >= Math.abs(dy) ? dx < 0 ? "left" : "right" : dy < 0 ? "back" : "front";
}
