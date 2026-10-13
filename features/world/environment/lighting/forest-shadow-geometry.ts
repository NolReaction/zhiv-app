import type { WorldPoint, WorldShadowCaster } from "@/features/world/tiled/types";

/** Direction points toward the sun/moon in uncompressed ground coordinates. */
export type DirectionalShadowLight = {
  kind: "directional"; direction: WorldPoint; elevation: number;
};
/** Position is the light's footprint on the ground, not its painted flame. */
export type PointShadowLight = {
  kind: "point"; position: WorldPoint; height: number; radius: number;
};
export type ShadowLight = DirectionalShadowLight | PointShadowLight;

export const FOREST_SHADOW_GEOMETRY = { groundCompression: .55, maxDirectionalLength: 320, lightSegments: 32 } as const;
export type PreparedForestShadowGeometry = { points: WorldPoint[]; triangles: number[][]; convex?: boolean };
const EPSILON = 1e-7;
// Generated footprints are immutable for the life of a render frame. Their
// known convex topology follows point arrays through copies of the caster.
type ActorGeometry = PreparedForestShadowGeometry & { footprintKey: string; x: number; y: number; radius: number };
const actorGeometry = new WeakMap<WorldPoint[], ActorGeometry>();
const pointDisks = new WeakMap<PointShadowLight, { x: number; y: number; radius: number; points: WorldPoint[] }>();
const unitDisk = Array.from({ length: FOREST_SHADOW_GEOMETRY.lightSegments }, (_, index) => {
  const angle = index / FOREST_SHADOW_GEOMETRY.lightSegments * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
});
const unitActor = Array.from({ length: 8 }, (_, index) => {
  const angle = index * Math.PI / 4;
  return { x: Math.cos(angle), y: Math.sin(angle) * FOREST_SHADOW_GEOMETRY.groundCompression };
});
const finitePoint = (point: WorldPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
const cross = (a: WorldPoint, b: WorldPoint, c: WorldPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const area = (points: WorldPoint[]) => points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length]; return sum + point.x * next.y - point.y * next.x;
}, 0) / 2;

function cleanPolygon(points: WorldPoint[]): WorldPoint[] {
  const result = points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    return Math.hypot(point.x - previous.x, point.y - previous.y) > EPSILON;
  }).map(point => ({ ...point }));
  // Collinear editor vertices do not need ears and can otherwise stall clipping.
  for (let index = result.length - 1; index >= 0 && result.length > 3; index--) {
    if (Math.abs(cross(result[(index + result.length - 1) % result.length], result[index], result[(index + 1) % result.length])) < EPSILON) result.splice(index, 1);
  }
  if (area(result) < 0) result.reverse();
  return result;
}

/** Ear clipping preserves concave courtyards: a convex hull would fill them. */
function triangulate(points: WorldPoint[]): number[][] {
  if (points.length < 3 || area(points) < EPSILON) return [];
  const remaining = points.map((_, index) => index), triangles: number[][] = [];
  while (remaining.length > 3) {
    let found = false;
    for (let index = 0; index < remaining.length; index++) {
      const a = remaining[(index + remaining.length - 1) % remaining.length];
      const b = remaining[index], c = remaining[(index + 1) % remaining.length];
      if (cross(points[a], points[b], points[c]) <= EPSILON) continue;
      if (remaining.some(other => other !== a && other !== b && other !== c
        && cross(points[a], points[b], points[other]) >= -EPSILON
        && cross(points[b], points[c], points[other]) >= -EPSILON
        && cross(points[c], points[a], points[other]) >= -EPSILON)) continue;
      triangles.push([a, b, c]); remaining.splice(index, 1); found = true; break;
    }
    if (!found) return []; // Malformed/self-intersecting input never makes an unbounded loop.
  }
  triangles.push(remaining); return triangles;
}

/** Prepare authored topology once; replace it whenever the contour is edited. */
export function prepareForestShadowGeometry(points: WorldPoint[]): PreparedForestShadowGeometry {
  const cleaned = cleanPolygon(points);
  return { points: cleaned, triangles: triangulate(cleaned) };
}

function currentActorGeometry(caster: WorldShadowCaster): ActorGeometry | undefined {
  const geometry = actorGeometry.get(caster.points);
  if (!geometry || caster.points.length !== unitActor.length || caster.points.some((point, index) =>
    point.x !== geometry.x + unitActor[index].x * geometry.radius
    || point.y !== geometry.y + unitActor[index].y * geometry.radius)) return;
  return geometry;
}

/** Generated contours are affine copies of one immutable ellipse. Their three
 * footprint parameters identify the same shape without serializing 8 vertices. */
export function forestActorShadowFootprintKey(caster: WorldShadowCaster): string | undefined {
  // Mutable legacy callers can still edit an actor's vertices. Such a contour
  // falls back to its full signature and generic concave-capable projection.
  return currentActorGeometry(caster)?.footprintKey;
}

function convexOutline(points: WorldPoint[]): WorldPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: WorldPoint[] = [], upper: WorldPoint[] = [];
  for (const point of sorted) {
    while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= EPSILON) lower.pop();
    lower.push(point);
  }
  for (let index = sorted.length - 1; index >= 0; index--) {
    const point = sorted[index];
    while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= EPSILON) upper.pop();
    upper.push(point);
  }
  lower.pop(); upper.pop(); return lower.concat(upper);
}

function distanceToBoundary(point: WorldPoint, points: WorldPoint[]) {
  let distance = Infinity, inside = false;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > EPSILON ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
    distance = Math.min(distance, Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t));
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return { distance, inside: inside || distance < EPSILON };
}

function lightDisk(light: PointShadowLight) {
  const previous = pointDisks.get(light);
  if (previous && previous.x === light.position.x && previous.y === light.position.y && previous.radius === light.radius) return previous.points;
  const points = unitDisk.map(point => ({ x: light.position.x + point.x * light.radius, y: light.position.y + point.y * light.radius }));
  pointDisks.set(light, { x: light.position.x, y: light.position.y, radius: light.radius, points });
  return points;
}

/** Convex clipping keeps point shadows inside the actual finite light footprint. */
function clipPolygon(polygon: WorldPoint[], clip: WorldPoint[]) {
  let output = polygon;
  for (let index = 0; index < clip.length && output.length; index++) {
    const a = clip[index], b = clip[(index + 1) % clip.length], input = output; output = [];
    let previous = input[input.length - 1], previousSide = cross(a, b, previous);
    for (const current of input) {
      const currentSide = cross(a, b, current);
      if ((currentSide >= 0) !== (previousSide >= 0)) {
        const t = previousSide / (previousSide - currentSide);
        output.push({ x: previous.x + (current.x - previous.x) * t, y: previous.y + (current.y - previous.y) * t });
      }
      if (currentSide >= 0) output.push(current);
      previous = current; previousSide = currentSide;
    }
  }
  return output;
}

/** Projects a vertical prism onto a horizontal receiving plane.
 * Every returned piece is convex and has the same winding. Fill all pieces in
 * ONE nonzero path (or opaque mask), never alpha-blend each overlapping piece.
 * Receiver clipping belongs to the painter; receiver points use painted screen
 * coordinates. Their vertical screen offset is already applied here (y -= z).
 */
export function projectForestShadow(caster: WorldShadowCaster, light: ShadowLight, receiverHeight = 0,
  prepared?: PreparedForestShadowGeometry): WorldPoint[][] {
  if (!Number.isFinite(receiverHeight) || !Number.isFinite(caster.height) || caster.height <= 0
    || !Number.isFinite(caster.baseHeight) || caster.baseHeight < 0
    || caster.points.length < 3 || caster.points.some(point => !finitePoint(point))) return [];
  const topHeight = caster.baseHeight + caster.height, bottomHeight = Math.max(caster.baseHeight, receiverHeight);
  if (!Number.isFinite(topHeight) || topHeight <= bottomHeight) return [];
  const geometry = prepared ?? currentActorGeometry(caster) ?? prepareForestShadowGeometry(caster.points);
  const { points, triangles } = geometry;
  if (points.length < 3 || !geometry.convex && !triangles.length) return [];
  let project: (point: WorldPoint, height: number) => WorldPoint;
  let disk: WorldPoint[] | undefined;
  if (light.kind === "directional") {
    const length = Math.hypot(light.direction.x, light.direction.y);
    if (!finitePoint(light.direction) || length < EPSILON || !Number.isFinite(light.elevation) || light.elevation <= 0 || light.elevation > 90) return [];
    const slope = Math.tan(light.elevation * Math.PI / 180);
    project = (point, height) => {
      const reach = Math.min(FOREST_SHADOW_GEOMETRY.maxDirectionalLength, (height - receiverHeight) / slope);
      return { x: point.x - light.direction.x / length * reach,
        y: point.y - light.direction.y / length * reach * FOREST_SHADOW_GEOMETRY.groundCompression };
    };
  } else {
    if (!finitePoint(light.position) || !Number.isFinite(light.height) || light.height <= bottomHeight
      || !Number.isFinite(light.radius) || light.radius <= 0) return [];
    const boundary = distanceToBoundary(light.position, points);
    if (!boundary.inside && boundary.distance >= light.radius) return [];
    disk = lightDisk(light);
    if (boundary.inside && light.height <= topHeight) {
      // A light enclosed in solid geometry cannot illuminate the outside plane.
      return [disk.map(point => ({ x: point.x, y: point.y - receiverHeight }))];
    }
    // One common homothety factor preserves the polygon's concavity. Clamping
    // each vertex's radial distance would bend edges and create false shadows.
    // At this factor the projected cap lies outside the light disk, so extending
    // still further cannot affect any illuminated pixel, even for a low flame.
    const farFactor = Math.max(1, light.radius / Math.max(boundary.distance, EPSILON)) + 1;
    project = (point, height) => {
      const factor = height >= light.height ? farFactor
        : Math.min(farFactor, (light.height - receiverHeight) / (light.height - height));
      return { x: light.position.x + (point.x - light.position.x) * factor,
        y: light.position.y + (point.y - light.position.y) * factor };
    };
  }
  const bottom = points.map(point => project(point, bottomHeight)), top = points.map(point => project(point, topHeight));
  // A convex prism projects to one convex outline. Actor footprints therefore
  // need one light-disk clip instead of 28 clips of overlapping triangles.
  const pieces: WorldPoint[][] = geometry.convex ? [convexOutline(bottom.concat(top))] : [];
  if (!geometry.convex) {
    for (const indices of triangles) { pieces.push(indices.map(index => bottom[index])); pieces.push(indices.map(index => top[index])); }
    for (let index = 0; index < points.length; index++) {
      const next = (index + 1) % points.length;
      pieces.push([bottom[index], bottom[next], top[next]], [bottom[index], top[next], top[index]]);
    }
  }
  const result: WorldPoint[][] = [];
  for (const piece of pieces) {
    const clipped = disk ? clipPolygon(piece, disk) : piece;
    if (clipped.length < 3 || clipped.some(point => !finitePoint(point))) continue;
    const signedArea = area(clipped);
    if (Math.abs(signedArea) < EPSILON) continue;
    if (signedArea < 0) clipped.reverse();
    result.push(clipped.map(point => ({ x: point.x, y: point.y - receiverHeight })));
  }
  return result;
}

/** Moving residents contribute a small ground footprint and a vertical body. */
export function createForestActorShadow(point: WorldPoint, size: number, id: string): WorldShadowCaster {
  const radius = Math.max(0, Number.isFinite(size) ? size : 0);
  const points = unitActor.map(offset => ({ x: point.x + offset.x * radius, y: point.y + offset.y * radius }));
  actorGeometry.set(points, { points, triangles: [], convex: true, footprintKey: JSON.stringify([point.x, point.y, radius]),
    x: point.x, y: point.y, radius });
  return { id, height: radius * 2.4, baseHeight: 0, opacity: .8, softness: 2, points };
}
