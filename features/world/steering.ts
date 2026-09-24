import { canTraverse, type WorldNavigation } from "./navigation";
import type { WorldPoint } from "./tiled/types";

export type SteeringPath = {
  points: WorldPoint[];
  distances: number[];
  length: number;
  /** Fractions of walking speed. The final zero requests a controlled arrival. */
  speedLimits: number[];
  roundedCorners: number;
  checks: number;
};

/** Preparation happens once per chosen path, never in the animation loop. */
export const WORLD_STEERING_LIMITS = { inputPoints: 256, points: 2_048, checks: 4_096,
  curveSegments: 48, shrinkAttempts: 5 } as const;
const EPS = 1e-7;
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(b.x - a.x, b.y - a.y);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (point: WorldPoint) => !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
const equal = (a: WorldPoint, b: WorldPoint) => a.x === b.x && a.y === b.y;
const lerp = (a: WorldPoint, b: WorldPoint, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function turn(a: WorldPoint, b: WorldPoint, c: WorldPoint) {
  const first = distance(a, b), second = distance(b, c);
  if (first <= EPS || second <= EPS) return 0;
  return Math.acos(clamp(((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (first * second), -1, 1));
}

/** Round only where the complete support disk fits. The executed geometry is the
 * checked polyline, not an unchecked spline evaluated later by the renderer. */
export function prepareSteeringPath(navigation: WorldNavigation, source: readonly WorldPoint[], size: number): SteeringPath | null {
  if (!Number.isFinite(size) || size <= 0 || !Array.isArray(source) || !source.length
    || source.length > WORLD_STEERING_LIMITS.inputPoints || !source.every(finite)) return null;
  const original: WorldPoint[] = [];
  for (const point of source) if (!original.length || !equal(original.at(-1)!, point)) original.push({ ...point });
  let checks = 0;
  const safe = (a: WorldPoint, b: WorldPoint) => ++checks <= WORLD_STEERING_LIMITS.checks && canTraverse(navigation, a, b);
  if (!safe(original[0], original[0])) return null;
  for (let i = 1; i < original.length; i++) if (!safe(original[i - 1], original[i])) return null;

  const points: WorldPoint[] = [{ ...original[0] }], sharp = new Map<WorldPoint, number>();
  let roundedCorners = 0;
  for (let i = 1; i < original.length - 1; i++) {
    const a = original[i - 1], corner = original[i], b = original[i + 1];
    const incoming = distance(a, corner), outgoing = distance(corner, b), angle = turn(a, corner, b);
    let trim = Math.min(size * .18, incoming * .35, outgoing * .35), rounded = false;
    // Near reversals have no useful forward tangent; retain and slow that corner.
    if (angle > .035 && angle < 2.7 && trim > EPS) {
      for (let attempt = 0; attempt < WORLD_STEERING_LIMITS.shrinkAttempts; attempt++, trim *= .5) {
        const count = Math.min(WORLD_STEERING_LIMITS.curveSegments,
          Math.max(8, Math.ceil(angle / .065), Math.ceil(trim * 2 / Math.max(.2, size * .035))));
        // Reserve room for the untouched remainder and its final safety pass.
        if (points.length + count + original.length - i > WORLD_STEERING_LIMITS.points
          || checks + count + 1 + points.length + count + original.length - i > WORLD_STEERING_LIMITS.checks) break;
        const entry = lerp(corner, a, trim / incoming), exit = lerp(corner, b, trim / outgoing);
        const curve = [entry];
        for (let sample = 1; sample <= count; sample++) {
          const t = sample / count;
          curve.push(sample === count ? exit : lerp(lerp(entry, corner, t), lerp(corner, exit, t), t));
        }
        let previous = points.at(-1)!, valid = true;
        for (const point of curve) {
          if (!safe(previous, point)) { valid = false; break; }
          previous = point;
        }
        if (!valid) continue;
        points.push(...curve); roundedCorners++; rounded = true; break;
      }
    }
    if (!rounded) {
      const point = { ...corner }; points.push(point);
      if (angle > .035) sharp.set(point, clamp(1 - .9 * Math.sin(angle / 2), .2, 1));
    }
  }
  if (original.length > 1) points.push({ ...original.at(-1)! });
  const distances = [0], speedLimits = points.map(() => 1);
  for (let i = 1; i < points.length; i++) {
    if (!safe(points[i - 1], points[i])) return null;
    distances.push(distances[i - 1] + distance(points[i - 1], points[i]));
    if (i < points.length - 1) {
      const angle = turn(points[i - 1], points[i], points[i + 1]);
      const span = (distance(points[i - 1], points[i]) + distance(points[i], points[i + 1])) / 2;
      const curvature = angle / Math.max(EPS, span);
      // Lateral acceleration v² * curvature is limited relative to actor size.
      speedLimits[i] = sharp.get(points[i]) ?? (curvature > EPS
        ? clamp(Math.sqrt(size * .32 / curvature) / (size * .36), .2, 1) : 1);
    }
  }
  speedLimits[speedLimits.length - 1] = 0;
  return { points, distances, length: distances.at(-1)!, speedLimits, roundedCorners, checks };
}

type SpeedEnvelope = { ratio: number; speedsSquared: number[] };
const envelopes = new WeakMap<SteeringPath, SpeedEnvelope>();

/** Profiles are immutable after their first speed query. Cache one conservative
 * braking envelope per path; ordinary frames use only a binary segment lookup.
 * A slower weather speed can brake earlier, never later than the physical limit. */
export function desiredSteeringSpeed(path: SteeringPath, travelled: number, maxSpeed: number, acceleration: number): number {
  if (!Number.isFinite(travelled) || !Number.isFinite(maxSpeed) || maxSpeed <= 0
    || !Number.isFinite(acceleration) || acceleration <= 0 || path.points.length < 2 || travelled >= path.length) return 0;
  const ratio = 2 * acceleration / (maxSpeed * maxSpeed);
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  const bucket = 2 ** Math.floor(Math.log2(ratio));
  let envelope = envelopes.get(path);
  if (!envelope || envelope.ratio !== bucket) {
    const speedsSquared = path.speedLimits.map(limit => clamp(limit, 0, 1) ** 2);
    for (let i = speedsSquared.length - 2; i >= 0; i--) {
      speedsSquared[i] = Math.min(speedsSquared[i], speedsSquared[i + 1] + bucket * (path.distances[i + 1] - path.distances[i]));
    }
    envelope = { ratio: bucket, speedsSquared }; envelopes.set(path, envelope);
  }
  const at = clamp(travelled, 0, path.length);
  let low = 1, high = path.distances.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (path.distances[middle] < at) low = middle + 1; else high = middle;
  }
  const before = low - 1, remaining = path.distances[low] - at;
  const length = path.distances[low] - path.distances[before];
  const t = length > EPS ? 1 - remaining / length : 1;
  // Final stopping uses the braking envelope, not linear interpolation to zero
  // over a potentially long last segment (which would crawl before arrival).
  const endCap = low === path.speedLimits.length - 1 ? 1 : path.speedLimits[low];
  const localCap = path.speedLimits[before] + (endCap - path.speedLimits[before]) * t;
  return maxSpeed * Math.sqrt(Math.max(0, Math.min(1, localCap * localCap,
    envelope.speedsSquared[low] + bucket * remaining)));
}
