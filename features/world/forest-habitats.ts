import type { FixedWorldScene, WorldHabitat, WorldPoint } from "./tiled/types";
import { canTraverse, createWorldNavigation, findWorldPath, type WorldNavigation } from "./navigation";

const MARGIN = 2;
const fields = new WeakMap<WorldHabitat, WorldNavigation | null>();
const flights = new WeakMap<WorldPoint, { habitat: WorldHabitat; path: WorldPoint[]; target: WorldPoint; retryAt: number }>();
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);

function pointInPolygon(p: WorldPoint, points: WorldPoint[]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function edgeDistance(p: WorldPoint, a: WorldPoint, b: WorldPoint) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** The outer contour minus authored exclusions, with space for a complete flight orbit. */
export function habitatContains(habitat: WorldHabitat, p: WorldPoint, radius = 0) {
  if (!pointInPolygon(p, habitat.points) || habitat.exclusions?.some(hole => pointInPolygon(p, hole.points))) return false;
  for (const polygon of [habitat.points, ...(habitat.exclusions ?? []).map(hole => hole.points)]) {
    for (let i = 0; i < polygon.length; i++) {
      if (edgeDistance(p, polygon[i], polygon[(i + 1) % polygon.length]) <= radius) return false;
    }
  }
  return true;
}

/** Reuse the bounded path search for flight; only habitat contours are blockers, never ground/water. */
function flightField(habitat: WorldHabitat) {
  if (fields.has(habitat)) return fields.get(habitat)!;
  const maxX = Math.max(...habitat.points.map(p => p.x)), maxY = Math.max(...habitat.points.map(p => p.y));
  const scene: FixedWorldScene = {
    schemaVersion: 1, id: `flight-${habitat.id}`, width: maxX, height: maxY,
    focus: { x: 0, y: 0, width: maxX, height: maxY }, terrain: [], sites: [], paths: [],
    navigation: { version: 1, cellSize: Math.max(4, Math.max(maxX, maxY) / 100),
      areas: [{ id: habitat.id, points: habitat.points }], obstacles: habitat.exclusions ?? [], interests: [] },
  };
  const nav = createWorldNavigation(scene, MARGIN);
  fields.set(habitat, nav);
  return nav;
}

/** Deterministic fallback when random sampling misses a narrow remaining region. */
export function habitatFallbackPoint(habitat: WorldHabitat): WorldPoint | null {
  const nav = flightField(habitat);
  if (!nav) return null;
  for (let index = 0; index < nav.grid.walkable.length; index++) {
    if (nav.grid.walkable[index]) return {
      x: nav.grid.origin.x + index % nav.grid.columns * nav.cellSize,
      y: nav.grid.origin.y + Math.floor(index / nav.grid.columns) * nav.cellSize,
    };
  }
  return null;
}

export function habitatCanTraverse(habitat: WorldHabitat, from: WorldPoint, to: WorldPoint) {
  const nav = flightField(habitat);
  return Boolean(nav && canTraverse(nav, from, to));
}

/** Rest/return flights go around the clearing instead of cutting through the excluded centre. */
export function habitatFlightTarget(habitat: WorldHabitat, from: WorldPoint, target: WorldPoint, elapsed: number): WorldPoint | null {
  const nav = flightField(habitat);
  if (!nav) return null;
  if (canTraverse(nav, from, target)) { flights.delete(from); return target; }
  let flight = flights.get(from);
  if (!flight || flight.habitat !== habitat || distance(flight.target, target) > 8
    || !flight.path.length && elapsed >= flight.retryAt) {
    flight = { habitat, path: findWorldPath(nav, from, target)?.slice(1) ?? [], target: { ...target }, retryAt: elapsed + 2 };
    flights.set(from, flight);
  }
  while (flight.path.length && distance(from, flight.path[0]) < 1) flight.path.shift();
  const next = flight.path[0];
  if (next && canTraverse(nav, from, next)) return next;
  // A disconnected or completely subtracted region is not permission to cross the clearing.
  return null;
}
