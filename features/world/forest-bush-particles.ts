import type { WorldBounds, WorldBush, WorldPoint } from "./tiled/types";

export type ForestBushBurst = { at: number; strength: number; seed: number };
export type ForestBushParticle = {
  kind: "berry" | "leaf";
  x: number; y: number; groundY: number;
  radius: number; rotation: number; opacity: number; color: number;
};
type BushGeometry = { bounds: WorldBounds; anchors: WorldPoint[] };
const geometry = new WeakMap<WorldBush, BushGeometry | null>();
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const fade = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
export const FOREST_BUSH_PARTICLE_SECONDS = 3;

function inside(point: WorldPoint, points: readonly WorldPoint[]) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

/** Authored contour is immutable within one scene; its crown is sampled only once. */
function geometryFor(bush: WorldBush) {
  if (geometry.has(bush)) return geometry.get(bush)!;
  if (bush.points.length < 3 || !bush.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) {
    geometry.set(bush, null); return null;
  }
  const xs = bush.points.map(point => point.x), ys = bush.points.map(point => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  const bounds = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  if (bounds.width <= 0 || bounds.height <= 0) { geometry.set(bush, null); return null; }
  const anchors: WorldPoint[] = [], margin = Math.min(bounds.width, bounds.height) * .045;
  for (let row = 0; row < 7; row++) {
    for (let column = 0; column < 11; column++) {
      const point = { x: x + bounds.width * (.16 + column * .068), y: y + bounds.height * (.25 + row * .045) };
      if ([[0, 0], [-margin, 0], [margin, 0], [0, -margin], [0, margin]].every(([dx, dy]) =>
        inside({ x: point.x + dx, y: point.y + dy }, bush.points))) anchors.push(point);
    }
  }
  const result = { bounds, anchors }; geometry.set(bush, result); return result;
}

export function forestBushBounds(bush: WorldBush) { return geometryFor(bush)?.bounds ?? null; }

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A berry follows one arc, two diminishing bounces, then a short frictional roll. */
function berryPosition(origin: WorldPoint, floor: number, vx: number, vy: number, gravity: number, time: number) {
  const impactAt = (-vy + Math.sqrt(vy * vy + 2 * gravity * (floor - origin.y))) / gravity;
  if (time <= impactAt) return { x: origin.x + vx * time, y: origin.y + vy * time + gravity * time * time / 2 };
  let x = origin.x + vx * impactAt, remaining = time - impactAt;
  let bounce = (vy + gravity * impactAt) * .24, speed = vx * .55;
  for (let index = 0; index < 2; index++) {
    const duration = 2 * bounce / gravity;
    if (remaining <= duration) return { x: x + speed * remaining, y: floor - bounce * remaining + gravity * remaining * remaining / 2 };
    x += speed * duration; remaining -= duration; bounce *= .25; speed *= .48;
  }
  return { x: x + speed * (1 - Math.exp(-remaining * 7)) / 7, y: floor };
}

/** No emitters/timers: both cameras sample the same finite, deterministic encounter events. */
export function forestBushParticles(bush: WorldBush, elapsed: number, bursts: readonly ForestBushBurst[]): ForestBushParticle[] {
  if (!Number.isFinite(elapsed)) return [];
  const shape = geometryFor(bush);
  if (!shape?.anchors.length) return [];
  const { bounds, anchors } = shape, unit = Math.min(bounds.width, bounds.height), particles: ForestBushParticle[] = [];
  // A controller emits at most four events; cap defensive/manual frames as well.
  for (const burst of bursts.slice(-4)) {
    const age = elapsed - burst.at;
    if (!Number.isFinite(age) || age < 0 || age >= FOREST_BUSH_PARTICLE_SECONDS
      || !Number.isFinite(burst.strength) || burst.strength <= 0) continue;
    const strength = clamp(burst.strength), rng = random(burst.seed);
    const berries = strength > .78 ? 3 : 2, leaves = strength > .86 ? 1 : 0;
    for (let index = 0; index < berries + leaves; index++) {
      const leaf = index >= berries, origin = anchors[Math.floor(rng() * anchors.length)];
      const delay = index * .045 + rng() * .04, time = age - delay;
      const floor = bounds.y + bounds.height + unit * (.025 + rng() * .085);
      const side = origin.x < bounds.x + bounds.width / 2 ? -1 : 1;
      const vx = unit * side * (.05 + rng() * .12) * (.6 + strength * .4);
      const vy = -unit * (.13 + rng() * .16), gravity = unit * 1.9;
      const radius = leaf ? Math.min(2.1, Math.max(.85, unit * .026)) : Math.min(1.5, Math.max(.6, unit * (.014 + rng() * .005)));
      const phase = rng() * Math.PI * 2, color = Math.floor(rng() * 3);
      if (time < 0) continue;
      let point: WorldPoint;
      if (leaf) {
        const falling = clamp(time / 1.7), travel = falling * falling * (3 - 2 * falling);
        point = { x: origin.x + vx * falling + Math.sin(falling * 13 + phase) * unit * .052 * Math.sin(falling * Math.PI),
          y: origin.y + (floor - origin.y) * travel - Math.sin(falling * Math.PI) * unit * .06 };
      } else point = berryPosition(origin, floor, vx, vy, gravity, time);
      particles.push({ kind: leaf ? "leaf" : "berry", ...point, groundY: floor, radius,
        rotation: leaf ? Math.sin(Math.min(time, 1.7) * 7 + phase) * .85 + side * .3 : phase + Math.min(time, 1.8) * side * 5,
        opacity: 1 - fade((age - 2.3) / .7), color });
    }
  }
  return particles;
}
