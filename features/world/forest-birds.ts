import type { FixedWorldScene, WorldPoint } from "./tiled/types";
import type { ForestBird, ForestBirdState } from "./forest-wildlife";

export const FOREST_BIRD_FLIGHT_DURATION = 34;
export const FOREST_BIRD_LIMIT = 2;
const BIRD_PERIOD = 158;
const TAU = Math.PI * 2;
const VERIFIED_TERRAIN = "/world/prototype/forest-ground.webp?v=fedcfbd622df";

export type ForestBirdPerch = WorldPoint & { id: string; facing: -1 | 1 };
export type ForestBirdOptions = {
  /** Active shared world time; the caller pauses this clock for both cameras. */
  elapsed: number;
  dusk: number;
  rain: number;
  reducedMotion: boolean;
  birds?: "auto" | "on" | "off" | boolean;
  /** A single replayable visit, independent of the automatic world schedule. */
  birdElapsed?: number;
};

// Feet rest on visible crown/branch junctions, inspected on the versioned terrain.
// The clearing pair stays clear of the house; other crowns cover the wider forest.
const PERCHES: readonly ForestBirdPerch[] = [
  { id: "clearing-west-tree", x: 491, y: 657, facing: 1 },
  { id: "clearing-south-tree", x: 544, y: 697, facing: 1 },
  { id: "northwest-tree", x: 266, y: 107, facing: 1 },
  { id: "northeast-tree", x: 1093, y: 268, facing: -1 },
  { id: "west-tree", x: 156, y: 396, facing: 1 },
  { id: "east-tree", x: 1008, y: 406, facing: -1 },
  { id: "southwest-tree", x: 130, y: 955, facing: 1 },
  { id: "riverbank-tree", x: 1030, y: 657, facing: -1 },
];

const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const modulo = (value: number, period: number) => ((value % period) + period) % period;
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;

function sceneSeed(id: string) {
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  return seed >>> 0;
}

function noise(seed: number, index: number) {
  let value = (seed + Math.imul(index + 1, 0x9e3779b9)) | 0;
  value = Math.imul(value ^ value >>> 16, 0x21f0aaad);
  value = Math.imul(value ^ value >>> 15, 0x735a2d97);
  return ((value ^ value >>> 15) >>> 0) / 4294967296;
}

/** A changed image or geometry must never leave birds sitting on imaginary trees. */
export function forestBirdPerches(scene: FixedWorldScene): readonly ForestBirdPerch[] {
  const terrain = scene.terrain.find(layer => layer.id === "forest-ground");
  if (scene.id !== "forest" || scene.width !== 1254 || scene.height !== 1254
    || !terrain || terrain.image !== VERIFIED_TERRAIN
    || terrain.bounds.x !== 0 || terrain.bounds.y !== 0
    || terrain.bounds.width !== 1254 || terrain.bounds.height !== 1254) return [];
  return PERCHES.filter(perch => !scene.sites.some(({ bounds }) =>
    perch.x >= bounds.x - 12 && perch.x <= bounds.x + bounds.width + 12
    && perch.y >= bounds.y - 12 && perch.y <= bounds.y + bounds.height + 12));
}

function geometry(scene: FixedWorldScene) {
  const width = Math.max(1, finite(scene.width)), height = Math.max(1, finite(scene.height));
  const x = clamp(finite(scene.focus.x), 0, width - 1), y = clamp(finite(scene.focus.y), 0, height - 1);
  const focus = { x, y, width: clamp(finite(scene.focus.width), 1, width - x),
    height: clamp(finite(scene.focus.height), 1, height - y) };
  return { width, height, focus, scale: clamp(Math.min(focus.width, focus.height) / 256, .35, 2) };
}

function curve(a: WorldPoint, b: WorldPoint, c: WorldPoint, d: WorldPoint, t: number) {
  const q = 1 - t;
  const x = q * q * q * a.x + 3 * q * q * t * b.x + 3 * q * t * t * c.x + t * t * t * d.x;
  const y = q * q * q * a.y + 3 * q * q * t * b.y + 3 * q * t * t * c.y + t * t * t * d.y;
  const dx = 3 * q * q * (b.x - a.x) + 6 * q * t * (c.x - b.x) + 3 * t * t * (d.x - c.x);
  const dy = 3 * q * q * (b.y - a.y) + 6 * q * t * (c.y - b.y) + 3 * t * t * (d.y - c.y);
  return { x, y, angle: Math.atan2(dy, dx) };
}

function flightPose(seconds: number, index: number) {
  const phase = seconds * 10 + index * 1.7;
  const beating = smooth(.5 + Math.sin(seconds * 1.1 + index) * .8);
  return { phase, state: (beating < .08 ? "glide" : "flap") as ForestBirdState,
    wingLift: .45 + Math.sin(phase) * .5 * beating, wingFold: 0,
    headTurn: 0, tailFlick: Math.sin(seconds * 1.3) * .1, legReach: 0 };
}

function transit(from: WorldPoint, to: WorldPoint, t: number, bend: number) {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.max(1, Math.hypot(dx, dy));
  const arc = Math.sin(t * Math.PI) * bend, tangent = Math.cos(t * Math.PI) * Math.PI * bend;
  return { x: from.x + dx * t - dy / length * arc,
    y: from.y + dy * t + dx / length * arc,
    angle: Math.atan2(dy + dx / length * tangent, dx - dy / length * tangent) };
}

function perchVisit(perch: ForestBirdPerch, from: WorldPoint, to: WorldPoint,
  seconds: number, size: number, index: number): ForestBird {
  const arrival = 7 + index * .7, departure = 19.5 + index * .45;
  const seat = { x: perch.x, y: perch.y - size * 3.3 };
  const approachDirection = seat.x >= from.x ? 1 : -1;
  const outgoingDirection = to.x >= seat.x ? 1 : -1;
  const base = { size, opacity: .92, ...flightPose(seconds, index), perchId: perch.id };
  if (seconds < arrival) {
    const t = clamp(seconds / arrival), eased = 1 - Math.pow(1 - t, 1.8);
    const pose = curve(from, { x: from.x + approachDirection * 46, y: from.y - 45 },
      { x: seat.x - approachDirection * 36, y: seat.y - 26 }, seat, eased);
    const landing = smooth((seconds - arrival + 2.3) / 2.3);
    return { ...base, ...pose, state: seconds >= arrival - 2.3 ? "landing" : base.state,
      wingFold: smooth((seconds - arrival + .8) / .8), legReach: landing,
      // Level the body and flare the wings as the feet meet the leaves.
      bank: (1 - landing) * clamp(Math.atan2(Math.sin(pose.angle), Math.abs(Math.cos(pose.angle))), -.7, .7),
      wingLift: lerp(base.wingLift, .92, landing), facing: approachDirection };
  }
  if (seconds < departure) {
    const local = seconds - arrival;
    const peek = Math.sin(smooth((local - 1.1) / 1.8) * TAU) * .65;
    const preen = smooth((local - 4.1) / .45) * (1 - smooth((local - 6.3) / .5));
    const hopProgress = clamp((local - 8.3) / .7), hop = Math.sin(hopProgress * Math.PI);
    const tailFlick = Math.sin(clamp((local - 2.5) / .55) * TAU) * .7
      + Math.sin(clamp((local - 7.1) / .55) * TAU) * .8;
    return { ...base, x: seat.x + hop * size * 1.8, y: seat.y - hop * size * 3.1,
      angle: approachDirection > 0 ? 0 : Math.PI, facing: approachDirection, bank: 0,
      state: preen > .05 ? "preen" : hop > .01 ? "hop" : "perched",
      wingFold: 1 - preen * .08, wingLift: .35, legReach: 1 - hop * .6,
      headTurn: peek - preen * .95, tailFlick, preen };
  }
  const local = seconds - departure, duration = FOREST_BIRD_FLIGHT_DURATION - departure;
  const t = clamp(local / duration);
  // Zero departure speed gives a visible push from the branch, then acceleration.
  const pose = curve(seat, seat, { x: seat.x + (to.x - seat.x) * .28,
    y: seat.y - 130 }, to, t);
  const unfold = smooth(local / .55);
  return { ...base, ...pose, state: local < 2.4 ? "takeoff" : base.state,
    wingFold: 1 - unfold, legReach: 1 - smooth(local / 1.1),
    wingLift: lerp(.35, .45 + Math.sin(local * 14) * .5, smooth(local / .4)) * (1 - smooth((local - 2.1) / .3))
      + base.wingLift * smooth((local - 2.1) / .3),
    facing: outgoingDirection,
    bank: smooth(local / .7) * clamp(Math.atan2(Math.sin(pose.angle), Math.abs(Math.cos(pose.angle))), -.7, .7) };
}

/** Pure world-coordinate birds: camera changes, replays and render order cannot consume state. */
export function forestBirdFrame(scene: FixedWorldScene, options: ForestBirdOptions): ForestBird[] {
  if (options.reducedMotion || options.birds === "off" || options.birds === false) return [];
  const forced = options.birdElapsed !== undefined || options.birds === "on" || options.birds === true;
  const visibility = forced ? 1 : clamp((1 - finite(options.dusk)) * (1 - finite(options.rain) * 1.8));
  if (visibility <= .05) return [];
  const { width, height, focus, scale } = geometry(scene), seed = sceneSeed(scene.id);
  const seconds = Math.max(0, finite(options.elapsed)), margin = scale * 16;
  const clock = seconds + noise(seed, 210) * BIRD_PERIOD;
  const cycle = forced ? 0 : Math.floor(clock / BIRD_PERIOD);
  const local = forced ? options.birdElapsed ?? modulo(seconds, FOREST_BIRD_FLIGHT_DURATION + 5) : modulo(clock, BIRD_PERIOD);
  if (!Number.isFinite(local) || local < 0 || local >= FOREST_BIRD_FLIGHT_DURATION) return [];
  const count = forced || noise(seed, cycle + 310) > .65 ? FOREST_BIRD_LIMIT : 1;
  const perches = forestBirdPerches(scene);
  const center = { x: focus.x + focus.width * .5, y: focus.y + focus.height * .38 };
  const nearest = [...perches].sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y));
  const usePerches = perches.length > 0 && (forced || cycle % 2 === 0);
  const reverse = noise(seed, cycle + 211) > .5;
  const lane = .14 + noise(seed, cycle + 410) * .72, corridor = modulo(cycle, 3);
  const birds: ForestBird[] = [];
  for (let i = 0; i < count; i++) {
    let from: WorldPoint, to: WorldPoint;
    if (forced) {
      from = { x: center.x - i * scale * 10, y: center.y + i * scale * 8 };
      to = { x: center.x < width / 2 ? width + margin : -margin,
        y: clamp(center.y + (noise(seed, 212) - .5) * height * .6 + i * scale * 8, height * .08, height * .92) };
    } else {
      if (corridor === 0) { from = { x: -margin, y: height * lane }; to = { x: width + margin, y: height * clamp(lane + .16, .12, .88) }; }
      else if (corridor === 1) { from = { x: width * lane, y: -margin }; to = { x: width * clamp(lane - .16, .12, .88), y: height + margin }; }
      else { from = { x: -margin, y: height * .12 }; to = { x: width + margin, y: height * .88 }; }
      if (reverse) [from, to] = [to, from];
    }
    let bird: ForestBird;
    if (usePerches) {
      const perch = forced ? nearest[i % nearest.length] : perches[(Math.floor(cycle / 2) * 3 + i) % perches.length];
      bird = perchVisit(perch, from, to, local, scale * 1.5, i);
    } else {
      const progress = (local - (forced ? 0 : i * .65)) / (FOREST_BIRD_FLIGHT_DURATION - (forced ? 0 : i * .65));
      if (progress < 0) continue;
      bird = { ...transit(from, to, progress, Math.min(width, height) * .06),
        ...flightPose(local, i), size: scale * 1.5, opacity: .92 };
    }
    if (bird.x >= 0 && bird.y >= 0 && bird.x <= width && bird.y <= height)
      birds.push({ ...bird, opacity: bird.opacity * visibility });
  }
  return birds;
}
