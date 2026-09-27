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
const PUFF_COUNT = 6;
const SMOKE_PERIOD = 8;
let smokeTexture: HTMLCanvasElement | undefined;

function smokeGradient(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, "rgba(208,211,198,.8)");
  gradient.addColorStop(.4, "rgba(208,211,198,.4)");
  gradient.addColorStop(1, "rgba(208,211,198,0)");
  return gradient;
}

function smokeSprite() {
  if (smokeTexture || typeof document === "undefined") return smokeTexture;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d"); if (!ctx) return undefined;
  ctx.fillStyle = smokeGradient(ctx, 32, 32, 32); ctx.fillRect(0, 0, 64, 64);
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
  ctx.save(); ctx.globalCompositeOperation = "source-over";
  for (let index = 0; index < PUFF_COUNT; index++) {
    const age = (time / SMOKE_PERIOD + index / PUFF_COUNT + phase) % 1;
    // Zero opacity and zero opacity derivative at both ends avoid a visible loop reset.
    const fade = Math.sin(age * Math.PI) ** 2;
    const rise = age * 45 * scale, spread = age ** 1.3;
    const x = site.chimney.x + spread * (8 + Math.sin(time * .65 + phase * TAU + index) * 4) * scale;
    const y = site.chimney.y - rise;
    const radius = (1.6 + age * 7) * scale;
    ctx.globalAlpha = fade * (.13 - night * .045);
    if (sprite) ctx.drawImage(sprite, x - radius, y - radius * 1.2, radius * 2, radius * 2.4);
    else {
      ctx.fillStyle = smokeGradient(ctx, x, y, radius);
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
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
  ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = night;
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
