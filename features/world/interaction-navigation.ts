import type { FixedWorldScene, WorldPoint } from "./tiled/types";
import { createWorldNavigation, findWorldPath, isWalkable, type WorldNavigation } from "./navigation";

type InteractionAccess = {
  id: string; entry: WorldPoint;
  /** The exact walkable end of the short authored transition, never a snapped goal. */
  dock: WorldPoint;
  departure: WorldPoint[];
};
export type WorldHomeInteraction = InteractionAccess & { kind: "home"; doorway: WorldPoint };
export type WorldBushInteraction = InteractionAccess & { kind: "bush"; hide: WorldPoint; pauseSeconds?: number };
export type WorldInteraction = WorldHomeInteraction | WorldBushInteraction;
export type WorldInteractions = {
  home: WorldHomeInteraction | null; bushes: WorldBushInteraction[];
  diagnostics: { id: string; valid: boolean; reason: string | null }[];
};
const cache = new WeakMap<FixedWorldScene, WorldInteractions>();
const EPS = 1e-7;
const finite = (point: WorldPoint | undefined): point is WorldPoint => !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const copy = (points: WorldPoint[]) => points.map(point => ({ ...point }));
function pointSegmentSquared(p: WorldPoint, a: WorldPoint, b: WorldPoint) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
}
function inside(p: WorldPoint, polygon: WorldPoint[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (pointSegmentSquared(p, a, b) < EPS * EPS) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)) result = !result;
  }
  return result;
}
function crosses(a: WorldPoint, b: WorldPoint, c: WorldPoint, d: WorldPoint) {
  const cross = (p: WorldPoint, q: WorldPoint, r: WorldPoint) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}
function touches(a: WorldPoint, b: WorldPoint, polygon: WorldPoint[], radius: number) {
  // Malformed blockers must fail closed in editor previews as well.
  if (polygon.length < 3 || !polygon.every(finite)) return true;
  if (inside(a, polygon) || inside(b, polygon)) return true;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const c = polygon[j], d = polygon[i];
    if (crosses(a, b, c, d) || Math.min(pointSegmentSquared(a, c, d), pointSegmentSquared(b, c, d),
      pointSegmentSquared(c, a, b), pointSegmentSquared(d, a, b)) <= radius * radius + EPS) return true;
  }
  return false;
}
function visibleFoot(scene: FixedWorldScene, point: WorldPoint, size: number, lift = 0) {
  const focus = scene.focus;
  if (![focus.x, focus.y, focus.width, focus.height].every(Number.isFinite) || focus.width <= 0 || focus.height <= 0) return false;
  for (const dx of [-size * .5, size * .5]) for (const dy of [-size - lift, size * .08]) {
    const x = point.x + dx, y = point.y + dy;
    if (x < 0 || y < 0 || x > scene.width || y > scene.height
      || ((x - focus.x - focus.width / 2) / (focus.width / 2)) ** 2
        + ((y - focus.y - focus.height / 2) / (focus.height / 2)) ** 2 > 1) return false;
  }
  return true;
}
function corridorClear(scene: FixedWorldScene, a: WorldPoint, b: WorldPoint, radius: number, ownHome?: string) {
  return !scene.sites.some(site => site.id !== ownHome && touches(a, b, site.collision, radius))
    && !scene.water?.surfaces.some(surface => touches(a, b, surface.points, radius))
    && !scene.navigation?.obstacles.some(obstacle => touches(a, b, obstacle.points, radius));
}

/** Compile only local animation corridors. All travel to them still uses normal A*.
 * A home may bridge at most .24 actor sizes along its outward doorway axis. This
 * permission belongs to that interaction, never to the shared navigation field. */
export function compileWorldInteractions(scene: FixedWorldScene): WorldInteractions {
  const cached = cache.get(scene); if (cached) return cached;
  const result: WorldInteractions = { home: null, bushes: [], diagnostics: [] };
  cache.set(scene, result);
  const size = scene.actor?.size ?? 0, nav = createWorldNavigation(scene, size * .1);
  const record = (id: string, reason: string | null) => result.diagnostics.push({ id, valid: reason === null, reason });
  if (!Number.isFinite(size) || size <= 0 || !nav) { record("navigation", "missing-navigation"); return result; }
  const home = scene.sites.find(site => site.id === "home");
  if (home) {
    const entry = home.entry, doorway = home.doorway ?? entry;
    let reason: string | null = null, dock: WorldPoint | null = null;
    if (!finite(entry) || !finite(doorway) || distance(entry, doorway) > size * .6) reason = "invalid-doorway";
    else if (!visibleFoot(scene, entry, size) || !visibleFoot(scene, doorway, size)) reason = "outside-focus";
    else if (!corridorClear(scene, entry, doorway, nav.radius, home.id)) reason = "blocked-doorway";
    else if (isWalkable(nav, entry)) dock = { ...entry };
    else {
      const length = distance(entry, doorway);
      // Search a bounded one-dimensional docking interval, never a nearest cell
      // on the opposite side of a wall. The final point keeps the full foot radius.
      for (let step = 1; length > EPS && step <= 32 && !dock; step++) {
        const offset = size * .24 * step / 32;
        const candidate = { x: entry.x + (entry.x - doorway.x) * offset / length,
          y: entry.y + (entry.y - doorway.y) * offset / length };
        if (isWalkable(nav, candidate) && visibleFoot(scene, candidate, size)
          && corridorClear(scene, candidate, entry, nav.radius, home.id)) dock = candidate;
      }
      if (!dock) reason = "unreachable-door-entry";
    }
    record(home.id, reason);
    if (!reason && dock) result.home = { kind: "home", id: home.id, entry: { ...entry }, doorway: { ...doorway }, dock,
      departure: distance(entry, dock) > EPS ? copy([entry, dock]) : copy([entry]) };
  }
  for (const bush of (scene.bushes ?? []).slice(0, 64)) {
    let reason: string | null = null;
    if (!finite(bush.entry) || !finite(bush.hide) || bush.points.length < 3 || !bush.points.every(finite)
      || !inside(bush.hide, bush.points)) reason = "invalid-bush";
    else if (distance(bush.entry, bush.hide) < size * .1 || distance(bush.entry, bush.hide) > size * .8) reason = "invalid-bush-corridor";
    else if (!isWalkable(nav, bush.entry)) reason = "unreachable-bush-entry";
    else if (!corridorClear(scene, bush.entry, bush.hide, nav.radius)) reason = "blocked-bush-corridor";
    else for (let sample = 0; sample <= 16; sample++) {
      const t = sample / 16, point = { x: bush.entry.x + (bush.hide.x - bush.entry.x) * t,
        y: bush.entry.y + (bush.hide.y - bush.entry.y) * t };
      if (!visibleFoot(scene, point, size, Math.sin(t * Math.PI) * size * .28)) { reason = "outside-focus"; break; }
    }
    record(bush.id, reason);
    if (!reason) result.bushes.push({ kind: "bush", id: bush.id, entry: { ...bush.entry }, hide: { ...bush.hide },
      dock: { ...bush.entry }, departure: copy([bush.entry]) });
  }
  return result;
}

export function findInteractionApproach(navigation: WorldNavigation, from: WorldPoint, interaction: WorldInteraction) {
  const path = findWorldPath(navigation, from, interaction.dock);
  if (!path) return null;
  const points = copy(path);
  if (distance(points.at(-1)!, interaction.entry) > EPS) points.push({ ...interaction.entry });
  return { points, departure: copy(interaction.departure) };
}
