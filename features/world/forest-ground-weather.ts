import { forestAtmosphereState, type ForestAtmosphereOptions, type ForestAtmosphereState } from "./forest-atmosphere";
import { drawForestWaterImpact, type ForestWaterImpact } from "./forest-rain";
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
type GroundPuddle = GroundEllipse & { shape: number };
export type ForestGroundWeatherFrame = ForestAtmosphereState & {
  wetness: number;
  puddles: GroundPuddle[];
  rings: Array<ForestWaterImpact & { puddleIndex: number }>;
  impacts: ForestWaterImpact[];
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
  const frame: ForestGroundWeatherFrame = { ...state, wetness, puddles: [], rings: [], impacts: [] };
  const area = clearing(scene);
  if (!area) return frame;
  const seed = sceneSeed(scene.id), scale = clamp(scene.focus.width / 256, .35, 2);
  const accepted: Array<WorldPoint & { radius: number }> = [];
  const excluded = (point: WorldPoint, radius: number) => options.groundExclusions?.some(other =>
    Number.isFinite(other.x) && Number.isFinite(other.y)
    && Math.hypot(point.x - other.x, point.y - other.y) <= radius + Math.max(0, finite(other.radius)));
  for (let index = 0; wetness > .015 && index < 48 && frame.puddles.length < PUDDLE_LIMIT; index++) {
    const angle = noise(seed, index * 4 + 901) * TAU;
    const distance = .43 + noise(seed, index * 4 + 902) * .36;
    const point = { x: area.x + Math.cos(angle) * area.radiusX * distance,
      y: area.y + Math.sin(angle) * area.radiusY * distance };
    const radius = Math.min(scale * (5.5 + noise(seed, index * 4 + 903) * 3.4), area.radiusY * .26);
    if (!isForestGroundClear(scene, point, radius)) continue;
    if (accepted.some(other => Math.hypot(point.x - other.x, point.y - other.y) < radius + other.radius + scale * 2)) continue;
    if (excluded(point, radius)) continue;
    accepted.push({ ...point, radius });
    const growth = Math.sqrt(wetness);
    const puddle = { ...point, radiusX: radius * growth,
      radiusY: radius * growth * (.54 + noise(seed, index * 4 + 904) * .13),
      opacity: (.17 + wetness * .35) * (1 - state.dusk * .15), shape: noise(seed, index + 2001) * TAU };
    const puddleIndex = frame.puddles.length;
    frame.puddles.push(puddle);
    if (state.rain <= .01 || options.reducedMotion) continue;
    const count = state.rain > .55 ? 2 : 1;
    for (let ring = 0; ring < count; ring++) {
      const clock = state.elapsed * (.52 + state.rain * .57) + noise(seed, index + ring * 53 + 1301);
      const cycle = Math.floor(clock), phase = clock % 1;
      const offset = noise(seed, cycle * 19 + index * 7 + ring + 1501);
      frame.rings.push({ x: point.x + (offset - .5) * puddle.radiusX * .66,
        y: point.y + (noise(seed, cycle * 11 + index + ring * 43 + 1551) - .5) * puddle.radiusY * .45,
        radiusX: puddle.radiusX * .45, radiusY: puddle.radiusY * .45,
        phase, opacity: (.35 + state.rain * .5) * growth, dusk: state.dusk, puddleIndex });
    }
  }
  // Small irregular impacts appear as soon as rain begins, before standing water gathers.
  // Every transient footprint uses the same conservative ground/exclusion checks as puddles.
  if (!options.reducedMotion && state.rain > .01) for (let slot = 0; slot < 12; slot++) {
    const clock = state.elapsed * (.34 + state.rain * .68) + noise(seed, slot + 2501) * 8;
    const cycle = Math.floor(clock), phase = (clock % 1) / .48;
    if (phase >= 1 || slot >= Math.ceil(12 * state.rain)) continue;
    const angle = noise(seed, cycle * 43 + slot * 11 + 2601) * TAU;
    const distance = Math.sqrt(noise(seed, cycle * 41 + slot * 13 + 2701)) * .78;
    const point = { x: area.x + Math.cos(angle) * area.radiusX * distance,
      y: area.y + Math.sin(angle) * area.radiusY * distance };
    const radius = scale * (1.25 + noise(seed, slot + 2801) * .75);
    if (!isForestGroundClear(scene, point, radius) || excluded(point, radius)
      || accepted.some(other => Math.hypot(point.x - other.x, point.y - other.y) < radius + other.radius)) continue;
    frame.impacts.push({ ...point, radiusX: radius, radiusY: radius * .5, phase,
      opacity: (.18 + state.rain * .3) * (1 - state.dusk * .2), dusk: state.dusk });
  }
  return frame;
}

function puddleShape(ctx: CanvasRenderingContext2D, puddle: GroundPuddle, inset = 1) {
  const points: WorldPoint[] = [];
  for (let i = 0; i < 12; i++) {
    const angle = i / 12 * TAU;
    const radius = .82 + Math.sin(angle * 3 + puddle.shape) * .085
      + Math.cos(angle * 5 - puddle.shape * 2) * .055;
    points.push({ x: puddle.x + Math.cos(angle) * radius * puddle.radiusX * inset,
      y: puddle.y + Math.sin(angle) * radius * puddle.radiusY * inset });
  }
  ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < points.length; i++) {
    const a = points[(i + 11) % 12], b = points[i], c = points[(i + 1) % 12], d = points[(i + 2) % 12];
    ctx.bezierCurveTo(b.x + (c.x - a.x) / 6, b.y + (c.y - a.y) / 6,
      c.x - (d.x - b.x) / 6, c.y - (d.y - b.y) / 6, c.x, c.y);
  }
  ctx.closePath();
}

/** Paint after terrain and before sites/actors, so weather cannot cover their artwork. */
export function drawForestGroundWeather(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, options: ForestGroundWeatherOptions) {
  const frame = forestGroundWeatherFrame(scene, options);
  if (!frame.puddles.length && !frame.impacts.length) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, scene.width, scene.height); ctx.clip();
  for (let index = 0; index < frame.puddles.length; index++) {
    const puddle = frame.puddles[index], rx = puddle.radiusX, ry = puddle.radiusY;
    // The broad damp edge stays inside the collision-checked footprint.
    ctx.fillStyle = "#3d4930"; ctx.globalAlpha = puddle.opacity * .4;
    puddleShape(ctx, puddle); ctx.fill();
    ctx.fillStyle = "#4a5e47"; ctx.globalAlpha = puddle.opacity * .63;
    puddleShape(ctx, puddle, .93); ctx.fill();
    const reflection = ctx.createRadialGradient(puddle.x - rx * .25, puddle.y - ry * .48, 0,
      puddle.x, puddle.y, rx);
    reflection.addColorStop(0, frame.dusk > .5 ? "#709898" : "#adc8be");
    reflection.addColorStop(.5, "#709b94"); reflection.addColorStop(1, "#385f55");
    ctx.fillStyle = reflection; ctx.globalAlpha = puddle.opacity;
    puddleShape(ctx, puddle, .84); ctx.fill();
    ctx.save(); puddleShape(ctx, puddle, .83); ctx.clip();
    // Broken reflections of nearby canopy retain the hand-painted terrain underneath.
    ctx.globalAlpha = puddle.opacity * .33; ctx.fillStyle = "#264c38";
    ctx.beginPath(); ctx.moveTo(puddle.x - rx, puddle.y + ry * .35);
    ctx.bezierCurveTo(puddle.x - rx * .6, puddle.y - ry * .52,
      puddle.x - rx * .48, puddle.y + ry * .38, puddle.x - rx * .15, puddle.y + ry * .05);
    ctx.bezierCurveTo(puddle.x + rx * .13, puddle.y - ry * .42,
      puddle.x + rx * .32, puddle.y + ry * .35, puddle.x + rx, puddle.y - ry * .18);
    ctx.lineTo(puddle.x + rx, puddle.y + ry); ctx.lineTo(puddle.x - rx, puddle.y + ry); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#d4dfc6"; ctx.lineWidth = clamp(rx * .055, .18, .5);
    ctx.globalAlpha = puddle.opacity * .62;
    ctx.beginPath(); ctx.moveTo(puddle.x - rx * .45, puddle.y - ry * .42);
    ctx.bezierCurveTo(puddle.x - rx * .22, puddle.y - ry * .59,
      puddle.x + rx * .01, puddle.y - ry * .5, puddle.x + rx * .19, puddle.y - ry * .52); ctx.stroke();
    ctx.globalAlpha *= .6;
    ctx.beginPath(); ctx.moveTo(puddle.x + rx * .22, puddle.y + ry * .43);
    ctx.lineTo(puddle.x + rx * .49, puddle.y + ry * .36); ctx.stroke();
    for (const ring of frame.rings) if (ring.puddleIndex === index) drawForestWaterImpact(ctx, ring);
    ctx.restore();
  }
  for (const impact of frame.impacts) drawForestWaterImpact(ctx, impact);
  ctx.restore();
}
