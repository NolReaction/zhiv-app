import type { FixedSite, FixedWorldScene, WorldPoint } from "./tiled/types";

export type BuildingDetailOptions = {
  night: number;
  /** Shared world time in seconds; pausing it freezes the smoke. */
  elapsed: number;
  reducedMotion: boolean;
  showBuildings?: boolean;
};

const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const TAU = Math.PI * 2;
const SMOKE_SEGMENTS = 6;
let smokeTexture: HTMLCanvasElement | undefined;

function smokeGradient(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, "rgba(196,204,190,.72)");
  gradient.addColorStop(.35, "rgba(196,204,190,.46)");
  gradient.addColorStop(.7, "rgba(196,204,190,.12)");
  gradient.addColorStop(1, "rgba(196,204,190,0)");
  return gradient;
}

function smokeSprite() {
  if (smokeTexture || typeof document === "undefined") return smokeTexture;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d"); if (!ctx) return undefined;
  // A slightly asymmetric density field avoids identical, circular particle cores.
  ctx.fillStyle = smokeGradient(ctx, 29, 29, 29); ctx.fillRect(0, 0, 64, 64);
  ctx.globalAlpha = .35;
  ctx.fillStyle = smokeGradient(ctx, 39, 39, 22); ctx.fillRect(0, 0, 64, 64);
  smokeTexture = canvas; return canvas;
}

function visible(ctx: CanvasRenderingContext2D, point: WorldPoint, radius: number) {
  const transform = ctx.getTransform?.();
  if (!transform || transform.b || transform.c || transform.a <= 0 || transform.d <= 0) return true;
  return (point.x + radius) * transform.a + transform.e >= 0
    && (point.x - radius) * transform.a + transform.e <= ctx.canvas.width
    && (point.y + radius) * transform.d + transform.f >= 0
    && (point.y - radius) * transform.d + transform.f <= ctx.canvas.height;
}

function sitePhase(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (Math.imul(hash, 31) + id.charCodeAt(index)) | 0;
  return (hash >>> 0) / 4294967296;
}

function drawChimney(ctx: CanvasRenderingContext2D, site: FixedSite, elapsed: number, night: number) {
  if (!site.chimney) return;
  const scale = Math.max(.45, Math.min(1.6, site.bounds.width / 145));
  if (!visible(ctx, site.chimney, 65 * scale)) return;
  const sprite = smokeSprite(), phase = sitePhase(site.id);
  const time = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const opacity = ctx.globalAlpha;
  ctx.save(); ctx.globalCompositeOperation = "source-over";
  // The overlapping plume begins at the mouth; none of its soft tail paints over the pipe.
  ctx.beginPath(); ctx.rect(site.chimney.x - 30 * scale, site.chimney.y - 65 * scale, 65 * scale, 65 * scale); ctx.clip();
  for (let index = 0; index < SMOKE_SEGMENTS; index++) {
    const heightFraction = index / (SMOKE_SEGMENTS - 1);
    const flow = time * .9 - heightFraction * 6.5 + phase * TAU;
    const spread = heightFraction ** 1.3;
    // Travelling waves carry density upward along one continuous column; there is no
    // particle birth/reset and no gap between the chimney mouth and the first puff.
    const bend = Math.sin(flow * .63) * 3.2 + Math.sin(flow * 1.17 + 1.2) * 1.1;
    const x = site.chimney.x + spread * (7 + bend) * scale;
    const y = site.chimney.y - (3.5 + heightFraction * 34) * scale;
    const width = (3 + heightFraction * 14) * (1 + Math.sin(flow + .7) * .09) * scale;
    const height = (15 + heightFraction * 12) * scale;
    ctx.globalAlpha = opacity * (.11 - night * .03) * (1 - heightFraction * .88) * (.88 + Math.sin(flow) * .12);
    if (sprite) ctx.drawImage(sprite, x - width / 2, y - height / 2, width, height);
    else {
      ctx.fillStyle = smokeGradient(ctx, x, y, height / 2);
      ctx.fillRect(x - width / 2, y - height / 2, width, height);
    }
  }
  ctx.restore();
}

function drawWindow(ctx: CanvasRenderingContext2D, points: WorldPoint[], night: number) {
  if (!night || points.length < 3) return;
  const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x));
  const top = Math.min(...points.map(point => point.y)), bottom = Math.max(...points.map(point => point.y));
  const width = right - left, height = bottom - top;
  if (width <= 0 || height <= 0) return;
  const center = { x: (left + right) / 2, y: top + height * .65 }, radius = Math.max(width, height) * .8;
  if (!visible(ctx, center, radius)) return;
  ctx.save(); ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath(); ctx.clip();
  // Clipped, translucent screen lighting keeps the painted window mullions and grain visible.
  ctx.globalCompositeOperation = "screen"; ctx.globalAlpha *= night;
  const glow = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
  glow.addColorStop(0, "rgba(255,191,99,.37)");
  glow.addColorStop(.55, "rgba(237,146,62,.23)");
  glow.addColorStop(1, "rgba(189,104,47,.08)");
  ctx.fillStyle = glow; ctx.fillRect(left, top, width, height);
  ctx.restore();
}

/** Only chimney smoke needs continuous frames; window lighting itself is static. */
export function buildingDetailsAnimated(scene: FixedWorldScene) {
  return scene.sites.some(site => Boolean(site.chimney));
}

/** Authored effects consume the same effective level geometry in every camera. */
export function drawBuildingDetails(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, options: BuildingDetailOptions) {
  if (options.showBuildings === false) return;
  const night = clamp(options.night);
  for (const site of scene.sites) {
    if (site.window) drawWindow(ctx, site.window, night);
    if (!options.reducedMotion) drawChimney(ctx, site, options.elapsed, night);
  }
}
