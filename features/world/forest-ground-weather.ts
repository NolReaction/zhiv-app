import { forestAtmosphereState, type ForestAtmosphereOptions, type ForestAtmosphereState } from "./forest-atmosphere";
import type { FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";

const TAU = Math.PI * 2;
const PUDDLE_LIMIT = 4;
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const finite = (value: number) => Number.isFinite(value) ? value : 0;

export type ForestGroundExclusion = WorldPoint & { radius: number };
export type ForestGroundWeatherOptions = ForestAtmosphereOptions & {
  /** Renderer-owned moisture persists when the rain stops. An uninitialized scene is dry. */
  wetness?: number;
  groundExclusions?: ForestGroundExclusion[];
};

type GroundEllipse = WorldPoint & { radiusX: number; radiusY: number; opacity: number };
export type ForestGroundWeatherFrame = ForestAtmosphereState & {
  wetness: number;
  puddles: GroundEllipse[];
  rings: GroundEllipse[];
};

/** Rain gathers in seconds and dries much more slowly; dt is active scene time only. */
export function updateForestWetness(previous: number, rain: number, dt: number): number {
  const current = clamp(finite(previous)), target = clamp(finite(rain));
  const seconds = Math.max(0, finite(dt));
  const duration = target > current ? 18 : 75;
  return clamp(current + (target - current) * -Math.expm1(-seconds / duration));
}

function clearing(scene: FixedWorldScene) {
  const actor = scene.actor;
  if (!actor || ![actor.spawn.x, actor.spawn.y, actor.size, scene.focus.width, scene.width, scene.height].every(Number.isFinite)
    || actor.size <= 0 || scene.focus.width <= 0 || scene.width <= 0 || scene.height <= 0) return null;
  // The authored spawn is the only known open ground. Nothing infers safety from empty map data.
  const radiusX = Math.min(actor.size * .8, scene.focus.width * .145);
  return { ...actor.spawn, radiusX, radiusY: radiusX * .7 };
}

function segmentDistance(point: WorldPoint, a: WorldPoint, b: WorldPoint) {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length) : 0;
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

function touchesBounds(point: WorldPoint, radius: number, bounds: WorldBounds) {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width < 0 || bounds.height < 0) return true;
  return Math.hypot(point.x - clamp(point.x, bounds.x, bounds.x + bounds.width),
    point.y - clamp(point.y, bounds.y, bounds.y + bounds.height)) <= radius;
}

function touchesPolygon(point: WorldPoint, radius: number, polygon: WorldPoint[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return true;
    if (segmentDistance(point, a, b) <= radius) return true;
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Conservative whole-footprint test for the small clearing around the authored spawn. */
export function isForestGroundClear(scene: FixedWorldScene, point: WorldPoint, radius: number): boolean {
  const area = clearing(scene);
  if (!area || ![point.x, point.y, radius].every(Number.isFinite) || radius < 0) return false;
  if (point.x - radius < 0 || point.y - radius < 0
    || point.x + radius > scene.width || point.y + radius > scene.height) return false;
  // The scaled-circle bound includes every point of the footprint, including its diagonal edges.
  if (Math.hypot((point.x - area.x) / area.radiusX, (point.y - area.y) / area.radiusY)
    + radius / Math.min(area.radiusX, area.radiusY) > 1) return false;
  for (const site of scene.sites) {
    if (touchesBounds(point, radius, site.bounds) || touchesPolygon(point, radius, site.collision)) return false;
  }
  const routeMargin = Math.max(1, (scene.actor?.size ?? 0) * .06);
  for (const path of scene.paths) {
    if (path.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
    for (let i = 0; i < path.points.length; i++) {
      if (segmentDistance(point, path.points[i], path.points[Math.max(0, i - 1)]) <= radius + routeMargin) return false;
    }
  }
  return true;
}

function sceneSeed(id: string) {
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  return seed >>> 0;
}

function noise(seed: number, index: number) {
  let value = (seed + Math.imul(index + 1, 0x9e3779b9)) | 0;
  value = Math.imul(value ^ value >>> 16, 0x21f0aaad);
  value = Math.imul(value ^ value >>> 15, 0x735a2d97);
  return ((value ^ value >>> 15) >>> 0) / 4294967296;
}

/** Stable puddle locations, changing only in size/opacity as retained moisture changes. */
export function forestGroundWeatherFrame(scene: FixedWorldScene, options: ForestGroundWeatherOptions): ForestGroundWeatherFrame {
  const state = forestAtmosphereState(scene, options), wetness = clamp(finite(options.wetness ?? 0));
  const frame: ForestGroundWeatherFrame = { ...state, wetness, puddles: [], rings: [] };
  const area = clearing(scene);
  if (!area || wetness <= .015) return frame;
  const seed = sceneSeed(scene.id), scale = clamp(scene.focus.width / 256, .35, 2);
  const accepted: Array<WorldPoint & { radius: number }> = [];
  for (let index = 0; index < 48 && frame.puddles.length < PUDDLE_LIMIT; index++) {
    const angle = noise(seed, index * 4 + 901) * TAU;
    const distance = .43 + noise(seed, index * 4 + 902) * .36;
    const point = { x: area.x + Math.cos(angle) * area.radiusX * distance,
      y: area.y + Math.sin(angle) * area.radiusY * distance };
    const radius = Math.min(scale * (4.5 + noise(seed, index * 4 + 903) * 2.7), area.radiusY * .22);
    if (!isForestGroundClear(scene, point, radius)) continue;
    if (accepted.some(other => Math.hypot(point.x - other.x, point.y - other.y) < radius + other.radius + scale * 2)) continue;
    if (options.groundExclusions?.some(other => Number.isFinite(other.x) && Number.isFinite(other.y)
      && Math.hypot(point.x - other.x, point.y - other.y) <= radius + Math.max(0, finite(other.radius)))) continue;
    accepted.push({ ...point, radius });
    const growth = Math.sqrt(wetness);
    const puddle = { ...point, radiusX: radius * growth,
      radiusY: radius * growth * (.54 + noise(seed, index * 4 + 904) * .13),
      opacity: (.12 + wetness * .23) * (1 - state.dusk * .2) };
    frame.puddles.push(puddle);
    if (state.rain <= .01) continue;
    const count = state.rain > .55 ? 2 : 1;
    for (let ring = 0; ring < count; ring++) {
      const phase = (state.elapsed * (.65 + state.rain * .35) + noise(seed, index + ring * 53 + 1301)) % 1;
      frame.rings.push({ x: point.x + (ring ? .18 : -.14) * puddle.radiusX, y: point.y,
        radiusX: puddle.radiusX * (.12 + phase * .48),
        radiusY: puddle.radiusY * (.12 + phase * .48),
        opacity: state.rain * growth * Math.sin(phase * Math.PI) * .26 });
    }
  }
  return frame;
}

function puddleShape(ctx: CanvasRenderingContext2D, puddle: GroundEllipse, inset = 1) {
  const x = puddle.x, y = puddle.y, rx = puddle.radiusX * inset, ry = puddle.radiusY * inset;
  ctx.beginPath(); ctx.moveTo(x - rx * .94, y + ry * .05);
  ctx.bezierCurveTo(x - rx, y - ry * .54, x - rx * .25, y - ry, x + rx * .18, y - ry * .76);
  ctx.bezierCurveTo(x + rx * .48, y - ry * .92, x + rx, y - ry * .4, x + rx * .91, y + ry * .12);
  ctx.bezierCurveTo(x + rx * .8, y + ry * .8, x + rx * .2, y + ry, x - rx * .11, y + ry * .79);
  ctx.bezierCurveTo(x - rx * .58, y + ry * .98, x - rx, y + ry * .5, x - rx * .94, y + ry * .05);
  ctx.closePath(); ctx.fill();
}

/** Paint after terrain and before sites/actors, so weather cannot cover their artwork. */
export function drawForestGroundWeather(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, options: ForestGroundWeatherOptions) {
  const frame = forestGroundWeatherFrame(scene, options);
  if (!frame.puddles.length) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, scene.width, scene.height); ctx.clip();
  for (const puddle of frame.puddles) {
    ctx.fillStyle = "#736c4c"; ctx.globalAlpha = puddle.opacity * .85;
    puddleShape(ctx, puddle);
    ctx.fillStyle = "#709794"; ctx.globalAlpha = puddle.opacity;
    puddleShape(ctx, puddle, .88);
    ctx.fillStyle = "#c7d8ce"; ctx.globalAlpha = puddle.opacity * .55;
    ctx.beginPath(); ctx.ellipse(puddle.x - puddle.radiusX * .08, puddle.y - puddle.radiusY * .18,
      puddle.radiusX * .64, puddle.radiusY * .28, 0, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = "#d3e0d5"; ctx.lineWidth = clamp(scene.focus.width / 256, .35, 2) * .55;
  for (const ring of frame.rings) {
    ctx.globalAlpha = ring.opacity;
    ctx.beginPath(); ctx.ellipse(ring.x, ring.y, ring.radiusX, ring.radiusY, 0, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}
