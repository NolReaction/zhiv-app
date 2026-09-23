import layout from "./forest-water-layout.json";
import { drawForestWaterImpact } from "./forest-rain";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

const TAU = Math.PI * 2;
export const FOREST_WATER_LIMITS = { currents: 38, impacts: 144 } as const;
type WaterOptions = { elapsed: number; rain: number; dusk: number; reducedMotion: boolean };
type WaterGeometry = { polygons: WorldPoint[][]; seeds: WorldPoint[]; scale: number };
const cache = new WeakMap<FixedWorldScene, WaterGeometry | null>();
const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const noise = (index: number) => { const n = Math.sin(index * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
const phase = (value: number) => value - Math.floor(value);

function inside(point: WorldPoint, polygons: WorldPoint[][]) {
  let result = false;
  for (const polygon of polygons) for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

/** The inspected shoreline includes holes for stones, reeds, lilies and the jetty.
 * A changed background revision requires a new mask; unknown maps never inherit these coordinates. */
function geometry(scene: FixedWorldScene): WaterGeometry | null {
  if (cache.has(scene)) return cache.get(scene)!;
  const terrain = scene.terrain.find(item => item.image === layout.image);
  if (!terrain || terrain.bounds.width <= 0 || terrain.bounds.height <= 0) { cache.set(scene, null); return null; }
  const { x, y, width, height } = terrain.bounds;
  const polygons = layout.polygons.map(polygon => polygon.map(([u, v]) => ({ x: x + u * width, y: y + v * height })));
  const scale = Math.min(width, height) / 1254;
  const seeds: WorldPoint[] = [];
  for (let i = 0; i < 6000 && seeds.length < FOREST_WATER_LIMITS.impacts; i++) {
    const point = { x: x + width * (.41 + noise(i * 2 + 1) * .59), y: y + height * (.565 + noise(i * 2 + 2) * .435) };
    if (!inside(point, polygons)) continue;
    if (!Array.from({ length: 12 }, (_, n) => ({ x: point.x + Math.cos(n * TAU / 12) * 11 * scale,
      y: point.y + Math.sin(n * TAU / 12) * 6 * scale })).every(p => inside(p, polygons))) continue;
    seeds.push(point);
  }
  const result = { polygons, seeds, scale }; cache.set(scene, result); return result;
}

export function isForestWater(scene: FixedWorldScene, point: WorldPoint) {
  const water = geometry(scene); return Boolean(water && inside(point, water.polygons));
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
  ctx.save(); ctx.beginPath();
  for (const polygon of water.polygons) {
    polygon.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath();
  }
  ctx.clip("evenodd");
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
