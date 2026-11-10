import { drawWaterCurrent, drawWaterGlint, waterSurfaceFrame, type WaterSurfaceLayout } from "@/features/world/environment/water/forest-water-surface";
import type { FishingScenePoint } from "./fishing-scene-types";
import { fishingSceneAtmosphere, type FishingSceneAmbience } from "./fishing-scene-atmosphere";
import { fishingHullContactPoint, traceFishingHullContact } from "./fishing-scene-hull-water";
import { fishingWaterWave } from "./fishing-scene-buoyancy";
export { paintFishingBoatDisplacement, paintFishingHullImmersion } from "./fishing-scene-hull-water";

export const FISHING_WATER_TEXTURE = "/world/boat/lake-water.webp?v=1";
const finiteClock = (time: number, still: boolean) => still || !Number.isFinite(time) ? 0 : Math.max(0, time);
const viewportScale = (scale: number) => Number.isFinite(scale) && scale > 0 ? scale : 1;

type WaterView = { sourceWidth: number; sourceHeight: number; travelX: number; travelY: number };
const waterViews = new WeakMap<HTMLImageElement, { width: number; height: number; view: WaterView }>();

/** One cover crop of the decoded lake artwork, with room for slow continuous motion.
 * No mirrored motifs, repeated tiles, overlapping strips or per-frame pixel buffers. */
export function fishingWaterView(width: number, height: number, imageWidth = 1024, imageHeight = 1024): WaterView {
  const nativeWidth = Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : 1024;
  const nativeHeight = Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : 1024;
  const scale = Math.max(width / nativeWidth, height / nativeHeight) * 1.14;
  const sourceWidth = width / scale, sourceHeight = height / scale;
  return { sourceWidth, sourceHeight, travelX: nativeWidth - sourceWidth, travelY: nativeHeight - sourceHeight };
}

/** Crop motion has no wrapping edge. Reduced motion always samples the same pose. */
export function fishingWaterSample(view: WaterView, time: number, still = false) {
  const t = finiteClock(time, still);
  return { x: view.travelX * (.5 + Math.sin(t * .043) * .2 + Math.sin(t * .109) * .065),
    y: view.travelY * (.5 + Math.cos(t * .037) * .12 + Math.sin(t * .083) * .05) };
}

function paintMovingTexture(ctx: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number, time: number, still: boolean) {
  let cached = waterViews.get(image);
  if (!cached || cached.width !== width || cached.height !== height) {
    cached = { width, height, view: fishingWaterView(width, height, image.naturalWidth, image.naturalHeight) };
    waterViews.set(image, cached);
  }
  const sample = fishingWaterSample(cached.view, time, still);
  // The runtime owns and caches the decoded Image. Resizing only updates this crop, never a source canvas.
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "low";
  ctx.drawImage(image, sample.x, sample.y, cached.view.sourceWidth, cached.view.sourceHeight, 0, 0, width, height);
}

let cachedLayout: { width: number; height: number; layout: WaterSurfaceLayout } | undefined;
const seed = (index: number) => { const value = Math.sin(index * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };

function surfaceLayout(width: number, height: number): WaterSurfaceLayout {
  if (cachedLayout?.width === width && cachedLayout.height === height) return cachedLayout.layout;
  const currents = [], glints = [];
  const columns = Math.max(3, Math.min(8, Math.ceil(width / 200))), rows = Math.max(3, Math.min(8, Math.ceil(height / 170)));
  const unit = Math.max(.55, Math.min(1, width / 1000));
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const key = row * 37 + column * 19;
    const x = (column + .12 + seed(key + 8) * .76) / columns * width;
    const y = (row + .12 + seed(key + 16) * .76) / rows * height;
    const scale = (1.1 + seed(key + 31) * .7) * unit;
    currents.push({ x, y, key, width: (25 + seed(key + 42) * 44) * unit, scale });
    glints.push({ x: x + (12 + seed(key + 53) * 31) * unit, y: y + seed(key + 61) * 28 * unit,
      key: key + 3, width: (3 + seed(key + 72) * 6) * unit, scale });
  }
  const layout = { currents, glints }; cachedLayout = { width, height, layout }; return layout;
}

/** Surface details sample the same scene-coordinate wave as both boat floats.
 * The background itself is painted before the logical-scene canvas scale. */
export function fishingWaterSurfaceFrame(width: number, height: number, time: number, scale = 1, still = false, dusk = 0) {
  const t = finiteClock(time, still), unit = viewportScale(scale);
  const surface = waterSurfaceFrame(surfaceLayout(width, height), { elapsed: t, rain: 0, dusk,
    wind: .28 + Math.sin(t * .037) * .055 });
  return {
    currents: surface.currents.map(current => {
      const wave = fishingWaterWave(current.x / unit, t, still);
      return { ...current, x: current.x + wave.drift * unit * .15, y: current.y + wave.height * unit * .4,
        bend: current.bend + wave.slope * current.width / unit * .3 };
    }),
    glints: surface.glints.map(glint => {
      const wave = fishingWaterWave(glint.x / unit, t, still);
      return { ...glint, x: glint.x + wave.drift * unit * .15, y: glint.y + wave.height * unit * .4 };
    }),
  };
}

type SurfaceLighting = { width: number; height: number; transform: string; depth: CanvasGradient; vignette: CanvasGradient };
const lighting = new WeakMap<CanvasRenderingContext2D, SurfaceLighting>();
function surfaceLighting(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const matrix = ctx.getTransform();
  const transform = matrix ? [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].join(",") : "1,0,0,1,0,0";
  const previous = lighting.get(ctx);
  if (previous?.width === width && previous.height === height && previous.transform === transform) return previous;
  const depth = ctx.createLinearGradient(0, 0, width * .22, height);
  depth.addColorStop(0, "rgba(8,66,92,.045)"); depth.addColorStop(.42, "rgba(7,77,98,0)");
  depth.addColorStop(1, "rgba(6,58,82,.10)");
  const vignette = ctx.createRadialGradient(width * .55, height * .4, width * .12, width * .5, height * .5, Math.max(width, height) * .75);
  vignette.addColorStop(0, "rgba(4,35,47,0)"); vignette.addColorStop(1, "rgba(4,35,47,.19)");
  const value = { width, height, transform, depth, vignette }; lighting.set(ctx, value); return value;
}

function paintSurfaceLight(ctx: CanvasRenderingContext2D, width: number, height: number, time: number) {
  ctx.fillStyle = surfaceLighting(ctx, width, height).depth; ctx.fillRect(0, 0, width, height);
  const x = width * (.38 + Math.sin(time * .045) * .025), y = height * (.31 + Math.cos(time * .036) * .022);
  const radius = Math.max(width, height) * .48;
  const light = ctx.createRadialGradient(x, y, 0, x, y, radius);
  light.addColorStop(0, `rgba(240,225,171,${.037 + Math.sin(time * .11) * .006})`);
  light.addColorStop(.6, "rgba(177,224,212,.014)"); light.addColorStop(1, "rgba(177,224,212,0)");
  ctx.fillStyle = light; ctx.fillRect(0, 0, width, height);
}

type Mood = ReturnType<typeof fishingSceneAtmosphere>;

function paintLakeLight(ctx: CanvasRenderingContext2D, width: number, height: number, t: number, mood: Mood) {
  paintSurfaceLight(ctx, width, height, t);
  if (mood.night > .01) { ctx.fillStyle = `rgba(8,24,57,${mood.night * .46})`; ctx.fillRect(0, 0, width, height); }
  if (mood.sunset > .01) {
    const sunset = ctx.createLinearGradient(width, 0, width * .1, height);
    sunset.addColorStop(0, `rgba(240,167,91,${mood.sunset * .19})`); sunset.addColorStop(.5, `rgba(170,117,111,${mood.sunset * .075})`);
    sunset.addColorStop(1, "rgba(63,89,113,0)"); ctx.fillStyle = sunset; ctx.fillRect(0, 0, width, height);
  }
  ctx.fillStyle = surfaceLighting(ctx, width, height).vignette; ctx.fillRect(0, 0, width, height);
}

type LightMap = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; key?: string };
const lightMaps = new WeakMap<CanvasRenderingContext2D, LightMap>();

/** Lighting varies over hundreds of pixels and several seconds. Sample the washes in a small
 * transparent light map; the original photo, waves and the rig still move on every scene frame. */
function paintCachedLight(ctx: CanvasRenderingContext2D, width: number, height: number, t: number, mood: Mood) {
  let layer = lightMaps.get(ctx);
  if (!layer) {
    const canvas = ctx.canvas?.ownerDocument?.createElement("canvas");
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) { paintLakeLight(ctx, width, height, t, mood); return; }
    layer = { canvas, context }; lightMaps.set(ctx, layer);
  }
  const scale = Math.min(1, 256 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const key = [width, height, Math.floor(t / 2), Math.round(mood.night * 255), Math.round(mood.sunset * 255)].join("|");
  if (key !== layer.key) {
    if (layer.canvas.width !== w || layer.canvas.height !== h) { layer.canvas.width = w; layer.canvas.height = h; }
    layer.context.setTransform(w / width, 0, 0, h / height, 0, 0);
    layer.context.clearRect(0, 0, width, height);
    paintLakeLight(layer.context, width, height, t, mood);
    layer.key = key;
  }
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "low";
  ctx.drawImage(layer.canvas, 0, 0, width, height);
}

/** One opaque lake crop plus the moving water surface in the actual viewport. */
export function paintFishingLandscape(ctx: CanvasRenderingContext2D, width: number, height: number, time: number,
  image?: HTMLImageElement, ambience?: FishingSceneAmbience, scale = 1, still = false) {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) return;
  const t = finiteClock(time, still), mood = fishingSceneAtmosphere(ambience);
  if (image) paintMovingTexture(ctx, image, width, height, t, still);
  else { ctx.fillStyle = "#17677b"; ctx.fillRect(0, 0, width, height); }
  paintCachedLight(ctx, width, height, t, mood);
  const surface = fishingWaterSurfaceFrame(width, height, t, scale, still, mood.night * .8 + mood.sunset * .3);
  surface.currents.forEach(current => drawWaterCurrent(ctx, current));
  surface.glints.forEach(glint => drawWaterGlint(ctx, glint));
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
