import { drawWaterCurrent, drawWaterGlint, waterSurfaceFrame, type WaterSurfaceLayout } from "@/features/world/environment/water/forest-water-surface";
import type { FishingScenePoint } from "./fishing-scene-types";

export const FISHING_WATER_TEXTURE = "/world/boat/river-water.webp?v=1";
const textureMosaics = new WeakMap<HTMLImageElement, HTMLCanvasElement>();
const textureWidth = 768, textureHeight = 576;
const wrap = (value: number, period: number) => ((value % period) + period) % period;

function mirroredTexture(image: HTMLImageElement): HTMLCanvasElement | null {
  const cached = textureMosaics.get(image); if (cached) return cached;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas"); canvas.width = textureWidth; canvas.height = textureHeight;
  const context = canvas.getContext("2d"); if (!context) return null;
  for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
    context.save(); context.translate(column ? textureWidth : 0, row ? textureHeight : 0);
    context.scale(column ? -1 : 1, row ? -1 : 1);
    context.drawImage(image, 0, 0, textureWidth / 2, textureHeight / 2); context.restore();
  }
  textureMosaics.set(image, canvas); return canvas;
}

/** Bounded strips refract the real map texture. The periodic mirrored source has no moving tile seams. */
export function fishingWaterStrip(y: number, time: number) {
  const clock = Number.isFinite(time) ? time : 0;
  return { x: wrap(clock * 2.4 + Math.sin(y * .019 - clock * .75) * 3.2 + Math.sin(y * .044 + clock * .42) * 1.1, textureWidth),
    y: wrap(y + clock * .8 + Math.sin(clock * .4 + y * .01) * 1.5, textureHeight) };
}

function paintMovingTexture(ctx: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number, time: number) {
  const texture = mirroredTexture(image); if (!texture) return;
  ctx.imageSmoothingEnabled = true;
  for (let y = 0; y < height; y += 18) {
    const source = fishingWaterStrip(y, time);
    let rowOffset = 0;
    const band = Math.min(19, height - y);
    while (rowOffset < band) {
      const sourceY = wrap(source.y + rowOffset, textureHeight), rowHeight = Math.min(band - rowOffset, textureHeight - sourceY);
      let x = 0;
      while (x < width) {
        const sourceX = wrap(source.x + x, textureWidth), span = Math.min(width - x, textureWidth - sourceX);
        ctx.drawImage(texture, sourceX, sourceY, span, rowHeight, x, y + rowOffset, span, rowHeight); x += span;
      }
      rowOffset += rowHeight;
    }
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
  image?: HTMLImageElement) {
  ctx.fillStyle = "#087fa5"; ctx.fillRect(0, 0, width, height);
  if (image) paintMovingTexture(ctx, image, width, height, time);
  paintSurfaceLight(ctx, width, height, time);
  const surface = waterSurfaceFrame(surfaceLayout(width, height), { elapsed: time, rain: 0, dusk: 0, wind: .28 + Math.sin(time * .037) * .055 });
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
  const swell = Math.sin(time * 1.25) * 1.7;
  ctx.save(); ctx.lineCap = "round";
  // A short translucent wetted lip joins wood and water without hiding the supplied hull artwork.
  ctx.beginPath(); ctx.moveTo(124, 555 + swell);
  ctx.bezierCurveTo(330, 567 + swell, 654, 513 + swell, 834, 438 + swell);
  ctx.bezierCurveTo(877, 415 + swell, 920, 383 + swell, 946, 350 + swell);
  ctx.strokeStyle = "rgba(4,73,88,.3)"; ctx.lineWidth = 10; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(127, 560 + swell);
  ctx.bezierCurveTo(338, 572 + swell, 650, 519 + swell, 832, 444 + swell);
  ctx.strokeStyle = `rgba(164,219,211,${.21 + Math.sin(time * .72) * .035})`; ctx.lineWidth = 1.7; ctx.stroke();
  // Small uneven reflections adhere to the contact line instead of producing a second solid hull.
  for (let index = 0; index < 7; index++) {
    const t = (index + .4) / 7, x = 140 + t * 650;
    const y = 570 - t * t * 118 + swell + 8 + Math.sin(time * .9 + index) * 2;
    ctx.strokeStyle = `rgba(94,80,45,${.055 + (index % 3) * .018 + Math.sin(time * .8 + index) * .012})`; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(x - 18, y); ctx.quadraticCurveTo(x, y + 2, x + 22, y - 1); ctx.stroke();
  }
  ctx.restore();
}
