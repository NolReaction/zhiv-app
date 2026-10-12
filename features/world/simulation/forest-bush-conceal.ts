import type { WorldBush, WorldPoint } from "@/features/world/tiled/types";

const inside = (point: WorldPoint, polygon: readonly WorldPoint[]) => {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
};

/** Ground depth starts at the real leaf contour, never when a route is selected
 * or a raised head happens to overlap the crown in screen space. */
export function bushConcealStart({ entry: a, hide: b, points }: Pick<WorldBush, "entry" | "hide" | "points">): number {
  const dx = b.x - a.x, dy = b.y - a.y, cuts = [0, 1];
  if (Math.hypot(dx, dy) < 1e-8) return 0;
  for (let i = 0; i < points.length; i++) {
    const c = points[i], d = points[(i + 1) % points.length], ex = d.x - c.x, ey = d.y - c.y;
    const determinant = dx * ey - dy * ex;
    if (Math.abs(determinant) < 1e-8) continue;
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / determinant;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / determinant;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) cuts.push(t);
  }
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const t = (cuts[i - 1] + cuts[i]) / 2;
    if (inside({ x: a.x + dx * t, y: a.y + dy * t }, points)) return cuts[i - 1];
  }
  return 1;
}
