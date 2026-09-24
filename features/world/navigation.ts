import type { FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";

type Edge = { a: WorldPoint; b: WorldPoint; bounds: WorldBounds };
type Polygon = { points: WorldPoint[]; edges: Edge[]; bounds: WorldBounds; winding: number; rows: Map<number, Edge[]> };
type SpatialIndex = { bounds: WorldBounds; step: number; columns: number; rows: number; buckets: Map<number, Edge[]> };
type PreparationBudget = { remaining: number };
export type NavigationSearchReason = "direct" | "found" | "invalid-endpoint" | "disconnected-endpoint" | "no-path" | "search-limit";
export type WorldNavigation = {
  radius: number; cellSize: number; bounds: WorldBounds;
  /** Cell centres are origin + (column, row) * cellSize. Read-only diagnostic snapshot. */
  grid: { origin: WorldPoint; columns: number; rows: number; walkable: Uint8Array };
  debug: { boundary: { a: WorldPoint; b: WorldPoint }[]; blockers: WorldPoint[][] };
  stats: { cells: number; walkableCells: number; boundaryEdges: number; blockerEdges: number;
    lastSearch: { reason: NavigationSearchReason; visited: number; checks: number; pathPoints: number } | null };
};
type Geometry = { areas: Polygon[]; blockers: Polygon[]; boundary: SpatialIndex; blocked: SpatialIndex;
  rowStep: number; rowOrigin: number; edgeKnown: Uint8Array; edgePass: Uint8Array };

/** Limits also apply to malformed editor previews; no grid or search can grow without bound. */
export const WORLD_NAVIGATION_LIMITS = {
  cells: 65_536, areaEdges: 1_024, geometryEdges: 20_000, indexReferences: 1_000_000, preparationChecks: 2_000_000,
  searchVisits: 16_384, searchChecks: 140_000, smoothingChecks: 2_048,
} as const;
const EPS = 1e-7;
const cache = new WeakMap<FixedWorldScene, Map<number, WorldNavigation | null>>();
const geometry = new WeakMap<WorldNavigation, Geometry>();
const finite = (p: WorldPoint | undefined): p is WorldPoint => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(b.x - a.x, b.y - a.y);
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const lerp = (a: WorldPoint, b: WorldPoint, t: number): WorldPoint => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function bounds(points: WorldPoint[]): WorldBounds {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
  return { x, y, width: right - x, height: bottom - y };
}
function overlaps(a: WorldBounds, b: WorldBounds, pad = 0) {
  return a.x <= b.x + b.width + pad && a.x + a.width + pad >= b.x
    && a.y <= b.y + b.height + pad && a.y + a.height + pad >= b.y;
}
function contains(box: WorldBounds, p: WorldPoint, pad = 0) {
  return p.x >= box.x - pad && p.x <= box.x + box.width + pad && p.y >= box.y - pad && p.y <= box.y + box.height + pad;
}
function pointSegmentSquared(p: WorldPoint, a: WorldPoint, b: WorldPoint) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return (p.x - a.x - dx * t) ** 2 + (p.y - a.y - dy * t) ** 2;
}
function segmentSquared(a: WorldPoint, b: WorldPoint, c: WorldPoint, d: WorldPoint) {
  const abx = b.x - a.x, aby = b.y - a.y, cdx = d.x - c.x, cdy = d.y - c.y;
  const denominator = cross(abx, aby, cdx, cdy);
  if (denominator !== 0) {
    const t = cross(c.x - a.x, c.y - a.y, cdx, cdy) / denominator;
    const u = cross(c.x - a.x, c.y - a.y, abx, aby) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(pointSegmentSquared(a, c, d), pointSegmentSquared(b, c, d),
    pointSegmentSquared(c, a, b), pointSegmentSquared(d, a, b));
}

function preparePolygon(input: WorldPoint[], rowOrigin: number, rowStep: number, rowCount: number, budget: PreparationBudget): Polygon | null {
  if (!Array.isArray(input) || input.length < 3 || !input.every(finite)) return null;
  const points = input.map(p => ({ ...p })), edges: Edge[] = [], rows = new Map<number, Edge[]>();
  let signedArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    signedArea += cross(a.x, a.y, b.x, b.y);
    if (distance(a, b) <= EPS) continue;
    const edge = { a, b, bounds: bounds([a, b]) }; edges.push(edge);
    const lo = Math.max(0, Math.floor((edge.bounds.y - rowOrigin - EPS) / rowStep));
    const hi = Math.min(rowCount - 1, Math.floor((edge.bounds.y + edge.bounds.height - rowOrigin + EPS) / rowStep));
    budget.remaining -= Math.max(0, hi - lo + 1);
    if (budget.remaining < 0) return null;
    for (let row = lo; row <= hi; row++) { const list = rows.get(row) ?? []; list.push(edge); rows.set(row, list); }
  }
  if (!Number.isFinite(signedArea) || Math.abs(signedArea) <= EPS || edges.length < 3) return null;
  return { points, edges, bounds: bounds(points), winding: Math.sign(signedArea), rows };
}

/** Indexed ray crossing: a detailed river is never scanned in full by movement checks. */
function classify(p: WorldPoint, polygon: Polygon, rowOrigin: number, rowStep: number): -1 | 0 | 1 {
  if (!contains(polygon.bounds, p, EPS)) return -1;
  let inside = false;
  const row = Math.max(0, Math.floor((p.y - rowOrigin) / rowStep));
  for (const { a, b } of polygon.rows.get(row) ?? []) {
    if (pointSegmentSquared(p, a, b) <= EPS * EPS) return 0;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)) inside = !inside;
  }
  return inside ? 1 : -1;
}
function inPolygons(p: WorldPoint, polygons: Polygon[], data: Pick<Geometry, "rowOrigin" | "rowStep">) {
  return polygons.some(polygon => classify(p, polygon, data.rowOrigin, data.rowStep) >= 0);
}

function splitParameters(edge: Edge, other: Edge, values: number[]) {
  if (!overlaps(edge.bounds, other.bounds, EPS)) return;
  const { a, b } = edge, c = other.a, d = other.b, dx = b.x - a.x, dy = b.y - a.y;
  const ox = d.x - c.x, oy = d.y - c.y, denominator = cross(dx, dy, ox, oy);
  if (Math.abs(denominator) > EPS * EPS) {
    const t = cross(c.x - a.x, c.y - a.y, ox, oy) / denominator;
    const u = cross(c.x - a.x, c.y - a.y, dx, dy) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) values.push(t);
  } else if (pointSegmentSquared(c, a, b) <= EPS * EPS || pointSegmentSquared(d, a, b) <= EPS * EPS
    || pointSegmentSquared(a, c, d) <= EPS * EPS) {
    const square = dx * dx + dy * dy;
    for (const p of [c, d]) { const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / square; if (t > 0 && t < 1) values.push(t); }
  }
}

/** Split authored edges at intersections, then keep only the boundary of their union.
 * Internal overlap and shared-edge seams must never reduce an actor's clearance. */
function unionBoundary(areas: Polygon[], rowOrigin: number, rowStep: number, budget: PreparationBudget): Edge[] | null {
  const edges = areas.flatMap(polygon => polygon.edges), boundary: Edge[] = [];
  for (const edge of edges) {
    const values = [0, 1];
    for (const other of edges) {
      if (--budget.remaining < 0) return null;
      if (other !== edge) splitParameters(edge, other, values);
    }
    values.sort((a, b) => a - b);
    for (let i = 1; i < values.length; i++) {
      const a = lerp(edge.a, edge.b, values[i - 1]), b = lerp(edge.a, edge.b, values[i]);
      if (distance(a, b) <= EPS) continue;
      const middle = lerp(a, b, .5);
      let left = false, right = false;
      for (const polygon of areas) {
        const row = Math.max(0, Math.floor((middle.y - rowOrigin) / rowStep));
        budget.remaining -= 1 + (polygon.rows.get(row)?.length ?? 0) * 2;
        if (budget.remaining < 0) return null;
        const kind = classify(middle, polygon, rowOrigin, rowStep);
        if (kind > 0) { left = right = true; break; }
        if (kind < 0) continue;
        for (const other of polygon.rows.get(row) ?? []) {
          if (pointSegmentSquared(middle, other.a, other.b) > EPS * EPS) continue;
          const sameDirection = (b.x - a.x) * (other.b.x - other.a.x) + (b.y - a.y) * (other.b.y - other.a.y) > 0;
          if ((polygon.winding > 0) === sameDirection) left = true; else right = true;
        }
      }
      if (left !== right) boundary.push({ a, b, bounds: bounds([a, b]) });
      if (boundary.length > WORLD_NAVIGATION_LIMITS.geometryEdges) return null;
    }
  }
  return boundary;
}

function buildIndex(edges: Edge[], box: WorldBounds, step: number): SpatialIndex | null {
  const index: SpatialIndex = { bounds: box, step, columns: Math.max(1, Math.ceil(box.width / step)),
    rows: Math.max(1, Math.ceil(box.height / step)), buckets: new Map() };
  if (!Number.isFinite(index.columns * index.rows) || index.columns * index.rows > WORLD_NAVIGATION_LIMITS.cells) return null;
  let references = 0;
  for (const edge of edges) {
    if (!overlaps(edge.bounds, box, EPS)) continue;
    const loX = clamp(Math.floor((edge.bounds.x - box.x - EPS) / step), 0, index.columns - 1);
    const hiX = clamp(Math.floor((edge.bounds.x + edge.bounds.width - box.x + EPS) / step), 0, index.columns - 1);
    const loY = clamp(Math.floor((edge.bounds.y - box.y - EPS) / step), 0, index.rows - 1);
    const hiY = clamp(Math.floor((edge.bounds.y + edge.bounds.height - box.y + EPS) / step), 0, index.rows - 1);
    references += (hiX - loX + 1) * (hiY - loY + 1);
    if (references > WORLD_NAVIGATION_LIMITS.indexReferences) return null;
    for (let y = loY; y <= hiY; y++) for (let x = loX; x <= hiX; x++) {
      const id = y * index.columns + x, list = index.buckets.get(id) ?? [];
      list.push(edge); index.buckets.set(id, list);
    }
  }
  return index;
}
function nearbyEdges(index: SpatialIndex, query: WorldBounds, visit: (edge: Edge) => boolean) {
  if (!overlaps(index.bounds, query, EPS)) return true;
  const loX = clamp(Math.floor((query.x - index.bounds.x - EPS) / index.step), 0, index.columns - 1);
  const hiX = clamp(Math.floor((query.x + query.width - index.bounds.x + EPS) / index.step), 0, index.columns - 1);
  const loY = clamp(Math.floor((query.y - index.bounds.y - EPS) / index.step), 0, index.rows - 1);
  const hiY = clamp(Math.floor((query.y + query.height - index.bounds.y + EPS) / index.step), 0, index.rows - 1);
  const seen = new Set<Edge>();
  for (let y = loY; y <= hiY; y++) for (let x = loX; x <= hiX; x++) {
    for (const edge of index.buckets.get(y * index.columns + x) ?? []) {
      if (seen.has(edge) || !overlaps(edge.bounds, query, EPS)) continue;
      seen.add(edge); if (!visit(edge)) return false;
    }
  }
  return true;
}
function capsuleBounds(a: WorldPoint, b: WorldPoint, radius: number) {
  return { x: Math.min(a.x, b.x) - radius, y: Math.min(a.y, b.y) - radius,
    width: Math.abs(b.x - a.x) + radius * 2, height: Math.abs(b.y - a.y) + radius * 2 };
}

/** A scene is an immutable exported snapshot. A new scene object gets a new cache. */
export function createWorldNavigation(scene: FixedWorldScene, radius = (scene.actor?.size ?? 0) * .1): WorldNavigation | null {
  let profiles = cache.get(scene);
  if (!profiles) { profiles = new Map(); cache.set(scene, profiles); }
  if (profiles.has(radius)) return profiles.get(radius)!;
  const result = buildNavigation(scene, radius); profiles.set(radius, result); return result;
}
function buildNavigation(scene: FixedWorldScene, radius: number): WorldNavigation | null {
  const source = scene.navigation;
  if (!source || source.version !== 1 || !Number.isFinite(radius) || radius < 0 || !Number.isFinite(source.cellSize)
    || source.cellSize <= 0 || !Array.isArray(source.areas) || !source.areas.length || !Array.isArray(source.obstacles)) return null;
  if (source.areas.some(area => !Array.isArray(area.points) || area.points.length < 3 || !area.points.every(finite))) return null;
  const areaPoints = source.areas.flatMap(area => area.points);
  if (areaPoints.length > WORLD_NAVIGATION_LIMITS.areaEdges) return null;
  const box = bounds(areaPoints), cellSize = source.cellSize;
  const columns = Math.max(1, Math.ceil(box.width / cellSize)), rows = Math.max(1, Math.ceil(box.height / cellSize));
  if (!Number.isFinite(columns * rows) || columns * rows > WORLD_NAVIGATION_LIMITS.cells) return null;
  const rowStep = Math.max(24, cellSize * 4), rowOrigin = box.y;
  const rowCount = Math.max(1, Math.ceil(box.height / rowStep) + 1);
  const budget = { remaining: WORLD_NAVIGATION_LIMITS.preparationChecks as number };
  const rawBlockers = [...source.obstacles.map(item => item.points), ...scene.sites.map(site => site.collision),
    ...(scene.water?.surfaces.map(surface => surface.points) ?? [])];
  if (rawBlockers.some(points => !Array.isArray(points))
    || rawBlockers.reduce((sum, points) => sum + points.length, areaPoints.length) > WORLD_NAVIGATION_LIMITS.geometryEdges) return null;
  if (source.obstacles.some(item => item.points.length < 3)
    || scene.water?.surfaces.some(surface => surface.points.length < 3)) return null;
  const areas = source.areas.map(area => preparePolygon(area.points, rowOrigin, rowStep, rowCount, budget));
  // Existing sites legitimately have no collision. Invalid authored obstacles never become permission to walk.
  const blockers = rawBlockers.filter(points => points.length > 0).map(points => preparePolygon(points, rowOrigin, rowStep, rowCount, budget));
  if (areas.some(area => !area) || blockers.some(polygon => !polygon)) return null;
  const validAreas = areas as Polygon[], validBlockers = (blockers as Polygon[]).filter(polygon => overlaps(box, polygon.bounds, radius));
  const boundaryEdges = unionBoundary(validAreas, rowOrigin, rowStep, budget), blockerEdges = validBlockers.flatMap(polygon => polygon.edges);
  if (!boundaryEdges?.length) return null;
  const indexBounds = { x: box.x - radius, y: box.y - radius, width: box.width + radius * 2, height: box.height + radius * 2 };
  const boundary = buildIndex(boundaryEdges, indexBounds, rowStep), blocked = buildIndex(blockerEdges, indexBounds, rowStep);
  if (!boundary || !blocked) return null;
  const nav: WorldNavigation = { radius, cellSize, bounds: box,
    grid: { origin: { x: box.x + cellSize / 2, y: box.y + cellSize / 2 }, columns, rows, walkable: new Uint8Array(columns * rows) },
    debug: { boundary: boundaryEdges.map(({ a, b }) => ({ a: { ...a }, b: { ...b } })), blockers: validBlockers.map(polygon => polygon.points) },
    stats: { cells: columns * rows, walkableCells: 0, boundaryEdges: boundaryEdges.length, blockerEdges: blockerEdges.length, lastSearch: null } };
  geometry.set(nav, { areas: validAreas, blockers: validBlockers, boundary, blocked, rowOrigin, rowStep,
    edgeKnown: new Uint8Array(columns * rows), edgePass: new Uint8Array(columns * rows) });
  for (let id = 0; id < nav.grid.walkable.length; id++) {
    if (isWalkable(nav, gridPoint(nav, id))) { nav.grid.walkable[id] = 1; nav.stats.walkableCells++; }
  }
  return nav;
}

/** Tests the complete circular support, including concave boundaries and tiny obstacles. */
export function isWalkable(nav: WorldNavigation, point: WorldPoint): boolean {
  return canTraverse(nav, point, point);
}
/** The swept disk remains inside the WalkAreas union and outside all physical blockers.
 * Water exclusions are visual masks; they intentionally confer no walking permission. */
export function canTraverse(nav: WorldNavigation, a: WorldPoint, b: WorldPoint): boolean {
  const data = geometry.get(nav);
  if (!data || !finite(a) || !finite(b) || !contains(nav.bounds, a) || !contains(nav.bounds, b)
    || !inPolygons(a, data.areas, data) || !inPolygons(b, data.areas, data)
    || inPolygons(a, data.blockers, data) || inPolygons(b, data.blockers, data)) return false;
  const query = capsuleBounds(a, b, nav.radius);
  // A tiny conservative tolerance rejects boundary contact, including zero-radius crossings.
  const clearanceSquared = (nav.radius + EPS) ** 2;
  return nearbyEdges(data.boundary, query, edge => segmentSquared(a, b, edge.a, edge.b) > clearanceSquared)
    && nearbyEdges(data.blocked, query, edge => segmentSquared(a, b, edge.a, edge.b) > clearanceSquared);
}

function gridPoint(nav: WorldNavigation, id: number): WorldPoint {
  return { x: nav.grid.origin.x + id % nav.grid.columns * nav.cellSize,
    y: nav.grid.origin.y + Math.floor(id / nav.grid.columns) * nav.cellSize };
}
const neighbors = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]] as const;
const opposite = [2, 3, 0, 1, 6, 7, 4, 5];
type HeapEntry = { id: number; g: number; f: number };
function less(a: HeapEntry, b: HeapEntry) { return a.f < b.f || a.f === b.f && (a.g > b.g || a.g === b.g && a.id < b.id); }
function push(heap: HeapEntry[], entry: HeapEntry) {
  let index = heap.length; heap.push(entry);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!less(entry, heap[parent])) break;
    heap[index] = heap[parent]; index = parent;
  }
  heap[index] = entry;
}
function pop(heap: HeapEntry[]) {
  const first = heap[0], last = heap.pop()!;
  if (heap.length) {
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && less(heap[child + 1], heap[child])) child++;
      if (!less(heap[child], last)) break;
      heap[index] = heap[child]; index = child;
    }
    heap[index] = last;
  }
  return first;
}

/** Exact endpoints connect only through independently validated swept-circle segments. */
export function findWorldPath(nav: WorldNavigation, start: WorldPoint, end: WorldPoint): WorldPoint[] | null {
  const search = { reason: "no-path" as NavigationSearchReason, visited: 0, checks: 0, pathPoints: 0 };
  nav.stats.lastSearch = search;
  const check = (a: WorldPoint, b: WorldPoint) => { search.checks++; return canTraverse(nav, a, b); };
  const finish = (reason: NavigationSearchReason, path: WorldPoint[] | null) => {
    search.reason = reason; search.pathPoints = path?.length ?? 0; return path;
  };
  if (!check(start, start) || !check(end, end)) return finish("invalid-endpoint", null);
  if (check(start, end)) return finish("direct", [{ ...start }, { ...end }]);
  const data = geometry.get(nav)!, { columns, rows, walkable, origin } = nav.grid;
  const connectors = (point: WorldPoint) => {
    const result = new Map<number, number>();
    const cx = Math.round((point.x - origin.x) / nav.cellSize), cy = Math.round((point.y - origin.y) / nav.cellSize);
    for (let y = Math.max(0, cy - 2); y <= Math.min(rows - 1, cy + 2); y++) {
      for (let x = Math.max(0, cx - 2); x <= Math.min(columns - 1, cx + 2); x++) {
        const id = y * columns + x, candidate = gridPoint(nav, id);
        if (walkable[id] && check(point, candidate)) result.set(id, distance(point, candidate));
      }
    }
    return result;
  };
  const starts = connectors(start), ends = connectors(end);
  if (!starts.size || !ends.size) return finish("disconnected-endpoint", null);
  const costs = new Float64Array(walkable.length).fill(Infinity), parents = new Int32Array(walkable.length).fill(-1);
  const closed = new Uint8Array(walkable.length), heap: HeapEntry[] = [];
  for (const [id, g] of starts) { costs[id] = g; push(heap, { id, g, f: g + distance(gridPoint(nav, id), end) }); }
  let goal = -1, bestCost = Infinity;
  while (heap.length) {
    const current = pop(heap), id = current.id;
    if (current.g !== costs[id] || closed[id]) continue;
    if (current.f >= bestCost) break;
    if (search.visited >= WORLD_NAVIGATION_LIMITS.searchVisits || search.checks >= WORLD_NAVIGATION_LIMITS.searchChecks) return finish("search-limit", null);
    closed[id] = 1; search.visited++;
    const endCost = ends.get(id);
    if (endCost !== undefined && current.g + endCost < bestCost) { bestCost = current.g + endCost; goal = id; }
    const x = id % columns, y = Math.floor(id / columns), point = gridPoint(nav, id);
    for (let direction = 0; direction < neighbors.length; direction++) {
      const [dx, dy] = neighbors[direction], nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
      const next = ny * columns + nx;
      if (!walkable[next] || closed[next]) continue;
      // Both cardinal neighbours must be clear; the swept diagonal is checked as well.
      if (dx && dy && (!walkable[y * columns + nx] || !walkable[ny * columns + x])) continue;
      const target = gridPoint(nav, next), bit = 1 << direction;
      if (!(data.edgeKnown[id] & bit)) {
        const reverse = 1 << opposite[direction];
        data.edgeKnown[id] |= bit; data.edgeKnown[next] |= reverse;
        if (check(point, target)) { data.edgePass[id] |= bit; data.edgePass[next] |= reverse; }
      }
      if (!(data.edgePass[id] & bit)) continue;
      const g = current.g + nav.cellSize * (dx && dy ? Math.SQRT2 : 1);
      if (g >= costs[next]) continue;
      costs[next] = g; parents[next] = id; push(heap, { id: next, g, f: g + distance(target, end) });
    }
  }
  if (goal < 0) return finish("no-path", null);
  const reversed: WorldPoint[] = [];
  for (let id = goal; id >= 0; id = parents[id]) reversed.push(gridPoint(nav, id));
  const path = [{ ...start }, ...reversed.reverse(), { ...end }];
  const simplified = [path[0]];
  let anchor = 0, smoothingChecks = 0;
  while (anchor < path.length - 1) {
    let next = anchor + 1;
    for (let candidate = path.length - 1; candidate > anchor + 1; candidate--) {
      if (smoothingChecks++ >= WORLD_NAVIGATION_LIMITS.smoothingChecks) break;
      if (check(path[anchor], path[candidate])) { next = candidate; break; }
    }
    simplified.push(path[next]); anchor = next;
  }
  return finish("found", simplified);
}
