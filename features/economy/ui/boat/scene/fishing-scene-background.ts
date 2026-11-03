import { drawWaterCurrent, drawWaterGlint, waterSurfaceFrame, type WaterSurfaceLayout } from "@/features/world/environment/water/forest-water-surface";
import type { FishingScenePoint } from "./fishing-scene-types";
import { fishingSceneAtmosphere, type FishingSceneAmbience } from "./fishing-scene-atmosphere";
import { fishingHullContactPoint, traceFishingHullContact } from "./fishing-scene-hull-water";
export { paintFishingBoatDisplacement } from "./fishing-scene-hull-water";

export const FISHING_WATER_TEXTURE = "/world/boat/river-water.webp?v=1";
const textureMosaics = new WeakMap<HTMLImageElement, HTMLCanvasElement>();
const textureWidth = 512, textureHeight = 384;
const wrap = (value: number, period: number) => ((value % period) + period) % period;

function mirroredTexture(image: HTMLImageElement): HTMLCanvasElement | null {
  const cached = textureMosaics.get(image); if (cached) return cached;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas"); canvas.width = textureWidth; canvas.height = textureHeight;
  const context = canvas.getContext("2d"); if (!context) return null;
  // Preserve the native 256×192 map patch. Upscaling it here used to filter every wave twice.
  context.imageSmoothingEnabled = false;
  for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
    context.save(); context.translate(column ? textureWidth : 0, row ? textureHeight : 0);
    context.scale(column ? -1 : 1, row ? -1 : 1);
    context.drawImage(image, 0, 0, textureWidth / 2, textureHeight / 2); context.restore();
  }
  textureMosaics.set(image, canvas); return canvas;
}

/** Integral sampling translates one continuous native-resolution field, without overlapping refracted bands. */
export function fishingWaterStrip(y: number, time: number) {
  const clock = Number.isFinite(time) ? time : 0;
  return { x: wrap(Math.floor(clock * 2.4), textureWidth),
    y: wrap(Math.floor(y) + Math.floor(clock * .8), textureHeight) };
}

function paintMovingTexture(ctx: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number, time: number) {
  const texture = mirroredTexture(image); if (!texture) return;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  // Whole native tiles have the same source phase at every boundary. Each destination pixel is painted once.
  let y = 0;
  while (y < height) {
    const source = fishingWaterStrip(y, time), rowHeight = Math.min(height - y, textureHeight - source.y);
    let x = 0;
    while (x < width) {
      const sourceX = wrap(source.x + x, textureWidth), span = Math.min(width - x, textureWidth - sourceX);
      ctx.drawImage(texture, sourceX, source.y, span, rowHeight, x, y, span, rowHeight); x += span;
    }
    y += rowHeight;
  }
}

let cachedLayout: { width: number; height: number; layout: WaterSurfaceLayout } | undefined;
const seed = (index: number) => { const value = Math.sin(index * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };

function surfaceLayout(width: number, height: number): WaterSurfaceLayout {
  if (cachedLayout?.width === width && cachedLayout.height === height) return cachedLayout.layout;
  const currents = [], glints = [];
  for (let row = 0; row < 8; row++) for (let column = 0; column < 7; column++) {
    const key = row * 37 + column * 19;
    const x = (column + .12 + seed(key + 8) * .76) / 7 * width;
    const y = (row + .12 + seed(key + 16) * .76) / 8 * height;
    const scale = 1.25 + seed(key + 31) * 1.1;
    currents.push({ x, y, key, width: 25 + seed(key + 42) * 44, scale });
    glints.push({ x: x + 12 + seed(key + 53) * 31, y: y + seed(key + 61) * 28,
      key: key + 3, width: 3 + seed(key + 72) * 6, scale });
  }
  const layout = { currents, glints }; cachedLayout = { width, height, layout }; return layout;
}

function paintSurfaceLight(ctx: CanvasRenderingContext2D, width: number, height: number, time: number) {
  // Broad low-contrast washes break up the mirrored motif without adding a second wave drawing.
  const depth = ctx.createLinearGradient(0, 0, width * .22, height);
  depth.addColorStop(0, "rgba(8,66,92,.055)"); depth.addColorStop(.42, "rgba(7,77,98,0)");
  depth.addColorStop(1, "rgba(6,58,82,.105)"); ctx.fillStyle = depth; ctx.fillRect(0, 0, width, height);
  const x = width * (.38 + Math.sin(time * .045) * .025), y = height * (.31 + Math.cos(time * .036) * .022);
  const radius = Math.max(width, height) * .48;
  const light = ctx.createRadialGradient(x, y, 0, x, y, radius);
  light.addColorStop(0, `rgba(240,225,171,${.047 + Math.sin(time * .11) * .008})`);
  light.addColorStop(.6, "rgba(177,224,212,.018)"); light.addColorStop(1, "rgba(177,224,212,0)");
  ctx.fillStyle = light; ctx.fillRect(0, 0, width, height);
}

/** Actual painted map water, mirrored at tile boundaries; the map's own current/glint painters sit above it. */
export function paintFishingLandscape(ctx: CanvasRenderingContext2D, width: number, height: number, time: number,
  image?: HTMLImageElement, ambience?: FishingSceneAmbience) {
  ctx.fillStyle = "#087fa5"; ctx.fillRect(0, 0, width, height);
  if (image) paintMovingTexture(ctx, image, width, height, time);
  paintSurfaceLight(ctx, width, height, time);
  const mood = fishingSceneAtmosphere(ambience);
  if (mood.night > .01) { ctx.fillStyle = `rgba(8,24,57,${mood.night * .46})`; ctx.fillRect(0, 0, width, height); }
  if (mood.sunset > .01) {
    const sunset = ctx.createLinearGradient(width, 0, width * .1, height);
    sunset.addColorStop(0, `rgba(240,167,91,${mood.sunset * .19})`); sunset.addColorStop(.5, `rgba(170,117,111,${mood.sunset * .075})`);
    sunset.addColorStop(1, "rgba(63,89,113,0)"); ctx.fillStyle = sunset; ctx.fillRect(0, 0, width, height);
  }
  const surface = waterSurfaceFrame(surfaceLayout(width, height), { elapsed: time, rain: 0, dusk: mood.night * .8 + mood.sunset * .3, wind: .28 + Math.sin(time * .037) * .055 });
  surface.currents.forEach(current => drawWaterCurrent(ctx, current));
  surface.glints.forEach(glint => drawWaterGlint(ctx, glint));
  const vignette = ctx.createRadialGradient(width * .55, height * .4, width * .12, width * .5, height * .5, Math.max(width, height) * .75);
  vignette.addColorStop(0, "rgba(4,35,47,0)"); vignette.addColorStop(1, "rgba(4,35,47,.25)");
  ctx.fillStyle = vignette; ctx.fillRect(0, 0, width, height);
}

export function paintFishingRipples(ctx: CanvasRenderingContext2D, point: FishingScenePoint, time: number, strength = 1) {
  ctx.save(); ctx.lineCap = "round";
  for (let i = 0; i < 3; i++) {
    const phase = (time * .7 + i / 3) % 1;
    const pulse = Math.sin(Math.PI * phase) ** .7;
    const drift = Math.sin(time * .63 + i * 2.1) * phase * 2;
    ctx.strokeStyle = `rgba(199,233,223,${pulse * .28 * strength})`; ctx.lineWidth = 1.4 - phase * .4;
    const x = point.x + phase * 3 + drift, y = point.y + phase * 2;
    ctx.beginPath(); ctx.ellipse(x, y, 8 + phase * 48, 3 + phase * 20, -.08, .12, Math.PI * .93); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(x, y, 8 + phase * 48, 3 + phase * 20, -.08, Math.PI * 1.08, Math.PI * 1.9); ctx.stroke();
  }
  ctx.restore();
}

/** Open rings only: a dark detached oval made the hull appear suspended over the surface. */
export function paintFishingWake(ctx: CanvasRenderingContext2D, point: FishingScenePoint, width: number, time: number) {
  ctx.save(); ctx.lineCap = "round";
  for (let i = 0; i < 3; i++) {
    const phase = (time * .19 + i / 3) % 1;
    const pulse = Math.sin(Math.PI * phase) ** .75;
    const drift = Math.sin(time * .72 + i * .7) * phase * 3;
    ctx.strokeStyle = `rgba(188,228,218,${pulse * .125})`; ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.ellipse(point.x + phase * 5 + drift, point.y - 2 + phase * 12,
      width * (.43 + phase * .058), width * (.025 + phase * .023), -.09 + Math.sin(time * .24) * .005, .12, Math.PI * .87); ctx.stroke();
  }
  ctx.restore();
}

/** Authored lower hull contour in 1000×650 assembly space; draw in the boat's complete local transform. */
export function paintFishingHullContact(ctx: CanvasRenderingContext2D, time: number) {
  ctx.save(); ctx.lineCap = "round";
  // A short translucent wetted lip joins wood and water without hiding the supplied hull artwork.
  traceFishingHullContact(ctx, time);
  ctx.strokeStyle = "rgba(4,73,88,.3)"; ctx.lineWidth = 7; ctx.stroke();
  traceFishingHullContact(ctx, time, 2.5);
  ctx.strokeStyle = `rgba(164,219,211,${.25 + Math.sin(time * .72) * .035})`; ctx.lineWidth = 1.9; ctx.stroke();
  // Broken light on the wetted edge follows the same slope as the hull, including the lifted bow.
  for (let index = 0; index < 8; index++) {
    const t = .045 + index * .125, from = fishingHullContactPoint(t, time), to = fishingHullContactPoint(t + .047, time);
    const pulse = .09 + (Math.sin(time * .88 + index * 1.7) + 1) * .045;
    ctx.strokeStyle = `rgba(202,233,211,${pulse})`; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(from.x, from.y + 2.5);
    ctx.quadraticCurveTo((from.x + to.x) / 2, (from.y + to.y) / 2 + 3.5, to.x, to.y + 2.5); ctx.stroke();
  }
  ctx.restore();
}
