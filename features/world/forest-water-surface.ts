import type { WorldPoint } from "./tiled/types";

export const WATER_SURFACE_LIMITS = { currents: 64, glints: 84 } as const;
type Cell = { key: number; points: WorldPoint[] };
type Fits = (point: WorldPoint, rx: number, ry: number) => boolean;
type SurfaceSeed = WorldPoint & { key: number; scale: number; width: number };
export type WaterSurfaceLayout = { currents: SurfaceSeed[]; glints: SurfaceSeed[] };
type SurfaceOptions = { elapsed: number; rain: number; dusk: number; wind?: number };
export type WaterCurrentFrame = WorldPoint & { width: number; scale: number; phase: number;
  bend: number; opacity: number; dusk: number };
export type WaterGlintFrame = WorldPoint & { width: number; scale: number; opacity: number; dusk: number };
const TAU = Math.PI * 2;
const noise = (index: number) => { const n = Math.sin(index * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
const phase = (value: number) => value - Math.floor(value);
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** The common active clock also drives an unhurried wind when no override is
 * supplied. A paused/reduced-motion frame has no independent weather timer. */
export function forestWaterWind(options: SurfaceOptions) {
  return Number.isFinite(options.wind) ? clamp(options.wind!)
    : clamp(.27 + Math.sin(options.elapsed * .037) * .13 + options.rain * .43);
}

/** Check the complete path, both curved strokes and their widths once. The
 * smaller alternative keeps the narrow tributary alive without shore clipping. */
export function createWaterSurfaceLayout(cells: Cell[], scale: number, fits: Fits): WaterSurfaceLayout {
  const currents: SurfaceSeed[] = [], glints: SurfaceSeed[] = [];
  for (const cell of cells) {
    if (currents.length < WATER_SURFACE_LIMITS.currents) for (const point of cell.points.slice(0, 8)) {
      const length = 21 + noise(cell.key + 165) * 17;
      const size = [1, .62].find(size => fits(point, (length * .64 + 5) * scale * size + 1, 8 * scale * size + 1));
      if (!size) continue;
      currents.push({ ...point, key: cell.key, scale: scale * size, width: length * scale * size }); break;
    }
    if (glints.length < WATER_SURFACE_LIMITS.glints) for (const point of cell.points.slice(2, 10)) {
      if (!fits(point, 8 * scale + 1, 4 * scale + 1)) continue;
      glints.push({ ...point, key: cell.key, scale, width: (1.2 + noise(cell.key + 172) * 3.5) * scale }); break;
    }
    if (currents.length >= WATER_SURFACE_LIMITS.currents && glints.length >= WATER_SURFACE_LIMITS.glints) break;
  }
  return { currents, glints };
}

export function waterSurfaceFrame(layout: WaterSurfaceLayout, options: SurfaceOptions) {
  const { elapsed, rain, dusk } = options, wind = forestWaterWind(options);
  const currents: WaterCurrentFrame[] = layout.currents.map(seed => {
    const age = phase(elapsed / (8 + noise(seed.key + 181) * 7) + noise(seed.key + 185));
    const pulse = Math.sin(age * Math.PI) ** 2;
    return { x: seed.x + (age - .5) * 7 * seed.scale,
      y: seed.y + (age - .5) * 3 * seed.scale, width: seed.width, scale: seed.scale,
      phase: age, bend: Math.sin(elapsed * .39 + seed.key) * .8,
      opacity: pulse * (.17 + wind * .08) * (1 - dusk * .59) * (1 - rain * .47), dusk };
  });
  const glints: WaterGlintFrame[] = layout.glints.map(seed => {
    const clock = elapsed * (.37 + noise(seed.key + 209) * .36) + noise(seed.key + 211) * TAU;
    const shimmer = Math.max(0, Math.sin(clock) * .7 + Math.sin(clock * .61 + seed.key) * .3);
    return { x: seed.x + Math.sin(clock * .47) * 2.2 * seed.scale,
      y: seed.y + Math.cos(clock * .36) * .8 * seed.scale,
      width: seed.width * (.65 + shimmer * .35), scale: seed.scale, dusk,
      opacity: shimmer ** 3 * (.31 + wind * .08) * (1 - dusk * .68) * (1 - rain * .85) };
  });
  return { currents, glints };
}

/** A quiet darker trough gives the broken crest a little depth, rather than
 * painting a second opaque wave pattern over the original river artwork. */
export function drawWaterCurrent(ctx: CanvasRenderingContext2D, current: WaterCurrentFrame) {
  const { x, y, width, scale, bend } = current;
  ctx.save(); ctx.lineCap = "round";
  const stroke = (offset: number) => {
    ctx.beginPath(); ctx.moveTo(x - width * .5, y + offset);
    ctx.bezierCurveTo(x - width * .27, y + (bend - .85) * scale + offset,
      x - width * .02, y + (bend + .9) * scale + offset, x + width * .17, y + offset); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + width * .29, y - scale * .2 + offset);
    ctx.quadraticCurveTo(x + width * .42, y - scale * .7 + offset, x + width * .5, y - scale * .1 + offset); ctx.stroke();
  };
  ctx.globalAlpha = current.opacity * .45; ctx.strokeStyle = "#155d75"; ctx.lineWidth = 1.5 * scale; stroke(.9 * scale);
  ctx.globalAlpha = current.opacity; ctx.strokeStyle = current.dusk > .55 ? "#8db9cf" : "#b3ddd8";
  ctx.lineWidth = .64 * scale; stroke(0); ctx.restore();
}

export function drawWaterGlint(ctx: CanvasRenderingContext2D, glint: WaterGlintFrame) {
  if (glint.opacity < .004) return;
  ctx.save(); ctx.globalAlpha = glint.opacity; ctx.lineCap = "round";
  ctx.strokeStyle = glint.dusk > .55 ? "#b7d3e7" : "#f0ebc4"; ctx.lineWidth = .62 * glint.scale;
  ctx.beginPath(); ctx.moveTo(glint.x - glint.width / 2, glint.y);
  ctx.quadraticCurveTo(glint.x, glint.y - .35 * glint.scale, glint.x + glint.width / 2, glint.y); ctx.stroke();
  ctx.globalAlpha *= .38; ctx.lineWidth = .4 * glint.scale;
  ctx.beginPath(); ctx.moveTo(glint.x - glint.width * .2, glint.y + .95 * glint.scale);
  ctx.lineTo(glint.x + glint.width * .28, glint.y + .95 * glint.scale); ctx.stroke(); ctx.restore();
}
