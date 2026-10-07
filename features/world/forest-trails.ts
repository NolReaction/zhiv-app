import { canTraverse, createWorldNavigation, findWorldPath, isWalkable } from "./navigation";
import type { FixedWorldScene, WorldDestination, WorldPoint } from "./tiled/types";

export type ForestTrailDestination = WorldDestination["id"];
export type ForestTrail = { id: string; points: readonly WorldPoint[]; distances: readonly number[]; length: number };
const legacyDestinations: Partial<Record<ForestTrailDestination, string>> = {
  workshop: "trail-workshop", quarry: "trail-quarry", fishing: "trail-fishing",
};
const cache = new WeakMap<FixedWorldScene, ReadonlyMap<string, ForestTrail>>();
const destinationCache = new WeakMap<FixedWorldScene, ReadonlyMap<string, WorldDestination>>();

/** Authored centre lines are retained for legacy scenes. They never grant
 * permission to cross an obstacle or the edge of the WalkAreas union. */
export function forestTrails(scene: FixedWorldScene): ReadonlyMap<string, ForestTrail> {
  const existing = cache.get(scene); if (existing) return existing;
  const trails = new Map<string, ForestTrail>();
  const authored = scene.paths.filter(path => path.id.startsWith("trail-") && !path.behavior);
  if (authored.length) {
    const nav = createWorldNavigation(scene, (scene.actor?.size ?? 50) * .1);
    if (nav) for (const path of authored) {
      if (path.points.length < 2 || path.points.length > 128) continue;
      const points = path.points.map(point => ({ ...point })), distances = [0];
      let valid = true;
      for (let i = 1; i < points.length; i++) {
        const before = points[i - 1], point = points[i];
        if (!canTraverse(nav, before, point)) { valid = false; break; }
        distances.push(distances[i - 1] + Math.hypot(point.x - before.x, point.y - before.y));
      }
      if (valid && distances.at(-1)! > 1) trails.set(path.id, { id: path.id, points, distances, length: distances.at(-1)! });
    }
  }
  cache.set(scene, trails); return trails;
}

/** Destinations are exact foot positions. Invalid, ambiguous and blocked points
 * fail closed; the runtime never silently moves an edited marker onto safe land. */
export function forestDestinations(scene: FixedWorldScene): ReadonlyMap<string, WorldDestination> {
  const existing = destinationCache.get(scene); if (existing) return existing;
  const result = new Map<string, WorldDestination>(), source = scene.destinations;
  if (Array.isArray(source) && source.length <= 16) {
    const nav = createWorldNavigation(scene, (scene.actor?.size ?? 50) * .1);
    if (nav) for (const item of source) {
      if (!item || typeof item.id !== "string" || !item.id.trim() || !item.position
        || !Number.isFinite(item.position.x) || !Number.isFinite(item.position.y)
        || !Number.isFinite(item.pauseSeconds) || item.pauseSeconds < 2 || item.pauseSeconds > 60
        || source.filter(other => other?.id === item.id).length !== 1
        || item.siteId !== undefined && !scene.sites.some(site => site.id === item.siteId)
        || !isWalkable(nav, item.position)) continue;
      result.set(item.id, { ...item, position: { ...item.position } });
    }
  }
  destinationCache.set(scene, result); return result;
}

export function forestTrailDestination(scene: FixedWorldScene, destination: ForestTrailDestination): WorldPoint | null {
  if (scene.destinations !== undefined) {
    const point = forestDestinations(scene).get(destination)?.position;
    return point ? { ...point } : null;
  }
  const legacyId = legacyDestinations[destination];
  const end = legacyId ? forestTrails(scene).get(legacyId)?.points.at(-1) : null;
  return end ? { ...end } : null;
}

/** Explicit trips use the same swept-footprint search as local life. The world
 * road is never a teleport or permission to walk through a building/water. */
export function findForestTrailPath(scene: FixedWorldScene, from: WorldPoint, destination: ForestTrailDestination): WorldPoint[] | null {
  const end = forestTrailDestination(scene, destination);
  const nav = end && createWorldNavigation(scene, (scene.actor?.size ?? 50) * .1);
  return nav && end ? findWorldPath(nav, from, end) : null;
}
