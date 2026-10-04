import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { forestDestinations, forestTrailDestination, type ForestTrail } from "./forest-trails";
import { isForestWater } from "./forest-water";
import { canTraverse, createWorldNavigation, findWorldPath, isWalkable, type WorldNavigation } from "./navigation";
import { prepareSteeringPath } from "./steering";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export type PleskAction = "walk" | "idle" | "cast" | "fish" | "bite" | "reel" | "catch" | "pack" | "trade" | "rest" | "greet";
export type PleskResidentFrame = WorldPoint & {
  id: "plesk";
  size: number;
  direction: PixelDirection;
  action: PleskAction;
  /** Progress through this action, independent of the sprite's animation frame. */
  phase: number;
  frame: number;
  destinationId: string;
  carryingFish: boolean;
  waterTarget?: WorldPoint;
};

export const PLESK = {
  id: "plesk", name: "Плёск", title: "Рыбак и торговец", size: 36, speed: 16,
  fishingDestination: "plesk-fishing", tradingDestination: "plesk-trade",
} as const;
export const PLESK_LIMITS = { waterRings: 13, waterDirections: 48, waterPolygons: 256, waterEdges: 20_000,
  homeWaitingCandidates: 16, pathSearches: 2 } as const;

type Stop = { id: string; position: WorldPoint };
type Stage = {
  action: PleskAction; start: number; end: number; destination: Stop;
  carryingFish: boolean; direction: PixelDirection; trail?: ForestTrail;
};
type Routine = { base: Stop; waterTarget?: WorldPoint; stages: Stage[]; duration: number; direction: PixelDirection };
const cache = new WeakMap<FixedWorldScene, Routine | null>();
const facing = (dx: number, dy: number): PixelDirection => Math.abs(dx) > Math.abs(dy)
  ? dx > 0 ? "right" : "left" : dy > 0 ? "front" : "back";

function measuredTrail(points: readonly WorldPoint[]): ForestTrail {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  return { id: "plesk-trade", points, distances, length: distances.at(-1)! };
}

/** A small, fixed search chooses water, never an invented pond or an authored
 * exclusion such as a dock/leaf. The float and its widest ripple must fit. */
function fishingWater(scene: FixedWorldScene, base: WorldPoint): WorldPoint | undefined {
  if (!scene.water || !Array.isArray(scene.water.surfaces) || !Array.isArray(scene.water.exclusions) || !scene.water.surfaces.length
    || scene.water.surfaces.length + scene.water.exclusions.length > PLESK_LIMITS.waterPolygons) return;
  const polygons = [...scene.water.surfaces, ...scene.water.exclusions]; let edgesCount = 0;
  for (const polygon of polygons) {
    if (!polygon || !Array.isArray(polygon.points) || polygon.points.length < 3
      || (edgesCount += polygon.points.length) > PLESK_LIMITS.waterEdges
      || !polygon.points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) return;
  }
  const clearance = PLESK.size * .25, start = PLESK.size * .65, step = PLESK.size * .13;
  const edges = polygons.flatMap(polygon => polygon.points.map((a, index) =>
    ({ a, b: polygon.points[(index + 1) % polygon.points.length] })));
  for (let ring = 0; ring < PLESK_LIMITS.waterRings; ring++) {
    const radius = start + ring * step;
    for (let sample = 0; sample < PLESK_LIMITS.waterDirections; sample++) {
      const angle = Math.PI * (.25 + sample * 2 / PLESK_LIMITS.waterDirections);
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

function authoredStop(scene: FixedWorldScene, preferred: string, fallback: readonly string[]): Stop[] {
  const destinations = forestDestinations(scene);
  // An explicitly authored but invalid personal marker fails closed. Moving it
  // into a wall must not silently send the character back to the shared marker.
  const ids = Array.isArray(scene.destinations) && scene.destinations.some(item => item?.id === preferred) ? [preferred] : fallback;
  return ids.flatMap(id => {
    const position = scene.destinations === undefined ? forestTrailDestination(scene, id) : destinations.get(id)?.position;
    return position ? [{ id, position: { ...position } }] : [];
  });
}

/** The shared home marker may be the main hero's spawn. Only this generic
 * fallback receives a nearby waiting place: exact personal plesk-trade markers
 * and forestDestinations stay untouched. Both trips use the chosen position. */
function tradingStop(scene: FixedWorldScene, nav: WorldNavigation, stop: Stop): Stop | null {
  const hero = scene.actor;
  if (stop.id !== "home" || !hero) return stop;
  const separation = (hero.size + PLESK.size) * .6;
  if (Math.hypot(stop.position.x - hero.spawn.x, stop.position.y - hero.spawn.y) >= separation) return stop;
  // Prefer open ground below/right, then below/left, before the other sides.
  const angles = [2, 6, 4, 0, 8, 14, 10, 12, 1, 3, 5, 7, 9, 11, 13, 15];
  for (const eighths of angles.slice(0, PLESK_LIMITS.homeWaitingCandidates)) {
    const angle = eighths * Math.PI / 8;
    const position = { x: stop.position.x + Math.cos(angle) * separation, y: stop.position.y + Math.sin(angle) * separation };
    if (Math.hypot(position.x - hero.spawn.x, position.y - hero.spawn.y) < separation - 1e-7
      || !isWalkable(nav, position) || !canTraverse(nav, stop.position, position)) continue;
    return { ...stop, position };
  }
  // A cramped porch does not justify an overlap or a jump across an obstacle;
  // the caller can still try the next ordinary destination (workshop).
  return null;
}

function rampTime(trail: ForestTrail) { return Math.min(.7, trail.length / PLESK.speed); }
function travelTime(trail: ForestTrail) { return trail.length / PLESK.speed + rampTime(trail); }

/** Scene identity owns the entire schedule and at most two searches. Sampling
 * either camera neither advances state nor performs pathfinding. No inventory,
 * timers, persistence or account state belong to this ambient resident. */
function routine(scene: FixedWorldScene): Routine | null {
  if (cache.has(scene)) return cache.get(scene)!;
  const base = authoredStop(scene, PLESK.fishingDestination, ["fishing"])[0];
  const nav = base && createWorldNavigation(scene, (scene.actor?.size ?? 50) * .1);
  if (!base || !nav) { cache.set(scene, null); return null; }
  const waterTarget = fishingWater(scene, base.position);
  const direction: PixelDirection = waterTarget ? facing(waterTarget.x - base.position.x, waterTarget.y - base.position.y) : "front";
  let trade: { stop: Stop; outward: ForestTrail; homeward: ForestTrail } | undefined;
  if (waterTarget) for (const marker of authoredStop(scene, PLESK.tradingDestination, ["home", "workshop"]).slice(0, PLESK_LIMITS.pathSearches)) {
    const stop = tradingStop(scene, nav, marker); if (!stop) continue;
    if (Math.hypot(stop.position.x - base.position.x, stop.position.y - base.position.y) <= PLESK.size) continue;
    const points = findWorldPath(nav, base.position, stop.position);
    if (!points || points.length < 2) continue;
    const rounded = prepareSteeringPath(nav, points, PLESK.size);
    if (!rounded || rounded.length <= 1) continue;
    trade = { stop, outward: measuredTrail(rounded.points), homeward: measuredTrail([...rounded.points].reverse()) }; break;
  }
  const stages: Stage[] = []; let time = 0;
  const stay = (action: PleskAction, seconds: number, carryingFish = false, destination = base, look = direction) => {
    stages.push({ action, start: time, end: time + seconds, destination, carryingFish, direction: look }); time += seconds;
  };
  const walk = (trail: ForestTrail, destination: Stop, carryingFish: boolean) => {
    const duration = travelTime(trail);
    stages.push({ action: "walk", start: time, end: time + duration, destination, carryingFish, direction, trail }); time += duration;
  };
  if (waterTarget) {
    stay("pack", 2); stay("cast", 1.8); stay("fish", 15); stay("bite", 1.5); stay("reel", 3);
    stay("catch", 4, true); stay("pack", 3, true); stay("idle", 4, true);
    // A timid nibble escapes: he waits a little, then catches the next fish.
    stay("cast", 1.8, true); stay("fish", 19, true); stay("bite", 1, true); stay("fish", 8, true);
    stay("bite", 1.5, true); stay("reel", 3.5, true); stay("catch", 4, true); stay("pack", 3, true);
    stay("rest", 12, true); stay("greet", 3, true, base, "front");
    // Longer trips mean a longer final wait: his main occupation stays fishing
    // even when a future map places the market farther from the river.
    const extraWait = trade ? Math.max(0, travelTime(trade.outward) * 2 + 32 - time) : 0;
    stay("cast", 1.8, true); stay("fish", 17 + extraWait, true); stay("bite", 1.4, true);
    stay("reel", 3, true); stay("catch", 3.2, true); stay("pack", 3, true);
    if (trade) {
      walk(trade.outward, trade.stop, true);
      stay("greet", 3, true, trade.stop, "front"); stay("trade", 20, true, trade.stop, "front");
      stay("pack", 3, false, trade.stop, "front"); stay("idle", 4, false, trade.stop, "front");
      walk(trade.homeward, base, false);
    }
    stay("rest", 8);
  } else {
    // A moved shoreline/disabled Water never leaves a float on dry land.
    stay("idle", 8); stay("pack", 4); stay("rest", 16); stay("greet", 3, false, base, "front");
  }
  const result = { base, waterTarget, stages, duration: time, direction };
  cache.set(scene, result); return result;
}

function walkingFrame(stage: Stage, age: number) {
  const trail = stage.trail!, ramp = rampTime(trail), duration = stage.end - stage.start;
  const distance = age < ramp ? PLESK.speed * age * age / (2 * ramp)
    : age > duration - ramp ? trail.length - PLESK.speed * (duration - age) ** 2 / (2 * ramp)
      : PLESK.speed * (age - ramp * .5);
  let low = 1, high = trail.points.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (trail.distances[mid] < distance) low = mid + 1; else high = mid; }
  const before = trail.points[low - 1], after = trail.points[low];
  const ratio = Math.max(0, Math.min(1, (distance - trail.distances[low - 1]) / (trail.distances[low] - trail.distances[low - 1] || 1)));
  return { x: before.x + (after.x - before.x) * ratio, y: before.y + (after.y - before.y) * ratio,
    direction: facing(after.x - before.x, after.y - before.y), frame: Math.floor(distance / (PLESK.size * .1)) % 4 };
}

export function pleskResidentFrame(scene: FixedWorldScene, elapsed: number, still: boolean): PleskResidentFrame | null {
  const schedule = routine(scene); if (!schedule) return null;
  if (still) return { id: "plesk", ...schedule.base.position, size: PLESK.size, direction: schedule.direction,
    action: schedule.waterTarget ? "fish" : "rest", phase: .5, frame: 0, carryingFish: false,
    destinationId: schedule.base.id, ...(schedule.waterTarget ? { waterTarget: { ...schedule.waterTarget } } : {}) };
  const clock = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0), time = clock % schedule.duration;
  const stage = schedule.stages.find(candidate => time < candidate.end) ?? schedule.stages.at(-1)!;
  const age = Math.max(0, time - stage.start), phase = Math.min(1, age / (stage.end - stage.start));
  const position = stage.trail ? walkingFrame(stage, age)
    : { ...stage.destination.position, direction: stage.direction, frame: Math.floor(age * (stage.action === "rest" ? 1 : 4)) % 4 };
  return { id: "plesk", ...position, size: PLESK.size, action: stage.action, phase, destinationId: stage.destination.id,
    carryingFish: stage.carryingFish,
    ...(schedule.waterTarget && stage.destination.id === schedule.base.id && !stage.trail
      ? { waterTarget: { ...schedule.waterTarget } } : {}) };
}
