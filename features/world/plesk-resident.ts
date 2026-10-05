import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { FISHING_PACK_RELEASE, type FishingMotion } from "./fishing-props";
import { fishingWaterTarget } from "./forest-fishing";
import { FISH_SPECIES_IDS, type FishSpeciesId } from "./fish-species";
import { forestDestinations, type ForestTrail } from "./forest-trails";
import { createWorldNavigation, findWorldPath, type WorldNavigation } from "./navigation";
import { prepareSteeringPath } from "./steering";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export type PleskAction = "walk" | "idle" | "cast" | "fish" | "bite" | "reel" | "catch" | "pack" | "trade" | "rest" | "greet";
export type PleskResidentFrame = WorldPoint & FishingMotion & {
  id: "plesk";
  size: number;
  direction: PixelDirection;
  action: PleskAction;
  /** Progress through this action, independent of the sprite's animation frame. */
  phase: number;
  frame: number;
  destinationId: string;
  carryingFish: boolean;
  /** Fish already deposited, separate from the catch held in the paws. */
  basketFilled?: boolean;
  wildlife?: boolean;
  waterTarget?: WorldPoint;
};

export const PLESK = {
  id: "plesk", name: "Плёска", title: "Рыбачка и торговка", size: 36, speed: 16,
  fishingDestination: "plesk-fishing", tradingDestination: "plesk-trade", restingDestination: "plesk-rest",
} as const;
export const PLESK_LIMITS = { pathSearches: 3, routineVariants: 3 } as const;

export type PleskStop = { id: string; position: WorldPoint };
type Stop = PleskStop;
type Stage = FishingMotion & {
  action: PleskAction; start: number; end: number; destination: Stop;
  carryingFish: boolean; basketFilled?: boolean; direction: PixelDirection; trail?: ForestTrail;
};
type Routine = { base: Stop; waterTarget?: WorldPoint; stages: Stage[]; duration: number; direction: PixelDirection };
const cache = new WeakMap<FixedWorldScene, Routine | null>();
const facing = (dx: number, dy: number): PixelDirection => Math.abs(dx) > Math.abs(dy)
  ? dx > 0 ? "right" : "left" : dy > 0 ? "front" : "back";

export function measurePleskTrail(points: readonly WorldPoint[]): ForestTrail {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  return { id: "plesk-local-route", points, distances, length: distances.at(-1)! };
}

/** Residents own personal markers. Shared fishing/home belong to the hero;
 * deleting or blocking a resident marker never silently moves him there. */
function authoredStop(scene: FixedWorldScene, id: string): Stop | undefined {
  const marker = forestDestinations(scene).get(id);
  return marker ? { id, position: { ...marker.position } } : undefined;
}

function connectingTrail(nav: WorldNavigation, from: Stop, to: Stop | undefined): ForestTrail | undefined {
  if (!to || Math.hypot(to.position.x - from.position.x, to.position.y - from.position.y) < PLESK.size * .35) return;
  const points = findWorldPath(nav, from.position, to.position);
  if (!points || points.length < 2) return;
  const rounded = prepareSteeringPath(nav, points, PLESK.size);
  return rounded && rounded.length > 1 ? measurePleskTrail(rounded.points) : undefined;
}
export const reversePleskTrail = (trail: ForestTrail) => measurePleskTrail([...trail.points].reverse());
function rampTime(trail: ForestTrail) { return Math.min(.7, trail.length / PLESK.speed); }
export function pleskTravelTime(trail: ForestTrail) { return trail.length / PLESK.speed + rampTime(trail); }

export type PleskPlaces = {
  base: PleskStop; trade?: PleskStop; rest?: PleskStop; nav: WorldNavigation;
  waterTarget?: WorldPoint; direction: PixelDirection;
  toTrade?: ForestTrail; toRest?: ForestTrail; tradeToRest?: ForestTrail;
};
const placeCache = new WeakMap<FixedWorldScene, PleskPlaces | null>();
/** One prepared personal territory is shared by live decisions and DEV playback. */
export function pleskLocalPlaces(scene: FixedWorldScene): PleskPlaces | null {
  if (placeCache.has(scene)) return placeCache.get(scene)!;
  const base = authoredStop(scene, PLESK.fishingDestination);
  const nav = base && createWorldNavigation(scene, (scene.actor?.size ?? 50) * .1);
  if (!base || !nav) { placeCache.set(scene, null); return null; }
  const waterTarget = fishingWaterTarget(scene, base.position, PLESK.size, "down");
  // Cast down from the pier into verified water, with her face toward the viewer.
  const direction: PixelDirection = "front";
  const trade = authoredStop(scene, PLESK.tradingDestination), rest = authoredStop(scene, PLESK.restingDestination);
  const toTrade = connectingTrail(nav, base, trade), toRest = connectingTrail(nav, base, rest);
  const tradeToRest = toTrade && toRest && trade ? connectingTrail(nav, trade, rest) : undefined;
  const result = { base, nav, waterTarget, direction, trade: toTrade ? trade : undefined,
    rest: toRest ? rest : undefined, toTrade, toRest, tradeToRest };
  placeCache.set(scene, result); return result;
}

/** Scene identity owns three local routine variants and at most three searches.
 * Short walks are real swept-footprint routes between the pier, trading spot
 * and tackle/rest spot. Sampling either camera never advances independent AI,
 * pathfinding, timers, inventory or account state. */
function routine(scene: FixedWorldScene): Routine | null {
  if (cache.has(scene)) return cache.get(scene)!;
  const places = pleskLocalPlaces(scene);
  if (!places) { cache.set(scene, null); return null; }
  const { base, waterTarget, direction, trade, rest, toTrade, toRest, tradeToRest } = places;
  const stages: Stage[] = []; let time = 0, fishIndex = 0;
  let species: FishSpeciesId = "fish", basketSpecies: FishSpeciesId | undefined;
  const stay = (action: PleskAction, seconds: number, carryingFish = false, destination = base, look = direction, basketFilled?: boolean) => {
    if (!carryingFish) basketSpecies = undefined;
    stages.push({ action, start: time, end: time + seconds, destination, carryingFish, basketFilled, direction: look, species, basketSpecies }); time += seconds;
  };
  const walk = (trail: ForestTrail, destination: Stop, carryingFish: boolean) => {
    const duration = pleskTravelTime(trail);
    if (!carryingFish) basketSpecies = undefined;
    stages.push({ action: "walk", start: time, end: time + duration, destination, carryingFish, direction, trail, species, basketSpecies }); time += duration;
  };
  const catchFish = (wait: number, carryingFish: boolean, escapedBite: boolean) => {
    species = FISH_SPECIES_IDS[fishIndex++ % FISH_SPECIES_IDS.length];
    stay("cast", 1.8, carryingFish); stay("fish", wait, carryingFish);
    if (escapedBite) { stay("bite", 1, carryingFish); stay("fish", 7, carryingFish); }
    stay("bite", 1.5, carryingFish); stay("reel", 3, carryingFish);
    stay("catch", 4, true, base, direction, carryingFish);
    stay("pack", 3, true, base, direction, carryingFish);
    basketSpecies = species;
  };
  for (let variant = 0; variant < PLESK_LIMITS.routineVariants; variant++) {
    stay("idle", 2);
    if (waterTarget) {
      catchFish(15 + variant * 4, false, variant === 2);
      stay("idle", 4, true);
      catchFish(19 + variant * 3, true, variant === 1);
      stay("greet", 3, true, base, "front");
      // A future distant market should not turn the fisherman into a courier.
      const trip = toTrade ? pleskTravelTime(toTrade) * 2 : 0;
      if (trip > 55) catchFish(trip - 35, true, false);
    } else {
      // Edited/disabled water leaves honest shore activities, never dry casting.
      stay("idle", 8); stay("rest", 12); stay("greet", 3, false, base, "front");
    }
    const loaded = Boolean(waterTarget);
    let atRest = false;
    if (trade && toTrade) {
      walk(toTrade, trade, loaded);
      stay("greet", 3, loaded, trade, "front"); stay("trade", 18 + variant * 4, loaded, trade, "front");
      stay("idle", 3, false, trade, "front"); stay("idle", 4, false, trade, variant === 1 ? "left" : "front");
      if (rest && tradeToRest) { walk(tradeToRest, rest, false); atRest = true; }
      else walk(reversePleskTrail(toTrade), base, false);
    }
    if (rest && toRest) {
      if (!atRest) walk(toRest, rest, trade && toTrade ? false : loaded);
      stay("rest", 12 + variant * 4, false, rest, "front");
      stay("idle", 4, false, rest, "front");
      stay("idle", 3, false, rest, variant === 2 ? "back" : "left");
      walk(reversePleskTrail(toRest), base, false);
    }
    stay("rest", 8);
  }
  const result = { base, waterTarget, stages, duration: time, direction };
  cache.set(scene, result); return result;
}

export function samplePleskTrail(trail: ForestTrail, age: number) {
  const ramp = rampTime(trail), duration = pleskTravelTime(trail);
  const distance = age < ramp ? PLESK.speed * age * age / (2 * ramp)
    : age > duration - ramp ? trail.length - PLESK.speed * (duration - age) ** 2 / (2 * ramp)
      : PLESK.speed * (age - ramp * .5);
  let low = 1, high = trail.points.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (trail.distances[mid] < distance) low = mid + 1; else high = mid; }
  const before = trail.points[low - 1], after = trail.points[low];
  const ratio = Math.max(0, Math.min(1, (distance - trail.distances[low - 1]) / (trail.distances[low] - trail.distances[low - 1] || 1)));
  return { x: before.x + (after.x - before.x) * ratio, y: before.y + (after.y - before.y) * ratio,
    direction: facing(after.x - before.x, after.y - before.y), frame: Math.floor(distance / (PLESK.size * .06)) % 8 };
}

/** DEV can play the exact shared routine rather than guess a camera-local loop. */
export function pleskRoutineDuration(scene: FixedWorldScene): number { return routine(scene)?.duration ?? 0; }

export function pleskResidentFrame(scene: FixedWorldScene, elapsed: number, still: boolean): PleskResidentFrame | null {
  const schedule = routine(scene); if (!schedule) return null;
  if (still) return { id: "plesk", ...schedule.base.position, size: PLESK.size, direction: schedule.direction,
    action: schedule.waterTarget ? "fish" : "rest", phase: .5, frame: 0, carryingFish: false,
    destinationId: schedule.base.id, ...(schedule.waterTarget ? { waterTarget: { ...schedule.waterTarget } } : {}) };
  const clock = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0), time = clock % schedule.duration;
  const stage = schedule.stages.find(candidate => time < candidate.end) ?? schedule.stages.at(-1)!;
  const age = Math.max(0, time - stage.start), phase = Math.min(1, age / (stage.end - stage.start));
  const position = stage.trail ? samplePleskTrail(stage.trail, age)
    : { ...stage.destination.position, direction: stage.direction, frame: Math.floor(age * 8) % 32 };
  return { id: "plesk", ...position, size: PLESK.size, action: stage.action, phase, destinationId: stage.destination.id,
    carryingFish: stage.carryingFish && (stage.action !== "pack" || phase < FISHING_PACK_RELEASE), species: stage.species,
    basketSpecies: stage.action === "pack" && stage.carryingFish && phase >= FISHING_PACK_RELEASE ? stage.species : stage.basketSpecies,
    basketFilled: stage.action === "pack"
      ? Boolean(stage.basketFilled || stage.carryingFish && phase >= FISHING_PACK_RELEASE)
      : stage.basketFilled ?? stage.carryingFish,
    ...(schedule.waterTarget && stage.destination.id === schedule.base.id && !stage.trail
      ? { waterTarget: { ...schedule.waterTarget } } : {}) };
}
