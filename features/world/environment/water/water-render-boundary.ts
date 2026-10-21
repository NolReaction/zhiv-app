import type { WorldPoint } from "@/features/world/tiled/types";

type Polygon = { points: WorldPoint[] };
type Water = { surfaces: Polygon[]; exclusions: Polygon[] };
type Vertex = { id: number; point: WorldPoint; original: boolean; parent?: Vertex };
type Cut = { t: number; vertex: Vertex };
type Edge = { a: Vertex; b: Vertex; dx: number; dy: number; length: number;
  left: number; top: number; right: number; bottom: number; cuts: Cut[] };
type PreparedPolygon = Polygon & { sign: number; left: number; top: number; right: number; bottom: number };
type Segment = { a: Vertex; b: Vertex; next?: Segment };
export type WaterRenderBoundary = { rings: WorldPoint[][]; sourceEdges: number };

const LIMITS = { edges: 4096, pairs: 4_000_000, cuts: 65536, segments: 16384, distanceChecks: 8_000_000 };
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
const fail = (): never => { throw new Error("Uncertified water boundary"); };
const root = (vertex: Vertex): Vertex => {
  if (vertex.parent) vertex.parent = root(vertex.parent);
  return vertex.parent ?? vertex;
};

function prepare(polygon: Polygon): PreparedPolygon {
  if (polygon.points.length < 3) fail();
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, area = 0;
  for (let index = 0; index < polygon.points.length; index++) {
    const a = polygon.points[index], b = polygon.points[(index + 1) % polygon.points.length];
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) fail();
    left = Math.min(left, a.x); top = Math.min(top, a.y); right = Math.max(right, a.x); bottom = Math.max(bottom, a.y);
    area += cross(a.x, a.y, b.x, b.y);
  }
  if (!(right > left && bottom > top)) fail();
  const [first, second] = polygon.points;
  if (!polygon.points.some(point => cross(second.x - first.x, second.y - first.y, point.x - first.x, point.y - first.y) !== 0)) fail();
  return { ...polygon, sign: area < 0 ? -1 : 1, left, top, right, bottom };
}

function winding(polygon: PreparedPolygon, x: number, y: number) {
  if (x < polygon.left || x > polygon.right || y < polygon.top || y > polygon.bottom) return 0;
  let result = 0;
  for (let index = 0, previous = polygon.points.length - 1; index < polygon.points.length; previous = index++) {
    const a = polygon.points[previous], b = polygon.points[index];
    if (a.y <= y && b.y > y && cross(b.x - a.x, b.y - a.y, x - a.x, y - a.y) > 0) result++;
    else if (a.y > y && b.y <= y && cross(b.x - a.x, b.y - a.y, x - a.x, y - a.y) < 0) result--;
  }
  return result;
}

/** Compile the exact planar boundary once. Original vertices remain in the
 * resulting rings; intersections only split edges, never simplify them. A
 * bounded or numerically ambiguous arrangement keeps the legacy vector clips. */
export function compileWaterRenderBoundary(water: Water): WaterRenderBoundary | undefined {
  try {
    if (water.surfaces.length + water.exclusions.length > LIMITS.edges) return undefined;
    let pointCount = 0;
    for (const polygon of [...water.surfaces, ...water.exclusions]) {
      pointCount += polygon.points.length;
      if (pointCount > LIMITS.edges) return undefined;
    }
    const surfaces = water.surfaces.map(prepare), exclusions = water.exclusions.map(prepare);
    if (!surfaces.length) return undefined;
    const polygons = [...surfaces, ...exclusions];
    const magnitude = Math.max(1, ...polygons.flatMap(p => [Math.abs(p.left), Math.abs(p.top), Math.abs(p.right), Math.abs(p.bottom)]));
    const epsilon = Number.EPSILON * magnitude * 64;
    const vertices = new Map<string, Vertex>(); let sequence = 0;
    const vertex = (point: WorldPoint, original: boolean) => {
      const key = `${point.x},${point.y}`, previous = vertices.get(key);
      if (previous) return previous;
      const result = { id: sequence++, point, original }; vertices.set(key, result); return result;
    };
    const join = (first: Vertex, second: Vertex) => {
      let a = root(first), b = root(second); if (a === b) return a;
      if (Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) > epsilon * 8) fail();
      // Distinct authored positions must not be snapped together, even when a
      // tiny strip is close to the precision limit of its world coordinates.
      if (a.original && b.original) fail();
      if (b.original || !a.original && b.id < a.id) [a, b] = [b, a];
      b.parent = a; return a;
    };
    const edges: Edge[] = [];
    for (const polygon of polygons) for (let index = 0; index < polygon.points.length; index++) {
      const a = vertex(polygon.points[index], true), b = vertex(polygon.points[(index + 1) % polygon.points.length], true);
      const dx = b.point.x - a.point.x, dy = b.point.y - a.point.y, length = Math.hypot(dx, dy);
      if (length <= epsilon * 16 || edges.length >= LIMITS.edges) fail();
      edges.push({ a, b, dx, dy, length, left: Math.min(a.point.x, b.point.x), top: Math.min(a.point.y, b.point.y),
        right: Math.max(a.point.x, b.point.x), bottom: Math.max(a.point.y, b.point.y), cuts: [{ t: 0, vertex: a }, { t: 1, vertex: b }] });
    }
    let pairs = 0, cuts = edges.length * 2;
    const add = (edge: Edge, t: number, point: Vertex) => {
      const tolerance = epsilon / edge.length;
      if (t < -tolerance || t > 1 + tolerance) return;
      if (++cuts > LIMITS.cuts) fail();
      edge.cuts.push({ t: Math.max(0, Math.min(1, t)), vertex: point });
    };
    for (let index = 0; index < edges.length; index++) for (let previous = 0; previous < index; previous++) {
      if (++pairs > LIMITS.pairs) fail();
      const a = edges[index], b = edges[previous];
      if (a.left > b.right || b.left > a.right || a.top > b.bottom || b.top > a.bottom) continue;
      const x = b.a.point.x - a.a.point.x, y = b.a.point.y - a.a.point.y;
      const determinant = cross(a.dx, a.dy, b.dx, b.dy);
      const parallel = Number.EPSILON * 16 * (Math.abs(a.dx * b.dy) + Math.abs(a.dy * b.dx));
      if (Math.abs(determinant) > parallel) {
        const t = cross(x, y, b.dx, b.dy) / determinant, u = cross(x, y, a.dx, a.dy) / determinant;
        if (t < -epsilon / a.length || t > 1 + epsilon / a.length || u < -epsilon / b.length || u > 1 + epsilon / b.length) continue;
        const endpoint = (edge: Edge, value: number) => value <= epsilon / edge.length ? edge.a
          : value >= 1 - epsilon / edge.length ? edge.b : undefined;
        const point = endpoint(a, t) ?? endpoint(b, u) ?? vertex({ x: a.a.point.x + t * a.dx, y: a.a.point.y + t * a.dy }, false);
        add(a, t, point); add(b, u, point);
      } else {
        if (Math.abs(cross(x, y, a.dx, a.dy)) > epsilon * a.length) continue;
        for (const point of [b.a, b.b]) add(a, ((point.point.x - a.a.point.x) * a.dx + (point.point.y - a.a.point.y) * a.dy) / (a.length * a.length), point);
        for (const point of [a.a, a.b]) add(b, ((point.point.x - b.a.point.x) * b.dx + (point.point.y - b.a.point.y) * b.dy) / (b.length * b.length), point);
      }
    }
    for (const edge of edges) {
      edge.cuts.sort((a, b) => a.t - b.t);
      const cuts: Cut[] = [];
      for (const cut of edge.cuts) {
        const previous = cuts.at(-1);
        if (previous && (cut.t - previous.t) * edge.length <= epsilon * 8) previous.vertex = join(previous.vertex, cut.vertex);
        else cuts.push(cut);
      }
      edge.cuts = cuts;
    }
    const wet = (x: number, y: number) => surfaces.reduce((sum, polygon) => sum + winding(polygon, x, y) * polygon.sign, 0) !== 0
      && !exclusions.some(polygon => Math.abs(winding(polygon, x, y)) % 2 === 1);
    const boundary = new Map<string, Segment>(); let distanceChecks = 0;
    for (const edge of edges) for (let index = 1; index < edge.cuts.length; index++) {
      let a = root(edge.cuts[index - 1].vertex), b = root(edge.cuts[index].vertex);
      if (a === b) continue;
      const dx = b.point.x - a.point.x, dy = b.point.y - a.point.y, length = Math.hypot(dx, dy);
      if (length <= epsilon * 16) fail();
      const x = (a.point.x + b.point.x) / 2, y = (a.point.y + b.point.y) / 2;
      const maximumOffset = Math.min(length * .0001, magnitude * .000001);
      let distance = (maximumOffset * 8) ** 2;
      for (const other of edges) {
        if (++distanceChecks > LIMITS.distanceChecks) fail();
        const bx = Math.max(other.left - x, 0, x - other.right), by = Math.max(other.top - y, 0, y - other.bottom);
        if (bx * bx + by * by >= distance) continue;
        const t = Math.max(0, Math.min(1, ((x - other.a.point.x) * other.dx + (y - other.a.point.y) * other.dy) / (other.length * other.length)));
        const ox = x - other.a.point.x - t * other.dx, oy = y - other.a.point.y - t * other.dy, squared = ox * ox + oy * oy;
        if (squared <= epsilon * epsilon * 16) {
          if (Math.abs(cross(dx, dy, other.dx, other.dy)) > epsilon * length * other.length) fail();
        } else distance = Math.min(distance, squared);
      }
      const offset = Math.min(maximumOffset, Math.sqrt(distance) * .125);
      if (!(offset > epsilon * 16)) fail();
      const nx = -dy / length * offset, ny = dx / length * offset;
      const left = wet(x + nx, y + ny), right = wet(x - nx, y - ny);
      if (left === right) continue;
      if (!left) [a, b] = [b, a];
      const key = `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`, previous = boundary.get(key);
      if (previous && (previous.a !== a || previous.b !== b)) fail();
      if (!previous) boundary.set(key, { a, b });
      if (boundary.size > LIMITS.segments) fail();
    }
    const outgoing = new Map<Vertex, Segment[]>(), incoming = new Map<Vertex, number>();
    for (const segment of boundary.values()) {
      const list = outgoing.get(segment.a) ?? []; list.push(segment); outgoing.set(segment.a, list);
      incoming.set(segment.b, (incoming.get(segment.b) ?? 0) + 1);
    }
    for (const [point, list] of outgoing) if (list.length !== incoming.get(point)) fail();
    const usedNext = new Set<Segment>();
    for (const segment of boundary.values()) {
      const reverse = Math.atan2(segment.a.point.y - segment.b.point.y, segment.a.point.x - segment.b.point.x);
      let turn = Infinity;
      for (const candidate of outgoing.get(segment.b) ?? []) {
        const angle = Math.atan2(candidate.b.point.y - candidate.a.point.y, candidate.b.point.x - candidate.a.point.x);
        const clockwise = (reverse - angle + Math.PI * 2) % (Math.PI * 2);
        if (clockwise < turn) { turn = clockwise; segment.next = candidate; }
      }
      if (!segment.next || usedNext.has(segment.next)) fail();
      usedNext.add(segment.next!);
    }
    const rings: WorldPoint[][] = [], visited = new Set<Segment>();
    for (const first of boundary.values()) {
      if (visited.has(first)) continue;
      const points: WorldPoint[] = []; let segment = first;
      do {
        if (visited.has(segment) || !segment.next) fail();
        visited.add(segment); points.push(segment.a.point); segment = segment.next!;
      } while (segment !== first);
      if (points.length < 3) fail();
      rings.push(points);
    }
    return { rings, sourceEdges: edges.length };
  } catch {
    return undefined;
  }
}
