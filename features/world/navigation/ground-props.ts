import type { WorldPoint } from "@/features/world/tiled/types";

const EPS = 1e-7;
const finite = (point: WorldPoint) => Number.isFinite(point?.x) && Number.isFinite(point?.y);

/** The basket's shallow ground support, not its handle or a resident's body. */
export function basketGroundFootprint(position: WorldPoint, size: number): WorldPoint[] {
  if (!finite(position) || !Number.isFinite(size) || size <= 0) return [];
  return Array.from({ length: 8 }, (_, index) => {
    const angle = index * Math.PI / 4;
    return { x: position.x + Math.cos(angle) * size * .5, y: position.y - size * .1 + Math.sin(angle) * size * .21 };
  });
}

function nearest(point: WorldPoint, a: WorldPoint, b: WorldPoint): WorldPoint {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return { x: a.x + dx * t, y: a.y + dy * t };
}
function cross(a: WorldPoint, b: WorldPoint, p: WorldPoint) { return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x); }
function segmentDistance(a: WorldPoint, b: WorldPoint, c: WorldPoint, d: WorldPoint) {
  const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
  if (ac * ad < 0 && ca * cb < 0) return 0;
  return Math.min(...[[a, c, d], [b, c, d], [c, a, b], [d, a, b]].map(([point, start, end]) => {
    const q = nearest(point, start, end); return Math.hypot(point.x - q.x, point.y - q.y);
  }));
}
function contact(point: WorldPoint, polygon: readonly WorldPoint[]) {
  let inside = false, distance = Infinity, closest = point, normal = { x: 0, y: 0 };
  const winding = Math.sign(polygon.reduce((area, a, index) => {
    const b = polygon[(index + 1) % polygon.length]; return area + a.x * b.y - b.x * a.y;
  }, 0));
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length], q = nearest(point, a, b);
    const gap = Math.hypot(point.x - q.x, point.y - q.y);
    if (gap < distance) { distance = gap; closest = q; normal = { x: (b.y - a.y) * winding, y: (a.x - b.x) * winding }; }
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return { distance: inside ? -distance : distance,
    outward: distance < EPS ? normal : inside
      ? { x: closest.x - point.x, y: closest.y - point.y } : { x: point.x - closest.x, y: point.y - closest.y } };
}

/** Swept physical feet against a small, convex prop. A newly lowered basket
 * may overlap old feet: allow only a monotonically outward escape, never a
 * crossing through the support. Props never inherit residents' soft passing. */
export function canTraverseGroundFootprint(polygon: readonly WorldPoint[], from: WorldPoint, to: WorldPoint, radius: number): boolean {
  if (polygon.length < 3 || polygon.length > 32 || !polygon.every(finite)
    || !finite(from) || !finite(to) || !Number.isFinite(radius) || radius < 0) return false;
  const start = contact(from, polygon);
  if (start.distance <= radius + EPS) {
    const dx = to.x - from.x, dy = to.y - from.y;
    if (start.outward.x * dx + start.outward.y * dy < -EPS) return false;
    let previous = start.distance;
    for (let sample = 1; sample <= 4; sample++) {
      const gap = contact({ x: from.x + dx * sample / 4, y: from.y + dy * sample / 4 }, polygon).distance;
      if (gap < previous - EPS) return false;
      previous = gap;
    }
    return previous > start.distance + EPS;
  }
  if (contact(to, polygon).distance <= radius + EPS) return false;
  return polygon.every((point, index) => segmentDistance(from, to, point, polygon[(index + 1) % polygon.length]) > radius + EPS);
}
