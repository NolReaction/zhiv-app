import { previewPointInPolygon } from "@/features/world/tiled/preview-state";
import type { FixedWorldScene, WorldBounds, WorldPoint } from "@/features/world/tiled/types";

export const WATER_DYNAMICS_LIMITS = { side: 256, leaves: 10, fixedStep: 1 / 60, catchUpSteps: 4 } as const;
type Polygon = { points: WorldPoint[]; bounds: WorldBounds };
type Edge = { a: WorldPoint; b: WorldPoint };
export type WaterDynamicsGeometry = {
  columns: number; rows: number; cellSize: number; origin: WorldPoint; scale: number;
  mask: Uint8Array; active: Uint32Array; neighbours: Int32Array; shoreDistance: Uint16Array;
  surfaces: Polygon[]; exclusions: Polygon[]; edgeBins: Edge[][]; binColumns: number; binSize: number;
};
const cache = new WeakMap<FixedWorldScene, WaterDynamicsGeometry>();
const bounds = (points: WorldPoint[]): WorldBounds => {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) { left = Math.min(left, p.x); right = Math.max(right, p.x); top = Math.min(top, p.y); bottom = Math.max(bottom, p.y); }
  return { x: left, y: top, width: right - left, height: bottom - top };
};
const contains = (polygon: Polygon, point: WorldPoint) => point.x >= polygon.bounds.x && point.y >= polygon.bounds.y
  && point.x <= polygon.bounds.x + polygon.bounds.width && point.y <= polygon.bounds.y + polygon.bounds.height
  && previewPointInPolygon(point, polygon.points);

export function containsDynamicsWater(geometry: WaterDynamicsGeometry, point: WorldPoint) {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && geometry.surfaces.some(polygon => contains(polygon, point))
    && !geometry.exclusions.some(polygon => contains(polygon, point));
}

export function dynamicsCellAt(geometry: WaterDynamicsGeometry, point: WorldPoint) {
  const column = Math.floor((point.x - geometry.origin.x) / geometry.cellSize);
  const row = Math.floor((point.y - geometry.origin.y) / geometry.cellSize);
  return column >= 0 && row >= 0 && column < geometry.columns && row < geometry.rows ? row * geometry.columns + column : -1;
}

/** Rasterize each polygon independently: surface overlaps are unions and every
 * exclusion is subtracted, regardless of authoring winding or overlap. */
function rasterPolygon(geometry: WaterDynamicsGeometry, polygon: Polygon, value: number) {
  const { columns, rows, origin, cellSize, mask } = geometry;
  const first = Math.max(0, Math.ceil((polygon.bounds.y - origin.y) / cellSize - .5));
  const last = Math.min(rows - 1, Math.floor((polygon.bounds.y + polygon.bounds.height - origin.y) / cellSize - .5));
  const intersections: number[] = [];
  for (let row = first; row <= last; row++) {
    intersections.length = 0;
    const y = origin.y + (row + .5) * cellSize, points = polygon.points;
    for (let i = 0, previous = points.length - 1; i < points.length; previous = i++) {
      const a = points[previous], b = points[i];
      if ((a.y > y) !== (b.y > y)) intersections.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const start = Math.max(0, Math.ceil((intersections[i] - origin.x) / cellSize - .5));
      const end = Math.min(columns - 1, Math.ceil((intersections[i + 1] - origin.x) / cellSize - .5) - 1);
      if (end >= start) mask.fill(value, row * columns + start, row * columns + end + 1);
    }
    // Point-in-polygon includes boundaries. Exclusion edges must therefore stay
    // dry even when a horizontal edge or its far endpoint lands on a grid centre.
    if (value === 0) for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if (y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) continue;
      if (a.y === b.y) {
        const start = Math.max(0, Math.ceil((Math.min(a.x, b.x) - origin.x) / cellSize - .5));
        const end = Math.min(columns - 1, Math.floor((Math.max(a.x, b.x) - origin.x) / cellSize - .5));
        if (end >= start) mask.fill(0, row * columns + start, row * columns + end + 1);
      } else {
        const x = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
        const column = Math.round((x - origin.x) / cellSize - .5);
        if (column >= 0 && column < columns && Math.abs(origin.x + (column + .5) * cellSize - x) < 1e-7) mask[row * columns + column] = 0;
      }
    }
  }
}

/** Boundary bins are prepared once, so even tiny authored holes between grid
 * samples can block wave propagation and floating leaves without scanning the map. */
function unionEdges(surfaces: Polygon[], scale: number): Edge[] {
  const result: Edge[] = [];
  for (const polygon of surfaces) for (let i = 0; i < polygon.points.length; i++) {
    const a = polygon.points[i], b = polygon.points[(i + 1) % polygon.points.length];
    if (surfaces.length === 1) { result.push({ a, b }); continue; }
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (!length) continue;
    const cuts = [0, 1], point = (t: number) => ({ x: a.x + t * dx, y: a.y + t * dy });
    for (const other of surfaces) {
      if (other === polygon || Math.max(a.x, b.x) < other.bounds.x || Math.min(a.x, b.x) > other.bounds.x + other.bounds.width
        || Math.max(a.y, b.y) < other.bounds.y || Math.min(a.y, b.y) > other.bounds.y + other.bounds.height) continue;
      for (let j = 0; j < other.points.length; j++) {
        const c = other.points[j], d = other.points[(j + 1) % other.points.length];
        const ex = d.x - c.x, ey = d.y - c.y, determinant = dx * ey - dy * ex;
        if (Math.abs(determinant) > 1e-12) {
          const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / determinant;
          const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / determinant;
          if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
        } else if (Math.abs(dx * (c.y - a.y) - dy * (c.x - a.x)) < 1e-7) {
          for (const endpoint of [c, d]) {
            const t = ((endpoint.x - a.x) * dx + (endpoint.y - a.y) * dy) / (length * length);
            if (t > 0 && t < 1) cuts.push(t);
          }
        }
      }
    }
    cuts.sort((a, b) => a - b);
    for (let cut = 1; cut < cuts.length; cut++) {
      if (cuts[cut] - cuts[cut - 1] < 1e-10) continue;
      const center = point((cuts[cut] + cuts[cut - 1]) / 2), epsilon = Math.min(.0001 * scale, length * (cuts[cut] - cuts[cut - 1]) * .001);
      const first = { x: center.x - dy / length * epsilon, y: center.y + dx / length * epsilon };
      const second = { x: center.x + dy / length * epsilon, y: center.y - dx / length * epsilon };
      if (surfaces.some(surface => contains(surface, first)) && surfaces.some(surface => contains(surface, second))) continue;
      result.push({ a: point(cuts[cut - 1]), b: point(cuts[cut]) });
    }
  }
  return result;
}

function addEdges(geometry: WaterDynamicsGeometry) {
  const { origin, binSize, binColumns, edgeBins } = geometry;
  const edges = unionEdges(geometry.surfaces, geometry.scale);
  for (const polygon of geometry.exclusions) for (let i = 0; i < polygon.points.length; i++) {
    edges.push({ a: polygon.points[i], b: polygon.points[(i + 1) % polygon.points.length] });
  }
  for (const edge of edges) {
    const { a, b } = edge;
    const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - origin.x) / binSize));
    const x1 = Math.min(binColumns - 1, Math.floor((Math.max(a.x, b.x) - origin.x) / binSize));
    const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - origin.y) / binSize));
    const y1 = Math.min(Math.ceil(geometry.rows / 8) - 1, Math.floor((Math.max(a.y, b.y) - origin.y) / binSize));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) edgeBins[y * binColumns + x].push(edge);
  }
}

function edgesNear(geometry: WaterDynamicsGeometry, point: WorldPoint, radius: number, visitor: (edge: Edge) => boolean) {
  const { origin, binSize, binColumns, edgeBins } = geometry;
  const x0 = Math.max(0, Math.floor((point.x - radius - origin.x) / binSize));
  const x1 = Math.min(binColumns - 1, Math.floor((point.x + radius - origin.x) / binSize));
  const y0 = Math.max(0, Math.floor((point.y - radius - origin.y) / binSize));
  const y1 = Math.min(Math.ceil(geometry.rows / 8) - 1, Math.floor((point.y + radius - origin.y) / binSize));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    for (const edge of edgeBins[y * binColumns + x]) if (visitor(edge)) return true;
  }
  return false;
}

const cross = (a: WorldPoint, b: WorldPoint, c: WorldPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function touchesSegment(a: WorldPoint, b: WorldPoint, edge: Edge) {
  if (Math.max(a.x, b.x) < Math.min(edge.a.x, edge.b.x) || Math.min(a.x, b.x) > Math.max(edge.a.x, edge.b.x)
    || Math.max(a.y, b.y) < Math.min(edge.a.y, edge.b.y) || Math.min(a.y, b.y) > Math.max(edge.a.y, edge.b.y)) return false;
  return cross(a, b, edge.a) * cross(a, b, edge.b) <= 0 && cross(edge.a, edge.b, a) * cross(edge.a, edge.b, b) <= 0;
}

export function dynamicsPathIsWet(geometry: WaterDynamicsGeometry, a: WorldPoint, b: WorldPoint) {
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return !edgesNear(geometry, middle, Math.hypot(b.x - a.x, b.y - a.y) / 2 + 1e-6, edge => touchesSegment(a, b, edge));
}

export function dynamicsFootprintFits(geometry: WaterDynamicsGeometry, point: WorldPoint, radius: number) {
  if (!containsDynamicsWater(geometry, point)) return false;
  return !edgesNear(geometry, point, radius, ({ a, b }) => {
    const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
    const along = squared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0;
    return (point.x - a.x - along * dx) ** 2 + (point.y - a.y - along * dy) ** 2 <= radius * radius;
  });
}

function prepareNeighbours(geometry: WaterDynamicsGeometry) {
  const { columns, origin, cellSize, mask, neighbours, active, shoreDistance } = geometry;
  const queue = new Uint32Array(active.length); let head = 0, tail = 0;
  for (const index of active) {
    const point = { x: origin.x + (index % columns + .5) * cellSize, y: origin.y + (Math.floor(index / columns) + .5) * cellSize };
    let shore = false;
    for (let side = 0; side < 4; side++) {
      const dx = side === 0 ? -1 : side === 1 ? 1 : 0, dy = side === 2 ? -1 : side === 3 ? 1 : 0;
      const other = index + dx + dy * columns;
      const connected = mask[other] && dynamicsPathIsWet(geometry, point, { x: point.x + dx * cellSize, y: point.y + dy * cellSize });
      neighbours[index * 4 + side] = connected ? other : index;
      if (!connected) shore = true;
    }
    if (shore) { shoreDistance[index] = 1; queue[tail++] = index; }
  }
  while (head < tail) {
    const index = queue[head++];
    for (let side = 0; side < 4; side++) {
      const other = neighbours[index * 4 + side];
      if (!shoreDistance[other]) { shoreDistance[other] = shoreDistance[index] + 1; queue[tail++] = other; }
    }
  }
}

export function createDynamicsGeometry(scene: FixedWorldScene): WaterDynamicsGeometry {
  const previous = cache.get(scene); if (previous) return previous;
  const valid = (points: WorldPoint[]) => points.length >= 3 && points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  const prepare = ({ points }: { points: WorldPoint[] }) => ({ points, bounds: bounds(points) });
  const surfaces = (scene.water?.surfaces ?? []).filter(p => valid(p.points)).map(prepare);
  const exclusions = (scene.water?.exclusions ?? []).filter(p => valid(p.points)).map(prepare);
  const scale = Number.isFinite(scene.width) && Number.isFinite(scene.height) ? Math.max(.001, Math.min(scene.width, scene.height) / 1254) : 1;
  const box = surfaces.length ? bounds(surfaces.flatMap(p => p.points)) : { x: 0, y: 0, width: 0, height: 0 };
  const cellSize = Math.max(4 * scale, Math.max(box.width, box.height) / (WATER_DYNAMICS_LIMITS.side - 4));
  const columns = surfaces.length ? Math.ceil(box.width / cellSize) + 3 : 0, rows = surfaces.length ? Math.ceil(box.height / cellSize) + 3 : 0;
  const binColumns = Math.ceil(columns / 8), length = columns * rows;
  const result: WaterDynamicsGeometry = { columns, rows, cellSize, scale, origin: { x: box.x - cellSize, y: box.y - cellSize },
    mask: new Uint8Array(length), active: new Uint32Array(0), neighbours: new Int32Array(length * 4), shoreDistance: new Uint16Array(length),
    surfaces, exclusions, binSize: cellSize * 8, binColumns, edgeBins: Array.from({ length: binColumns * Math.ceil(rows / 8) }, () => []) };
  for (const polygon of surfaces) rasterPolygon(result, polygon, 1);
  for (const polygon of exclusions) rasterPolygon(result, polygon, 0);
  const wet: number[] = [];
  for (let index = 0; index < length; index++) if (result.mask[index]) wet.push(index);
  result.active = Uint32Array.from(wet);
  addEdges(result); prepareNeighbours(result); cache.set(scene, result); return result;
}
