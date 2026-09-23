import layout from "./forest-ground-layout.json";
import type { ForestGroundExclusion } from "./forest-ground-weather";
import { previewPointInPolygon } from "./tiled/preview-state";
import type { FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";

const TAU = Math.PI * 2;
const CELLS_PER_PATCH = 8;
const FOOTPRINT = 3.2;
const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const noise = (seed: number) => {
  let value = Math.imul(seed ^ seed >>> 16, 0x21f0aaad);
  value = Math.imul(value ^ value >>> 15, 0x735a2d97);
  return ((value ^ value >>> 15) >>> 0) / 4294967296;
};

export type ForestGroundImpact = WorldPoint & {
  size: number; phase: number; opacity: number; variant: number; seed: number;
};
export type ForestGroundImpactOptions = {
  elapsed: number; rain: number; dusk: number; reducedMotion: boolean;
  groundExclusions?: ForestGroundExclusion[];
};
type GroundPatch = { id: number; cells: WorldPoint[]; bounds: WorldBounds };
type GroundLayout = { bounds: WorldBounds; cellWidth: number; cellHeight: number;
  scale: number; accepted: Set<number>; patches: GroundPatch[] };
const cache = new WeakMap<FixedWorldScene, GroundLayout | null>();

function overlaps(a: WorldBounds, b: WorldBounds) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x
    && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

function polygonBounds(points: WorldPoint[]): WorldBounds {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x,
    height: Math.max(...points.map(p => p.y)) - y };
}

function touchesPolygon(point: WorldPoint, radius: number, polygon: WorldPoint[]) {
  if (previewPointInPolygon(point, polygon)) return true;
  return polygon.some((a, index) => {
    const b = polygon[(index + 1) % polygon.length], dx = b.x - a.x, dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length) : 0;
    return Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t) <= radius;
  });
}

/** Conservative cells from the reviewed terrain artwork, not “anything outside water”.
 * The source mask selects connected yellow/olive grass and soil, removes small leaf
 * islands, erodes seven source pixels, then accepts only fully covered 10px cells.
 * The wooden pier is excluded explicitly. The exact image revision gates this data;
 * new artwork cannot silently reuse old ground coordinates. Tiled remains untouched. */
function groundLayout(scene: FixedWorldScene): GroundLayout | null {
  if (cache.has(scene)) return cache.get(scene)!;
  const terrain = scene.terrain.find(item => item.image === layout.image);
  if (!terrain || ![terrain.bounds.x, terrain.bounds.y, terrain.bounds.width, terrain.bounds.height].every(Number.isFinite)
    || terrain.bounds.width <= 0 || terrain.bounds.height <= 0) {
    cache.set(scene, null); return null;
  }
  const bounds = terrain.bounds, cellWidth = bounds.width / layout.resolution,
    cellHeight = bounds.height / layout.resolution, scale = Math.min(bounds.width, bounds.height) / 1254;
  // The entire authored water surface is forbidden, including lilies/rocks inside
  // its exclusions. Dry objects in water do not become open ground automatically.
  const forbidden = [...(scene.water?.surfaces ?? []), ...(scene.water?.exclusions ?? []),
    ...scene.sites.map(site => ({ points: site.collision }))]
    .filter(polygon => polygon.points.length >= 3)
    .map(polygon => ({ ...polygon, bounds: polygonBounds(polygon.points) }));
  const accepted = new Set<number>(), patches = new Map<number, GroundPatch>();
  const margin = FOOTPRINT * scale, radius = Math.hypot(cellWidth, cellHeight) / 2 + margin;
  layout.rows.forEach((runs, row) => {
    for (let run = 0; run < runs.length; run += 2) for (let column = runs[run]; column < runs[run + 1]; column++) {
      const cell = { x: bounds.x + column * cellWidth, y: bounds.y + row * cellHeight };
      const expanded = { x: cell.x - margin, y: cell.y - margin,
        width: cellWidth + margin * 2, height: cellHeight + margin * 2 };
      if (expanded.x < 0 || expanded.y < 0 || expanded.x + expanded.width > scene.width
        || expanded.y + expanded.height > scene.height || scene.sites.some(site => overlaps(expanded, site.bounds))) continue;
      const center = { x: cell.x + cellWidth / 2, y: cell.y + cellHeight / 2 };
      if (forbidden.some(polygon => overlaps(expanded, polygon.bounds) && touchesPolygon(center, radius, polygon.points))) continue;
      accepted.add(row * layout.resolution + column);
      const patchRow = Math.floor(row / CELLS_PER_PATCH), patchColumn = Math.floor(column / CELLS_PER_PATCH);
      const id = patchRow * Math.ceil(layout.resolution / CELLS_PER_PATCH) + patchColumn;
      if (!patches.has(id)) patches.set(id, { id, cells: [], bounds: {
        x: bounds.x + patchColumn * CELLS_PER_PATCH * cellWidth,
        y: bounds.y + patchRow * CELLS_PER_PATCH * cellHeight,
        width: CELLS_PER_PATCH * cellWidth, height: CELLS_PER_PATCH * cellHeight } });
      patches.get(id)!.cells.push(cell);
    }
  });
  const result = { bounds, cellWidth, cellHeight, scale, accepted, patches: [...patches.values()] };
  cache.set(scene, result); return result;
}

export function isForestRainGround(scene: FixedWorldScene, point: WorldPoint): boolean {
  const ground = groundLayout(scene);
  if (!ground || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  const column = Math.floor((point.x - ground.bounds.x) / ground.cellWidth),
    row = Math.floor((point.y - ground.bounds.y) / ground.cellHeight);
  return column >= 0 && row >= 0 && column < layout.resolution && row < layout.resolution
    && ground.accepted.has(row * layout.resolution + column);
}

/** Independent spatial patches keep every clearing/path active. Each lifetime draws
 * a new location; the shared scene clock makes repeats and circle/world views agree. */
export function forestGroundImpactFrame(scene: FixedWorldScene, options: ForestGroundImpactOptions, view?: WorldBounds): ForestGroundImpact[] {
  const rain = clamp(options.rain), dusk = clamp(options.dusk);
  if (rain <= .01 || options.reducedMotion) return [];
  const ground = groundLayout(scene); if (!ground) return [];
  const elapsed = Number.isFinite(options.elapsed) ? Math.max(0, options.elapsed) : 0;
  const impacts: ForestGroundImpact[] = [];
  for (const patch of ground.patches) {
    if (view && !overlaps(patch.bounds, view)) continue;
    const slots = Math.ceil(patch.cells.length / 18);
    for (let slot = 0; slot < slots; slot++) {
      const id = patch.id * 7 + slot + 991;
      const period = .78 + noise(id + 7121) * .7;
      const clock = elapsed / period + noise(id + 2047);
      const cycle = Math.floor(clock), seed = id + Math.imul(cycle, 7919);
      const duration = .27 + noise(seed + 2213) * .18;
      const phase = (clock - cycle) * period / duration;
      if (phase >= 1 || noise(seed + 1537) > rain) continue;
      const cell = patch.cells[Math.floor(noise(seed + 3779) * patch.cells.length)];
      const point = { x: cell.x + noise(seed + 4013) * ground.cellWidth,
        y: cell.y + noise(seed + 4909) * ground.cellHeight };
      if (options.groundExclusions?.some(other => Math.hypot(point.x - other.x, point.y - other.y)
        <= Math.max(0, Number.isFinite(other.radius) ? other.radius : 0) + FOOTPRINT * ground.scale)) continue;
      impacts.push({ ...point, phase, size: (.9 + noise(seed + 6173) * .3) * ground.scale,
        opacity: (.43 + rain * .31) * (1 - dusk * .42), variant: Math.floor(noise(seed + 7193) * 3), seed });
    }
  }
  return impacts;
}

/** Earth absorbs the hit: a dark fleck, a brief flattened splash and 2–4 rebounding
 * droplets. There are no expanding water rings or newly accumulated puddles. */
export function drawForestGroundImpact(ctx: CanvasRenderingContext2D, impact: ForestGroundImpact) {
  const { x, y, size, phase: age, opacity, variant, seed } = impact;
  if (age < 0 || age >= 1 || opacity <= 0) return;
  ctx.save();
  const fade = Math.sin(Math.min(1, age / .14) * Math.PI / 2) * (1 - age);
  ctx.fillStyle = variant === 1 ? "#516349" : "#5c5535"; ctx.globalAlpha = opacity * fade * .48;
  ctx.beginPath(); ctx.ellipse(x, y, size * (1.1 + age * .32), size * .48, -.2 + variant * .2, 0, TAU); ctx.fill();
  if (age < .34) {
    ctx.globalAlpha = opacity * (1 - age / .34) * .9; ctx.strokeStyle = "#d0d9be";
    ctx.lineWidth = size * .5; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x - size * 1.05, y); ctx.lineTo(x, y - size * .5);
    ctx.lineTo(x + size * 1.1, y + size * .1); ctx.stroke();
  }
  const flight = Math.min(1, age / .73);
  if (flight < 1) {
    ctx.fillStyle = variant === 2 ? "#bdd0b5" : "#d1d7bb";
    ctx.globalAlpha = opacity * Math.sqrt(1 - flight) * .95;
    for (let drop = 0; drop < 2 + variant; drop++) {
      const angle = (drop / (2 + variant) + noise(seed + drop * 17) * .17) * TAU;
      const spread = size * (1 + noise(seed + drop * 41 + 73) * .6) * flight;
      const lift = Math.sin(flight * Math.PI) * size * (1.15 + noise(seed + drop * 23 + 89) * .75);
      const px = x + Math.cos(angle) * spread, py = y + Math.sin(angle) * spread * .35 - lift;
      ctx.beginPath(); ctx.ellipse(px, py, size * .35, size * (.4 + (1 - flight) * .08), angle * .13, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}

export function drawForestGroundImpacts(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, options: ForestGroundImpactOptions) {
  const transform = ctx.getTransform?.();
  const margin = FOOTPRINT * 2;
  const view = transform && !transform.b && !transform.c && transform.a > 0 && transform.d > 0 ? {
    x: -transform.e / transform.a - margin, y: -transform.f / transform.d - margin,
    width: ctx.canvas.width / transform.a + margin * 2, height: ctx.canvas.height / transform.d + margin * 2,
  } : undefined;
  for (const impact of forestGroundImpactFrame(scene, options, view)) {
    if (!view || impact.x >= view.x && impact.x <= view.x + view.width
      && impact.y >= view.y && impact.y <= view.y + view.height) drawForestGroundImpact(ctx, impact);
  }
}
