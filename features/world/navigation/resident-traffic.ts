import { canTraverse, findWorldPath, isWalkable, withWorldNavigationObstacle, type WorldNavigation } from "./navigation";
import type { WorldPoint } from "@/features/world/tiled/types";

/** Transient visible feet, never an economic reservation or a saved coordinate. */
export type ResidentOccupant = {
  readonly id: string; readonly position: WorldPoint; readonly size: number; readonly moving?: boolean;
  /** A short forward corridor, detached from the route owner's state. */
  readonly intent?: ResidentRouteIntent;
};
export type ResidentRouteIntent = { readonly points: readonly WorldPoint[]; readonly target: WorldPoint; readonly priority: number };
export const RESIDENT_TRAFFIC_LIMITS = { clearanceRatio: .28, occupants: 8, retry: .8, priorityWait: .35,
  searches: 4, polygonSides: 12, intentPoints: 16, lookAheadRatio: 2.5 } as const;
const finite = (point: WorldPoint) => Number.isFinite(point?.x) && Number.isFinite(point?.y);
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const EPS = 1e-7;

/** Larger than navigation's ground support: neighbours need room for their bodies. */
export function residentClearance(size: number, otherSize: number): number {
  return (size + otherSize) * RESIDENT_TRAFFIC_LIMITS.clearanceRatio;
}
function neighbours(occupants: readonly ResidentOccupant[] | undefined, selfId: string) {
  return (occupants ?? []).slice(0, RESIDENT_TRAFFIC_LIMITS.occupants)
    .filter(other => other.id !== selfId && finite(other.position) && Number.isFinite(other.size) && other.size > 0);
}
function segmentDistance(point: WorldPoint, from: WorldPoint, to: WorldPoint) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy || 1)));
  return distance(point, { x: from.x + dx * t, y: from.y + dy * t });
}

/** Publish intent, not only velocity: a stopped walker still needs his held
 * destination. Bound snapshots independently of the length of the world route. */
export function residentRouteIntent(route: { points: readonly WorldPoint[]; distances: readonly number[] },
  from: WorldPoint, progress: number, size: number, priority: number, returning = false): ResidentRouteIntent | undefined {
  const target = returning ? route.points[0] : route.points.at(-1);
  if (!target || !finite(from) || !finite(target)) return;
  const points = [{ ...from }], budget = size * RESIDENT_TRAFFIC_LIMITS.lookAheadRatio;
  let remaining = budget, low = 0, high = route.distances.length;
  while (low < high) { const middle = (low + high) >> 1; if (route.distances[middle] <= progress + EPS) low = middle + 1; else high = middle; }
  let index = returning ? low - 1 : low;
  for (; index >= 0 && index < route.points.length && points.length < RESIDENT_TRAFFIC_LIMITS.intentPoints; index += returning ? -1 : 1) {
    const next = route.points[index], previous = points.at(-1)!, length = distance(previous, next);
    if (length <= EPS) continue;
    const ratio = Math.min(1, remaining / length);
    points.push({ x: previous.x + (next.x - previous.x) * ratio, y: previous.y + (next.y - previous.y) * ratio });
    remaining -= length;
    if (remaining <= EPS) break;
  }
  return points.length > 1 ? { points, target: { ...target }, priority } : undefined;
}

/** A yielding stop must clear both the approach and the exact held goal. */
export function residentPassageClear(position: WorldPoint, size: number, other: ResidentOccupant, margin = 0): boolean {
  const intent = other.intent;
  if (!intent) return true;
  const gap = residentClearance(size, other.size) + margin;
  return distance(position, intent.target) >= gap && intent.points.every((point, index) => !index
    || segmentDistance(position, intent.points[index - 1], point) >= gap);
}

/** Higher-value work gets the passage; equal priorities have one stable winner.
 * Nobody acquires permission to step through occupied feet. */
export function residentRequestingPassage(position: WorldPoint, size: number, occupants: readonly ResidentOccupant[] | undefined,
  selfId: string, priority: number): ResidentOccupant | undefined {
  return neighbours(occupants, selfId).filter(other => other.moving && other.intent
    && (other.intent.priority > priority || other.intent.priority === priority && other.id < selfId)
    && distance(position, other.position) <= residentClearance(size, other.size) * 2.4
    && !residentPassageClear(position, size, other, 1))
    .sort((a, b) => b.intent!.priority - a.intent!.priority || a.id.localeCompare(b.id))[0];
}

/** Small deterministic candidate set, with no grid search. Prefer a side step
 * clear of the incoming corridor; retreat is useful where a narrow path widens. */
export function residentYieldPoint(navigation: WorldNavigation, from: WorldPoint, size: number,
  occupants: readonly ResidentOccupant[] | undefined, selfId: string, requester: ResidentOccupant): WorldPoint | null {
  const points = requester.intent?.points, next = points?.[1];
  if (!points || !next) return null;
  const heading = Math.atan2(next.y - points[0].y, next.x - points[0].x);
  const gap = residentClearance(size, requester.size), margin = Math.max(navigation.cellSize, size * .2);
  for (const radius of [gap + margin, (gap + margin) * 2, (gap + margin) * 3]) {
    for (const angle of [Math.PI / 2, -Math.PI / 2, Math.PI * .75, -Math.PI * .75, 0, Math.PI, Math.PI / 4, -Math.PI / 4]) {
      const point = { x: from.x + Math.cos(heading + angle) * radius, y: from.y + Math.sin(heading + angle) * radius };
      if (residentPassageClear(point, size, requester, margin)
        && canTraverse(navigation, from, point) && canTraverseResidents(from, point, size, occupants, selfId)) return point;
    }
  }
  return null;
}

/** Check the swept feet before committing route progress. An old overlap may
 * only shrink by moving monotonically away; it never permits walking through. */
export function canTraverseResidents(from: WorldPoint, to: WorldPoint, size: number,
  occupants: readonly ResidentOccupant[] | undefined, selfId: string): boolean {
  if (!finite(from) || !finite(to) || !Number.isFinite(size) || size <= 0) return false;
  return neighbours(occupants, selfId).every(other => {
    const gap = residentClearance(size, other.size), before = distance(from, other.position);
    if (before < gap - EPS) {
      const dx = to.x - from.x, dy = to.y - from.y;
      return distance(to, other.position) > before + EPS
        && (from.x - other.position.x) * dx + (from.y - other.position.y) * dy >= -EPS;
    }
    return segmentDistance(other.position, from, to) >= gap - EPS;
  });
}

type Attempt = { base: WorldNavigation; key: string; navigation: WorldNavigation | null; retryAt: number; waited: boolean };
const attempts = new WeakMap<object, Attempt>();
type DetourOptions = { owner: object; navigation: WorldNavigation; from: WorldPoint; target: WorldPoint; size: number;
  occupants: readonly ResidentOccupant[] | undefined; selfId: string; time: number };

/** Called only after a blocked walking step. One cached variant per mover and
 * a bounded retry rate; the shared scene grid and parked basket stay immutable. */
export function residentTrafficDetour(options: DetourOptions): WorldPoint[] | null {
  const { owner, navigation, from, target, size, occupants, selfId, time } = options;
  if (!finite(from) || !finite(target) || !Number.isFinite(time) || !Number.isFinite(size) || size <= 0) return null;
  const others = neighbours(occupants, selfId);
  if (!others.length) return findWorldPath(navigation, from, target);
  let previous = attempts.get(owner);
  // Even moving occupants cannot request a new grid every frame.
  if (previous?.base === navigation && time < previous.retryAt) return null;
  const key = `${size};${others.map(other => `${other.id}:${other.position.x}:${other.position.y}:${other.size}`).join(";")}`;
  if (!previous || previous.base !== navigation || previous.key !== key) {
    previous = { base: navigation, key, navigation: null, retryAt: time, waited: false };
    attempts.set(owner, previous);
  }
  previous.retryAt = time + RESIDENT_TRAFFIC_LIMITS.retry;
  // A deterministic winner initially holds its line; the other mover takes the
  // detour. Nobody is allowed through occupied feet, including the winner.
  if (!previous.waited && others.some(other => other.moving && selfId < other.id
    && distance(from, other.position) < residentClearance(size, other.size) * 1.6)) {
    previous.waited = true; previous.retryAt = time + RESIDENT_TRAFFIC_LIMITS.priorityWait; return null;
  }
  if (others.some(other => distance(target, other.position) < residentClearance(size, other.size))) return null;
  let dynamic = previous.navigation;
  if (!dynamic) {
    dynamic = navigation;
    for (const other of others) {
      const radius = Math.max(.5, residentClearance(size, other.size) - navigation.radius + .75)
        / Math.cos(Math.PI / RESIDENT_TRAFFIC_LIMITS.polygonSides);
      const polygon = Array.from({ length: RESIDENT_TRAFFIC_LIMITS.polygonSides }, (_, index) => {
        const angle = index * Math.PI * 2 / RESIDENT_TRAFFIC_LIMITS.polygonSides;
        return { x: other.position.x + Math.cos(angle) * radius, y: other.position.y + Math.sin(angle) * radius };
      });
      dynamic = withWorldNavigationObstacle(dynamic, polygon);
      if (!dynamic) return null;
    }
    previous.navigation = dynamic;
  }
  const safe = (points: WorldPoint[]) => points.every((point, index) => index === 0
    || canTraverse(navigation, points[index - 1], point)
      && canTraverseResidents(points[index - 1], point, size, occupants, selfId));
  if (isWalkable(dynamic, from)) {
    const path = findWorldPath(dynamic, from, target);
    return path && safe(path) ? path : null;
  }
  // Hydration or a newly visible neighbour can leave overlapping initial feet.
  // Escape along a checked ground segment, then join a normal safe detour.
  const gap = Math.max(...others.map(other => residentClearance(size, other.size))) + navigation.cellSize * 2;
  const heading = Math.atan2(target.y - from.y, target.x - from.x);
  let searches = 0;
  // Polygon padding may enclose otherwise separated feet beside a river or a
  // narrow verge. First try a short checked step out of that padding; requiring
  // a full body-width escape can reject the only safe local opening forever.
  for (const radius of [navigation.cellSize * .5, navigation.cellSize, gap]) {
    for (const offset of [Math.PI / 2, -Math.PI / 2, 0, Math.PI, Math.PI / 4, -Math.PI / 4, Math.PI * .75, -Math.PI * .75]) {
      const point = { x: from.x + Math.cos(heading + offset) * radius, y: from.y + Math.sin(heading + offset) * radius };
      if (!canTraverse(navigation, from, point) || !canTraverseResidents(from, point, size, occupants, selfId)
        || !isWalkable(dynamic, point)) continue;
      const rest = findWorldPath(dynamic, point, target); searches++;
      if (rest) { const path = [from, ...rest]; if (safe(path)) return path; }
      if (searches >= RESIDENT_TRAFFIC_LIMITS.searches) return null;
    }
  }
  return null;
}
