import { drawForestWaterImpact } from "./forest-rain";
import { previewPointInPolygon } from "./tiled/preview-state";
import type { FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";

const TAU = Math.PI * 2;
export const FOREST_WATER_LIMITS = { currents: 38, impacts: 144 } as const;
type WaterOptions = { elapsed: number; rain: number; dusk: number; reducedMotion: boolean };
type WaterPolygon = { points: WorldPoint[]; bounds: WorldBounds };
type WaterGeometry = {
  surfaces: WaterPolygon[];
  exclusions: WaterPolygon[];
  exclusionBatches: WaterPolygon[][];
  seeds: WorldPoint[];
  scale: number;
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

function inside(point: WorldPoint, water: Pick<WaterGeometry, "surfaces" | "exclusions">) {
  return water.surfaces.some(polygon => contains(polygon, point))
    && !water.exclusions.some(polygon => contains(polygon, point));
}

/** Uniform winding makes overlapping surfaces a union under the nonzero fill rule. */
function preparePolygon(points: WorldPoint[]): WaterPolygon {
  const area = points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y;
  }, 0);
  return { points: area < 0 ? [...points].reverse() : points, bounds: polygonBounds(points) };
}

/** Disjoint exclusions can share a clip. Overlapping exclusions go in separate clips
 * so their intersection stays dry, unlike a single even-odd path. */
function exclusionBatches(polygons: WaterPolygon[]): WaterPolygon[][] {
  const batches: WaterPolygon[][] = [];
  for (const polygon of polygons) {
    const a = polygon.bounds;
    const batch = batches.find(items => items.every(({ bounds: b }) =>
      a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y));
    if (batch) batch.push(polygon); else batches.push([polygon]);
  }
  return batches;
}

/** Tiled coordinates are authoritative, including nested WaterExclusions layers.
 * Scenes without authored water never inherit coordinates from another map. */
function geometry(scene: FixedWorldScene): WaterGeometry | null {
  if (cache.has(scene)) return cache.get(scene)!;
  if (!scene.water?.surfaces.length) { cache.set(scene, null); return null; }
  const surfaces = scene.water.surfaces.map(polygon => preparePolygon(polygon.points));
  const exclusions = scene.water.exclusions.map(polygon => preparePolygon(polygon.points));
  const { x, y, width, height } = polygonBounds(surfaces.flatMap(polygon => polygon.points));
  const scale = Math.min(scene.width, scene.height) / 1254;
  const seeds: WorldPoint[] = [];
  const water = { surfaces, exclusions };
  for (let i = 0; i < 6000 && seeds.length < FOREST_WATER_LIMITS.impacts; i++) {
    const point = { x: x + width * noise(i * 2 + 1), y: y + height * noise(i * 2 + 2) };
    if (!inside(point, water)) continue;
    if (!Array.from({ length: 12 }, (_, n) => ({ x: point.x + Math.cos(n * TAU / 12) * 11 * scale,
      y: point.y + Math.sin(n * TAU / 12) * 6 * scale })).every(p => inside(p, water))) continue;
    seeds.push(point);
  }
  const result = { ...water, exclusionBatches: exclusionBatches(exclusions), seeds, scale };
  cache.set(scene, result); return result;
}

export function isForestWater(scene: FixedWorldScene, point: WorldPoint) {
  const water = geometry(scene); return Boolean(water && inside(point, water));
}

/** Camera-independent particles use the same paused clock as the rest of the forest. */
export function forestWaterFrame(scene: FixedWorldScene, options: WaterOptions) {
  const water = geometry(scene), rain = clamp(options.rain), dusk = clamp(options.dusk);
  const elapsed = options.reducedMotion || !Number.isFinite(options.elapsed) ? 0 : Math.max(0, options.elapsed);
  if (!water) return { currents: [], impacts: [] };
  const currents = water.seeds.slice(0, FOREST_WATER_LIMITS.currents).map((point, index) => {
    const age = phase(elapsed / (4.8 + noise(index + 81) * 4) + noise(index + 45));
    return { x: point.x + (age - .5) * water.scale * 4, y: point.y + (age - .5) * water.scale,
      width: (3.5 + noise(index + 33) * 6) * water.scale, phase: age,
      opacity: (.07 + Math.sin(age * Math.PI) ** 2 * .17) * (1 - dusk * .55) * (1 - rain * .6) };
  });
  const count = options.reducedMotion || rain <= .01 ? 0 : Math.ceil(rain * FOREST_WATER_LIMITS.impacts);
  const impacts = water.seeds.slice(0, count).map((point, index) => ({ ...point,
    phase: phase(elapsed / (1.05 + noise(index + 301) * .9) + noise(index + 131)),
    radiusX: (5.2 + noise(index + 151) * 3.8) * water.scale,
    radiusY: (2.6 + noise(index + 191) * 1.7) * water.scale,
    opacity: (.5 + rain * .32) * (1 - dusk * .5), dusk }));
  return { currents, impacts };
}

/** Subtle current glints preserve the painted water; every effect is clipped to open water. */
export function drawForestWater(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, options: WaterOptions) {
  const water = geometry(scene); if (!water) return;
  const transform = ctx.getTransform?.();
  const visible = (point: WorldPoint, margin: number) => !transform || transform.b || transform.c
    || point.x * transform.a + transform.e >= -margin * Math.abs(transform.a)
      && point.x * transform.a + transform.e <= ctx.canvas.width + margin * Math.abs(transform.a)
      && point.y * transform.d + transform.f >= -margin * Math.abs(transform.d)
      && point.y * transform.d + transform.f <= ctx.canvas.height + margin * Math.abs(transform.d);
  // A circular clearing view has no visible river: avoid sampling and painting all its ripples.
  if (!water.seeds.some(point => visible(point, 12 * water.scale))) return;
  const frame = forestWaterFrame(scene, options);
  const trace = (polygon: WaterPolygon) => {
    polygon.points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath();
  };
  ctx.save(); ctx.beginPath();
  water.surfaces.forEach(trace);
  ctx.clip();
  for (const batch of water.exclusionBatches) {
    ctx.beginPath(); ctx.rect(0, 0, scene.width, scene.height);
    batch.forEach(trace); ctx.clip("evenodd");
  }
  ctx.lineWidth = .48 * water.scale; ctx.strokeStyle = "#b0e1dc"; ctx.lineCap = "round";
  for (const current of frame.currents) {
    if (!visible(current, 12 * water.scale)) continue;
    ctx.globalAlpha = current.opacity;
    const x = current.x, y = current.y, w = current.width;
    ctx.beginPath(); ctx.moveTo(x - w / 2, y);
    ctx.bezierCurveTo(x - w * .2, y - water.scale * .75, x + w * .15, y + water.scale * .75, x + w / 2, y); ctx.stroke();
  }
  for (const impact of frame.impacts) if (visible(impact, 11 * water.scale)) drawForestWaterImpact(ctx, impact);
  ctx.restore();
}
