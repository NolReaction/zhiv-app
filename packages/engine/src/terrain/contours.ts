import type { Point } from "./layout.ts";
import { validateSceneSize, type SceneSize } from "../scene/contracts.ts";
import { CELL_SIZE, TERRAIN_CHUNK_SIZE, readTerrainMaterial, type TerrainPreview, type TerrainState } from "./terrain-data.ts";

export type WaterContour = { points: Point[]; lengths: number[]; length: number; normals: Point[] };
type EdgePoint = { id: string; point: Point };
type Segment = readonly [EdgePoint, EdgePoint];
type GridBounds = { x: number; y: number; width: number; height: number };
const GRID_CHUNK = TERRAIN_CHUNK_SIZE / CELL_SIZE;
const MIN_X = -8, MIN_Y = -8;

function marchingCell(x: number, y: number, field: (x: number, y: number) => number, step: number, offset: number): Segment[] {
  // Exact zero belongs to dry land; it must not create a four-way shared vertex.
  const value = [field(x, y), field(x + 1, y), field(x + 1, y + 1), field(x, y + 1)].map(v => v === 0 ? -1e-9 : v);
  const code = value.reduce((mask, v, i) => mask | (v > 0 ? 1 << i : 0), 0);
  if (code === 0 || code === 15) return [];
  const corners: Point[] = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
  const edgePairs = [[0, 1], [1, 2], [3, 2], [0, 3]];
  const ids = [`h:${x}:${y}`, `v:${x + 1}:${y}`, `h:${x}:${y + 1}`, `v:${x}:${y}`];
  const crossing = new Map<number, EdgePoint>();
  for (let edge = 0; edge < 4; edge++) {
    const [a, b] = edgePairs[edge];
    if ((value[a] > 0) === (value[b] > 0)) continue;
    const t = value[a] / (value[a] - value[b]);
    crossing.set(edge, { id: ids[edge], point: [(corners[a][0] + (corners[b][0] - corners[a][0]) * t) * step + offset,
      (corners[a][1] + (corners[b][1] - corners[a][1]) * t) * step + offset] });
  }
  if (crossing.size === 2) return [[...crossing.values()] as [EdgePoint, EdgePoint]];
  // The asymptotic decider uses the bilinear saddle, rather than its average.
  // A zero saddle keeps diagonally touching wet islands disconnected.
  const determinant = value[0] * value[2] - value[1] * value[3];
  const firstDiagonal = determinant > 0 || (determinant === 0 && code === 10);
  const pairs = firstDiagonal ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]];
  return pairs.map(([a, b]) => [crossing.get(a)!, crossing.get(b)!]);
}

function stitch(segments: readonly Segment[]): Point[][] {
  const neighbours = new Map<string, { point: Point; links: string[] }>();
  for (const [a, b] of segments) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const entry = neighbours.get(from.id);
      if (entry) entry.links.push(to.id); else neighbours.set(from.id, { point: from.point, links: [to.id] });
    }
  }
  const visited = new Set<string>(), loops: Point[][] = [];
  for (const [start, entry] of neighbours) {
    if (visited.has(start)) continue;
    const points: Point[] = [];
    let current = start, previous = "";
    while (!visited.has(current)) {
      visited.add(current);
      const node = neighbours.get(current)!;
      points.push(node.point);
      const next = node.links.find(id => id !== previous);
      if (!next) break;
      previous = current; current = next;
    }
    if (current === start && entry.links.length === 2 && points.length >= 3) loops.push(points);
  }
  return loops;
}

/** Public pure marching-squares extraction is useful for topology tests and tools. */
export function marchingSquares(field: (x: number, y: number) => number, bounds: GridBounds, step = 16): Point[][] {
  const segments: Segment[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) for (let x = bounds.x; x < bounds.x + bounds.width; x++) segments.push(...marchingCell(x, y, field, step, 0));
  return stitch(segments);
}

function smooth(points: readonly Point[]): Point[] {
  let result = [...points];
  for (let pass = 0; pass < 2; pass++) {
    const next: Point[] = [];
    for (let i = 0; i < result.length; i++) {
      const a = result[i], b = result[(i + 1) % result.length];
      next.push([a[0] * .75 + b[0] * .25, a[1] * .75 + b[1] * .25], [a[0] * .25 + b[0] * .75, a[1] * .25 + b[1] * .75]);
    }
    result = next;
  }
  return result;
}

function prepareContour(loop: Point[], sample: (x: number, y: number) => number): WaterContour {
  let points = smooth(loop);
  const a = points[0], b = points[1], length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / length, ny = (b[0] - a[0]) / length;
  if (sample((a[0] + b[0]) / 2 + nx, (a[1] + b[1]) / 2 + ny) < sample((a[0] + b[0]) / 2 - nx, (a[1] + b[1]) / 2 - ny)) points.reverse();
  let start = 0;
  for (let i = 1; i < points.length; i++) if (points[i][0] < points[start][0] || (points[i][0] === points[start][0] && points[i][1] < points[start][1])) start = i;
  points = [...points.slice(start), ...points.slice(0, start)];
  const lengths = [0], normals: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const previous = points[(i + points.length - 1) % points.length], next = points[(i + 1) % points.length];
    const dx = next[0] - previous[0], dy = next[1] - previous[1], size = Math.hypot(dx, dy) || 1;
    normals.push([-dy / size, dx / size]);
    lengths.push(lengths[i] + Math.hypot(next[0] - points[i][0], next[1] - points[i][1]));
  }
  return { points, normals, lengths, length: lengths.at(-1)! };
}

/** Base samples live for the painter lifetime; edits only rebuild affected 512px grids. */
export function createWaterContourCache(size: SceneSize, sampleWaterSignedDistance: (x: number, y: number) => number = () => -256) {
  if (!validateSceneSize(size)) throw new RangeError("Invalid terrain dimensions.");
  const MAX_X = Math.ceil(size.width / CELL_SIZE) + 8, MAX_Y = Math.ceil(size.height / CELL_SIZE) + 8;
  const base = new Map<string, number>(), chunks = new Map<string, { signature: string; segments: Segment[] }>();
  let lastCells: TerrainState["cells"] | undefined, lastPreview: TerrainPreview["cells"] | undefined;
  let versions = new Map<string, number>(), contours: WaterContour[] = [];
  let fieldBuilds = 0, contourBuilds = 0;
  const baseValue = (x: number, y: number) => {
    const key = `${x}:${y}`;
    let value = base.get(key);
    if (value === undefined) { value = Math.max(-1, Math.min(1, sampleWaterSignedDistance((x + .5) * CELL_SIZE, (y + .5) * CELL_SIZE) / CELL_SIZE)); base.set(key, value); }
    return value;
  };
  function read(state: TerrainState, preview?: TerrainPreview): readonly WaterContour[] {
    const dirty = new Set<string>();
    if (!chunks.size) {
      for (let y = Math.floor(MIN_Y / GRID_CHUNK); y <= Math.floor((MAX_Y - 1) / GRID_CHUNK); y++) for (let x = Math.floor(MIN_X / GRID_CHUNK); x <= Math.floor((MAX_X - 1) / GRID_CHUNK); x++) dirty.add(`${x}:${y}`);
    }
    if (lastCells !== state.cells) {
      const changed = new Set<string>();
      for (const [key, value] of Object.entries(lastCells ?? {})) if (state.cells[key] !== value) changed.add(key);
      for (const [key, value] of Object.entries(state.cells)) if (lastCells?.[key] !== value) changed.add(key);
      for (const key of changed) {
        const [x, y] = key.split(":").map(Number);
        for (const cy of [Math.floor((y - 1) / GRID_CHUNK), Math.floor(y / GRID_CHUNK)]) for (const cx of [Math.floor((x - 1) / GRID_CHUNK), Math.floor(x / GRID_CHUNK)]) dirty.add(`${cx}:${cy}`);
      }
      lastCells = state.cells;
    }
    const nextVersions = preview?.chunkVersions ?? new Map<string, number>();
    for (const key of new Set([...versions.keys(), ...nextVersions.keys()])) {
      if ((versions.get(key) ?? 0) !== (nextVersions.get(key) ?? 0) || (lastPreview !== preview?.cells && ((versions.get(key) ?? 0) || (nextVersions.get(key) ?? 0)))) dirty.add(key);
    }
    versions = new Map(nextVersions); lastPreview = preview?.cells;
    if (!dirty.size) return contours;
    const field = (x: number, y: number) => {
      if (x <= MIN_X || x >= MAX_X || y <= MIN_Y || y >= MAX_Y) return -1;
      const material = readTerrainMaterial((x + .5) * CELL_SIZE, (y + .5) * CELL_SIZE, state, preview);
      return material === "water" ? 1 : material ? -1 : baseValue(x, y);
    };
    let changed = false;
    for (const key of dirty) {
      const [tx, ty] = key.split(":").map(Number);
      const x0 = Math.max(MIN_X, tx * GRID_CHUNK), x1 = Math.min(MAX_X, (tx + 1) * GRID_CHUNK);
      const y0 = Math.max(MIN_Y, ty * GRID_CHUNK), y1 = Math.min(MAX_Y, (ty + 1) * GRID_CHUNK);
      if (x0 >= x1 || y0 >= y1) continue;
      const values: number[] = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) values.push(field(x, y));
      const signature = values.join(",");
      if (chunks.get(key)?.signature === signature) continue;
      const segments: Segment[] = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) segments.push(...marchingCell(x, y, field, CELL_SIZE, CELL_SIZE / 2));
      chunks.set(key, { signature, segments }); fieldBuilds++; changed = true;
    }
    if (changed) {
      const sample = (x: number, y: number) => {
        const gx = x / CELL_SIZE - .5, gy = y / CELL_SIZE - .5, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
        return field(ix, iy) * (1 - fx) * (1 - fy) + field(ix + 1, iy) * fx * (1 - fy) + field(ix + 1, iy + 1) * fx * fy + field(ix, iy + 1) * (1 - fx) * fy;
      };
      contours = stitch([...chunks.values()].flatMap(chunk => chunk.segments)).map(loop => prepareContour(loop, sample)); contourBuilds++;
    }
    return contours;
  }
  return { read, diagnostics: () => ({ fieldBuilds, contourBuilds, baseSamples: base.size }), dispose() { base.clear(); chunks.clear(); lastCells = undefined; lastPreview = undefined; versions.clear(); contours = []; } };
}
