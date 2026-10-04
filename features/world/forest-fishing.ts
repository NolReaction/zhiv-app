import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { FISHING_PACK_RELEASE, type FishingMotion } from "./fishing-props";
import { isForestWater } from "./forest-water";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export const FISHING_WATER_LIMITS = { rings: 13, directions: 48, polygons: 256, edges: 20_000 } as const;
export type FishingAction = "walk" | "idle" | "cast" | "fish" | "bite" | "reel" | "catch" | "pack" | "rest";
export type ForestFishingFrame = WorldPoint & FishingMotion & {
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

type FishingStage = FishingMotion & { action: FishingAction; seconds: number; start: number; end: number };
type FishingCast = {
  outcome: NonNullable<FishingMotion["outcome"]>; catchScale: number; prepare: number; cast: number;
  waits: readonly (readonly [NonNullable<FishingMotion["variation"]>, number])[];
  bite: number; reel: number; catch?: number; pack?: number; rest: number;
};
const casts: readonly FishingCast[] = [
  { outcome: "small", catchScale: .95, prepare: 1.4, cast: 1.8,
    waits: [["calm", 4.8], ["check", 1.3], ["calm", 2.1], ["nibble", 2.3]],
    bite: 1.3, reel: 2.8, catch: 2.4, pack: 2.2, rest: 3.5 },
  { outcome: "miss", catchScale: 1, prepare: 1, cast: 1.6,
    waits: [["calm", 3.2], ["nibble", 1.4], ["calm", 2.5], ["check", 1.2], ["nibble", 1]],
    bite: .8, reel: 1.8, rest: 2.8 },
  { outcome: "large", catchScale: 1.35, prepare: 1.6, cast: 2,
    waits: [["calm", 5], ["check", 1.5], ["nibble", 1.2], ["calm", 5.1], ["nibble", 1.8]],
    bite: 1.8, reel: 4.8, catch: 3, pack: 2.8, rest: 4.5 },
  { outcome: "small", catchScale: .8, prepare: .9, cast: 1.5,
    waits: [["calm", 3.4], ["check", 1.1], ["nibble", 1.4]],
    bite: 1.1, reel: 2.6, catch: 2.2, pack: 2, rest: 2.7 },
];
const stages: FishingStage[] = [];
const catches: number[] = [], packed: number[] = [];
let duration = 0;
for (const cast of casts) {
  const add = (action: FishingAction, seconds: number, variation: FishingMotion["variation"] = "calm") => {
    if (action === "catch") catches.push(duration);
    if (action === "pack") packed.push(duration + seconds * FISHING_PACK_RELEASE);
    stages.push({ action, seconds, variation, outcome: cast.outcome, catchScale: cast.catchScale, start: duration, end: duration + seconds });
    duration += seconds;
  };
  add("idle", cast.prepare, "check"); add("cast", cast.cast);
  for (const [variation, seconds] of cast.waits) add("fish", seconds, variation);
  add("bite", cast.bite, cast.outcome === "large" ? "struggle" : "nibble");
  add("reel", cast.reel, cast.outcome === "miss" ? "escape" : cast.outcome === "large" ? "struggle" : "calm");
  if (cast.catch && cast.pack) { add("catch", cast.catch); add("pack", cast.pack); }
  add("rest", cast.rest, cast.outcome === "miss" ? "escape" : "calm");
}
export const FOREST_FISHING_CYCLE_SECONDS = duration;
export const FOREST_FISHING_FIRST_CATCH_SECONDS = catches[0];
const clock = (elapsed: number) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.isFinite(elapsed) ? elapsed : 0));

/** Decorative catches only. Both counts use completed visible events, allowing
 * interrupted trips to carry earlier fish without inventing a failed catch. */
export function forestFishingCatchState(elapsed: number): { caught: number; packed: number } {
  const time = clock(elapsed), loops = Math.floor(time / duration), age = time % duration;
  return { caught: loops * catches.length + catches.filter(at => age + 1e-9 >= at).length,
    packed: loops * packed.length + packed.filter(at => age + 1e-9 >= at).length };
}

/** Four deterministic casts differ in patience, line checks, false nibbles,
 * failure and catch size. Scene time owns all motion; sampling has no RNG,
 * inventory, server reward or wall-clock side effect. */
export function fishingActionFrame(elapsed: number, still = false): Pick<ForestFishingFrame,
  "action" | "phase" | "frame" | "carryingFish" | "basketFilled" | keyof FishingMotion> {
  if (still) return { action: "fish", phase: .3, frame: 0, carryingFish: false, basketFilled: false,
    variation: "calm", outcome: "small", catchScale: 1 };
  const time = clock(elapsed), age = time % duration;
  const stage = stages.find(item => age < item.end) ?? stages[0];
  const local = Math.max(0, age - stage.start), stock = forestFishingCatchState(time);
  return { action: stage.action, phase: local / stage.seconds, frame: Math.floor(local * 4) % 4,
    carryingFish: stock.caught > 0, basketFilled: stock.packed > 0,
    variation: stage.variation, outcome: stage.outcome, catchScale: stage.catchScale };
}

export function fishingDirection(base: WorldPoint, water?: WorldPoint): PixelDirection {
  if (!water) return "front";
  const dx = water.x - base.x, dy = water.y - base.y;
  return Math.abs(dx) >= Math.abs(dy) ? dx < 0 ? "left" : "right" : dy < 0 ? "back" : "front";
}
