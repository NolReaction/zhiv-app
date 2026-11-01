import { findWorldPath, isWalkable, type WorldNavigation } from "@/features/world/navigation/navigation";
import { isForestWater } from "@/features/world/environment/water/forest-water";
import { previewPointInPolygon } from "@/features/world/tiled/preview-state";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

type EdgePoint = WorldPoint & { side: "north" | "east" | "south" | "west"; depth: number };
const candidates = new WeakMap<WorldNavigation, { scene: FixedWorldScene; points: EdgePoint[] }>();
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const landCorridors = new Set(["northern-trail", "eastern-trail", "market-road"]);

function landExit(scene: FixedWorldScene, point: WorldPoint, side: EdgePoint["side"]) {
  // The authored north road ends 9px before the image edge. The other land
  // roads reach within 2px. The pier belongs to eastern-trail too, but its
  // walkable spur stops 16px short: proximity or area name alone is not an exit.
  const boundary = side === "north" ? { x: point.x, y: 0 }
    : side === "south" ? { x: point.x, y: scene.height }
      : side === "west" ? { x: 0, y: point.y } : { x: scene.width, y: point.y };
  const inset = side === "north" ? { ...boundary, y: 12 }
    : side === "south" ? { ...boundary, y: scene.height - 12 }
      : side === "west" ? { ...boundary, x: 12 } : { ...boundary, x: scene.width - 12 };
  const middle = { x: (point.x + inset.x) / 2, y: (point.y + inset.y) / 2 };
  if (!scene.navigation?.areas.some(area => landCorridors.has(area.id)
    && [point, middle, inset].every(sample => previewPointInPolygon(sample, area.points)))) return false;
  const steps = Math.max(1, Math.ceil(distance(point, boundary) / 4));
  for (let step = 0; step <= steps; step++) {
    const p = step / steps;
    if (isForestWater(scene, { x: point.x + (boundary.x - point.x) * p, y: point.y + (boundary.y - point.y) * p })) return false;
  }
  return true;
}

/** Inspect the bounded navigation grid once. A portal only bridges the final
 * authored edge strip; it never creates a road through the forest or water. */
function edgePoints(scene: FixedWorldScene, nav: WorldNavigation): EdgePoint[] {
  const saved = candidates.get(nav);
  if (saved?.scene === scene) return saved.points;
  const bins = new Map<string, EdgePoint>(), { origin, columns, walkable } = nav.grid;
  for (let index = 0; index < walkable.length; index++) {
    if (!walkable[index]) continue;
    const x = origin.x + index % columns * nav.cellSize, y = origin.y + Math.floor(index / columns) * nav.cellSize;
    if (x < 0 || y < 0 || x > scene.width || y > scene.height) continue;
    const sides = [{ side: "north" as const, depth: y, along: x / scene.width },
      { side: "east" as const, depth: scene.width - x, along: y / scene.height },
      { side: "south" as const, depth: scene.height - y, along: x / scene.width },
      { side: "west" as const, depth: x, along: y / scene.height }];
    for (const { side, depth, along } of sides) {
      if (depth > 36 || !landExit(scene, { x, y }, side)) continue;
      const key = `${side}:${Math.min(7, Math.floor(along * 8))}`, previous = bins.get(key);
      if (!previous || depth < previous.depth) bins.set(key, { x, y, side, depth });
    }
  }
  const points = [...bins.values()]; candidates.set(nav, { scene, points }); return points;
}

export function forestOutsideEdge(scene: FixedWorldScene, nav: WorldNavigation, from: WorldPoint, size: number) {
  // At most three candidates per side, twelve bounded searches per departure.
  // Disconnected map margins cannot monopolize all attempts.
  const ranked = edgePoints(scene, nav).sort((a, b) => distance(from, a) - distance(from, b)), counts = new Map<string, number>();
  for (const candidate of ranked) {
    const count = counts.get(candidate.side) ?? 0;
    if (count >= 3) continue;
    counts.set(candidate.side, count + 1);
    if (!isWalkable(nav, candidate) || !findWorldPath(nav, from, candidate)) continue;
    const entry = { x: candidate.x, y: candidate.y }, margin = Math.max(1, size) * 1.25;
    const offscreen = candidate.side === "north" ? { x: entry.x, y: -margin }
      : candidate.side === "south" ? { x: entry.x, y: scene.height + margin }
        : candidate.side === "west" ? { x: -margin, y: entry.y } : { x: scene.width + margin, y: entry.y };
    return { entry, offscreen, duration: distance(entry, offscreen) / Math.max(1, size * .36) };
  }
  return null;
}
