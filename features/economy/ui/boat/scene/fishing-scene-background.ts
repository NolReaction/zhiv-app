import { drawWaterCurrent, drawWaterGlint, waterSurfaceFrame, type WaterSurfaceLayout } from "@/features/world/environment/water/forest-water-surface";
import type { FishingScenePoint } from "./fishing-scene-types";

export const FISHING_WATER_TEXTURE = "/world/boat/river-water.webp?v=1";
let cachedLayout: { width: number; height: number; layout: WaterSurfaceLayout } | undefined;

function surfaceLayout(width: number, height: number): WaterSurfaceLayout {
  if (cachedLayout?.width === width && cachedLayout.height === height) return cachedLayout.layout;
  const currents = [], glints = [];
  for (let row = 0; row < 8; row++) for (let column = 0; column < 7; column++) {
    const key = row * 37 + column * 19;
    const x = (column + .25 + Math.sin(key) * .19) / 7 * width;
    const y = (row + .35 + Math.cos(key) * .2) / 8 * height;
    currents.push({ x, y, key, width: 36 + key % 27, scale: 2.2 });
    glints.push({ x: x + 34, y: y + 21, key: key + 3, width: 4 + key % 6, scale: 2.2 });
  }
  const layout = { currents, glints }; cachedLayout = { width, height, layout }; return layout;
}

/** Actual painted map water, mirrored at tile boundaries; the map's own current/glint painters sit above it. */
export function paintFishingLandscape(ctx: CanvasRenderingContext2D, width: number, height: number, time: number,
  image?: HTMLImageElement) {
  ctx.fillStyle = "#087fa5"; ctx.fillRect(0, 0, width, height);
  if (image) {
    // Mirroring makes every shared edge identical without stretching a whole river screenshot.
    const tileWidth = 384, tileHeight = 288;
    ctx.imageSmoothingEnabled = true;
    for (let row = 0; row * tileHeight < height; row++) for (let column = 0; column * tileWidth < width; column++) {
      ctx.save(); ctx.translate((column + column % 2) * tileWidth, (row + row % 2) * tileHeight);
      ctx.scale(column % 2 ? -1 : 1, row % 2 ? -1 : 1); ctx.drawImage(image, 0, 0, tileWidth, tileHeight); ctx.restore();
    }
  }
  const surface = waterSurfaceFrame(surfaceLayout(width, height), { elapsed: time, rain: 0, dusk: 0, wind: .3 });
  surface.currents.forEach(current => drawWaterCurrent(ctx, current));
  surface.glints.forEach(glint => drawWaterGlint(ctx, glint));
  const vignette = ctx.createRadialGradient(width * .55, height * .4, width * .12, width * .5, height * .5, Math.max(width, height) * .75);
  vignette.addColorStop(0, "rgba(4,35,47,0)"); vignette.addColorStop(1, "rgba(4,35,47,.34)");
  ctx.fillStyle = vignette; ctx.fillRect(0, 0, width, height);
}

export function paintFishingRipples(ctx: CanvasRenderingContext2D, point: FishingScenePoint, time: number, strength = 1) {
  for (let i = 0; i < 3; i++) {
    const phase = (time * .7 + i / 3) % 1;
    ctx.strokeStyle = `rgba(199,233,223,${(1 - phase) * .38 * strength})`; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.ellipse(point.x, point.y, 8 + phase * 48, 3 + phase * 20, -.08, 0, Math.PI * 2); ctx.stroke();
  }
}

export function paintFishingWake(ctx: CanvasRenderingContext2D, point: FishingScenePoint, width: number, time: number) {
  ctx.fillStyle = "rgba(4,40,49,.25)";
  ctx.beginPath(); ctx.ellipse(point.x, point.y, width * .49, width * .047, -.08, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 3; i++) {
    const phase = (time * .23 + i / 3) % 1;
    ctx.strokeStyle = `rgba(188,228,218,${(1 - phase) * .22})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(point.x, point.y + 4 + phase * 13, width * (.46 + phase * .045), width * (.04 + phase * .025), -.08, .12, Math.PI * .94); ctx.stroke();
  }
}
