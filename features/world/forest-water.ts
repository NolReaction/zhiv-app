import { drawForestWaterImpact, type ForestWaterImpact } from "./forest-rain";
import { previewPointInPolygon } from "./tiled/preview-state";
import type { FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";

export const FOREST_WATER_LIMITS = { currents: 38, impacts: 640 } as const;
type WaterOptions = { elapsed: number; rain: number; dusk: number; reducedMotion: boolean };
type WaterPolygon = { points: WorldPoint[]; bounds: WorldBounds };
type WaterEdge = { a: WorldPoint; b: WorldPoint; bounds: WorldBounds };
type WaterSeed = WorldPoint & { sizeScale: number };
type WaterCell = { key: number; points: WaterSeed[] };
type WaterGeometry = {
  surfaces: WaterPolygon[]; exclusions: WaterPolygon[]; edges: WaterEdge[];
  bounds: WorldBounds; scale: number;
  layout?: { cells: WaterCell[]; currents: WaterSeed[] };
};
const cache = new WeakMap<FixedWorldScene, WaterGeometry | null>();
const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const noise = (index: number) => { const n = Math.sin(index * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
const phase = (value: number) => value - Math.floor(value);

function polygonBounds(points: WorldPoint[]): WorldBounds {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
}

function contains(polygon: WaterPolygon, point: WorldPoint) {
  const { x, y, width, height } = polygon.bounds;
  return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height
    && previewPointInPolygon(point, polygon.points);
}

function inside(point: WorldPoint, water: WaterGeometry) {
  return water.surfaces.some(polygon => contains(polygon, point))
    && !water.exclusions.some(polygon => contains(polygon, point));
}

/** Tiled remains the sole authority; neither water outlines nor small exclusions are simplified. */
function geometry(scene: FixedWorldScene): WaterGeometry | null {
  if (cache.has(scene)) return cache.get(scene)!;
  if (!scene.water?.surfaces.length) { cache.set(scene, null); return null; }
  const prepare = ({ points }: { points: WorldPoint[] }) => ({ points, bounds: polygonBounds(points) });
  const surfaces = scene.water.surfaces.map(prepare), exclusions = scene.water.exclusions.map(prepare);
  const edges = [...surfaces, ...exclusions].flatMap(({ points }) => points.map((a, i) => {
    const b = points[(i + 1) % points.length]; return { a, b, bounds: polygonBounds([a, b]) };
  }));
  const result = { surfaces, exclusions, edges, bounds: polygonBounds(surfaces.flatMap(p => p.points)),
    scale: Math.min(scene.width, scene.height) / 1254 };
  cache.set(scene, result); return result;
}

export function isForestWater(scene: FixedWorldScene, point: WorldPoint) {
  const water = geometry(scene); return Boolean(water && inside(point, water));
}

/** Reject every edge that touches the complete animation footprint, including tiny
 * holes inside it. With the center inside water and no boundary crossing, the
 * entire ellipse is water. This replaces per-stroke clipping without a raster mask. */
function footprintFits(point: WaterSeed, water: WaterGeometry, edges: WaterEdge[]) {
  if (!inside(point, water)) return false;
  const rx = 11 * water.scale * point.sizeScale + .6, ry = 6 * water.scale * point.sizeScale + .6;
  for (const { a, b, bounds: box } of edges) {
    if (point.x + rx < box.x || point.x - rx > box.x + box.width
      || point.y + ry < box.y || point.y - ry > box.y + box.height) continue;
    const ax = (a.x - point.x) / rx, ay = (a.y - point.y) / ry;
    const dx = (b.x - a.x) / rx, dy = (b.y - a.y) / ry, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
    if ((ax + t * dx) ** 2 + (ay + t * dy) ** 2 <= 1) return false;
  }
  return true;
}

/** Spatial cells give the narrow tributary its own rain streams. A cached pool per
 * cell supplies a new location on each birth; particles never move during a ripple. */
function layout(water: WaterGeometry) {
  if (water.layout) return water.layout;
  const size = 36 * water.scale, { x, y, width, height } = water.bounds;
  const cells: WaterCell[] = [];
  for (let row = Math.floor(y / size); row <= Math.floor((y + height) / size); row++) {
    for (let column = Math.floor(x / size); column <= Math.floor((x + width) / size); column++) {
      const left = column * size, top = row * size, key = row * 65537 + column;
      const edges = water.edges.filter(({ bounds: b }) => b.x <= left + size + 12 * water.scale + 1
        && b.x + b.width >= left - 12 * water.scale - 1 && b.y <= top + size + 7 * water.scale + 1
        && b.y + b.height >= top - 7 * water.scale - 1);
      // With no nearby boundary, every point in this cell has the same membership.
      if (!edges.length && !inside({ x: left + size / 2, y: top + size / 2 }, water)) continue;
      const points: WaterSeed[] = [];
      for (const sizeScale of [1, .68]) {
        if (points.length >= 6) break;
        for (let attempt = 0; attempt < 80 && points.length < 17; attempt++) {
          const sample = attempt + (sizeScale === 1 ? 0 : 80);
          const point = { x: left + noise(key * 113 + sample * 2 + 1) * size,
            y: top + noise(key * 113 + sample * 2 + 2) * size, sizeScale };
          if (footprintFits(point, water, edges)) points.push(point);
        }
      }
      if (points.length) cells.push({ key, points });
    }
  }
  // Bound huge custom maps without preferring the first rows or one river arm.
  cells.sort((a, b) => noise(a.key + 7201) - noise(b.key + 7201));
  const bounded = cells.slice(0, FOREST_WATER_LIMITS.impacts / 2);
  const currents = bounded.slice(0, FOREST_WATER_LIMITS.currents).map(cell => cell.points[0]);
  water.layout = { cells: bounded, currents }; return water.layout;
}

/** Shared active time makes rain reproducible across cameras and pauses. Only a
 * completed ripple chooses another point; weather controls birth density. */
export function forestWaterFrame(scene: FixedWorldScene, options: WaterOptions) {
  const water = geometry(scene), rain = clamp(options.rain), dusk = clamp(options.dusk);
  const elapsed = options.reducedMotion || !Number.isFinite(options.elapsed) ? 0 : Math.max(0, options.elapsed);
  if (!water) return { currents: [], impacts: [] };
  const samples = layout(water);
  const currents = samples.currents.map((point, index) => {
    const age = phase(elapsed / (4.8 + noise(index + 81) * 4) + noise(index + 45)), scale = water.scale * point.sizeScale;
    return { x: point.x + (age - .5) * scale * 4, y: point.y + (age - .5) * scale,
      width: (3.5 + noise(index + 33) * 6) * scale, scale, phase: age,
      opacity: (.07 + Math.sin(age * Math.PI) ** 2 * .17) * (1 - dusk * .55) * (1 - rain * .6) };
  });
  const impacts: Array<ForestWaterImpact & { eventId: string }> = [];
  if (!options.reducedMotion && rain > .01) for (const cell of samples.cells) for (let slot = 0; slot < 2; slot++) {
    const stream = cell.key * 7 + slot * 571;
    const lifetime = 1.05 + noise(stream + 301) * .9, period = lifetime + .35 + noise(stream + 311) * .65;
    const clock = elapsed / period + noise(stream + 131), cycle = Math.floor(clock), age = phase(clock) * period / lifetime;
    if (age >= 1 || noise(stream + cycle * 101 + 991) >= rain) continue;
    const index = (cycle + slot * 7 + Math.floor(noise(stream + 411) * cell.points.length)) % cell.points.length;
    const point = cell.points[index], scale = water.scale * point.sizeScale;
    impacts.push({ x: point.x, y: point.y, eventId: `${cell.key}:${slot}:${cycle}`, phase: age,
      radiusX: (5.2 + noise(stream + cycle * 83 + 151) * 3.8) * scale,
      radiusY: (2.6 + noise(stream + cycle * 97 + 191) * 1.7) * scale,
      opacity: (.5 + rain * .32) * (1 - dusk * .5), dusk });
  }
  return { currents, impacts };
}

/** Complete footprints are checked once against exact Tiled edges. No repeated
 * full-map clip is needed for the hundreds of individual rain strokes. */
export function drawForestWater(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, options: WaterOptions) {
  const water = geometry(scene); if (!water) return;
  const transform = ctx.getTransform?.();
  if (transform && !transform.b && !transform.c) {
    const { x, y, width, height } = water.bounds;
    const x1 = x * transform.a + transform.e, x2 = (x + width) * transform.a + transform.e;
    const y1 = y * transform.d + transform.f, y2 = (y + height) * transform.d + transform.f;
    if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > ctx.canvas.width
      || Math.max(y1, y2) < 0 || Math.min(y1, y2) > ctx.canvas.height) return;
  }
  const visible = (point: WorldPoint, margin: number) => !transform || transform.b || transform.c
    || point.x * transform.a + transform.e >= -margin * Math.abs(transform.a)
      && point.x * transform.a + transform.e <= ctx.canvas.width + margin * Math.abs(transform.a)
      && point.y * transform.d + transform.f >= -margin * Math.abs(transform.d)
      && point.y * transform.d + transform.f <= ctx.canvas.height + margin * Math.abs(transform.d);
  const frame = forestWaterFrame(scene, options);
  ctx.save(); ctx.strokeStyle = "#b0e1dc"; ctx.lineCap = "round";
  for (const current of frame.currents) {
    if (!visible(current, 12 * water.scale)) continue;
    ctx.globalAlpha = current.opacity; ctx.lineWidth = .48 * current.scale;
    const x = current.x, y = current.y, w = current.width;
    ctx.beginPath(); ctx.moveTo(x - w / 2, y);
    ctx.bezierCurveTo(x - w * .2, y - current.scale * .75, x + w * .15, y + current.scale * .75, x + w / 2, y); ctx.stroke();
  }
  for (const impact of frame.impacts) if (visible(impact, 11 * water.scale)) drawForestWaterImpact(ctx, impact);
  ctx.restore();
}
