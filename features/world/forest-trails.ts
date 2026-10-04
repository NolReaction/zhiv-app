import { canTraverse, createWorldNavigation, findWorldPath } from "./navigation";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export type ForestTrailDestination = "workshop" | "quarry" | "fishing";
export type ForestTrail = { id: string; points: readonly WorldPoint[]; distances: readonly number[]; length: number };
const destinations: Record<ForestTrailDestination, string> = {
  workshop: "trail-workshop", quarry: "trail-quarry", fishing: "trail-fishing",
};
const cache = new WeakMap<FixedWorldScene, ReadonlyMap<string, ForestTrail>>();

/** Authored centre lines and the ordinary WalkAreas share the same collision
 * rules. Invalid/missing roads remain closed; decoration cannot grant passage. */
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

export function forestTrailDestination(scene: FixedWorldScene, destination: ForestTrailDestination): WorldPoint | null {
  const end = forestTrails(scene).get(destinations[destination])?.points.at(-1);
  return end ? { ...end } : null;
}

/** Explicit trips use the same swept-footprint search as local life. The world
 * road is never a teleport or permission to walk through a building/water. */
export function findForestTrailPath(scene: FixedWorldScene, from: WorldPoint, destination: ForestTrailDestination): WorldPoint[] | null {
  const end = forestTrailDestination(scene, destination);
  const nav = end && createWorldNavigation(scene, (scene.actor?.size ?? 50) * .1);
  return nav && end ? findWorldPath(nav, from, end) : null;
}
