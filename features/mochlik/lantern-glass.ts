import { HOUSE_ANCHORS, HOME_CANVAS_SIZE } from "./home-layout";
import { pointInPolygon } from "@/features/world/map-layout";

const lamp = HOUSE_ANCHORS.lamp;
const point = (x: number, y: number) => ({ x: lamp.x + x, y: lamp.y + y });
// The two inset panes exclude the frame, central divider, cap and base.
const panes = [
  [point(-.6, 2.2), point(2.65, 2.3), point(2.9, 4.4), point(2.75, 7.8), point(.1, 7.65), point(-1.1, 5.8), point(-1, 3.5)],
  [point(3.65, 2.25), point(5.15, 1.95), point(5.45, 3.2), point(5.25, 5.7), point(3.6, 7.45)],
];
const bounds = { x: lamp.x - 2, y: lamp.y + 1, width: 8, height: 8 };
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export type LanternGlass = { texture: HTMLCanvasElement; scale: number };
const cache = new WeakMap<CanvasImageSource, { cropKey: string; glass: LanternGlass | null }>();

/** Prepare only the original pane pixels once per source. A 1024px home tile
 * retains its quarter-unit texture; the fallback samples the 1254px region at 1:1. */
export function prepareLanternGlass(source: CanvasImageSource, crop: { x: number; y: number; size: number }): LanternGlass | null {
  const cropKey = `${crop.x}:${crop.y}:${crop.size}`;
  const existing = cache.get(source);
  if (existing?.cropKey === cropKey) return existing.glass;
  const scale = crop.size / HOME_CANVAS_SIZE;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const texture = document.createElement("canvas");
  texture.width = Math.max(1, Math.round(bounds.width * scale));
  texture.height = Math.max(1, Math.round(bounds.height * scale));
  const ctx = texture.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, crop.x + bounds.x * scale, crop.y + bounds.y * scale,
      bounds.width * scale, bounds.height * scale, 0, 0, texture.width, texture.height);
    const pixels = ctx.getImageData(0, 0, texture.width, texture.height);
    const data = pixels.data;
    for (let row = 0; row < texture.height; row++) for (let column = 0; column < texture.width; column++) {
      const offset = (row * texture.width + column) * 4;
      const r = data[offset], g = data[offset + 1], b = data[offset + 2], alpha = data[offset + 3];
      let coverage = 0;
      // Subpixel coverage avoids a jagged geometric cut at either source resolution.
      for (const dy of [.125, .375, .625, .875]) for (const dx of [.125, .375, .625, .875]) {
        const at = { x: bounds.x + (column + dx) / scale, y: bounds.y + (row + dy) / scale };
        if (panes.some(pane => pointInPolygon(at, pane))) coverage += 1 / 16;
      }
      // Dark texture and low-saturation reflections retain their original pixels.
      const warm = clamp((r - b - 25) / 55) * clamp((g - b - 12) / 45);
      const luminous = clamp((g - 83) / 55);
      const reflection = clamp((b - 165) / 75) * .7;
      const amount = coverage * warm * luminous * (1 - reflection);
      if (amount <= .002) { data[offset + 3] = 0; continue; }
      const luminance = .2126 * r + .7152 * g + .0722 * b;
      // Compress emitted yellow into clear amber glass while retaining local
      // light/dark variation and warmer/cooler details instead of filling a flat color.
      data[offset] = Math.round(28 + luminance * .42 + (r - luminance) * .16);
      data[offset + 1] = Math.round(25 + luminance * .38 + (g - luminance) * .14);
      data[offset + 2] = Math.round(23 + luminance * .31 + (b - luminance) * .10);
      data[offset + 3] = Math.round(alpha * amount);
    }
    ctx.putImageData(pixels, 0, 0);
  } catch {
    // Keep the original painted lantern if source pixels cannot be sampled.
    cache.set(source, { cropKey, glass: null }); return null;
  }
  const glass = { texture, scale };
  cache.set(source, { cropKey, glass });
  return glass;
}

/** Source-over uses only the sampled glass mask; no radial spot or opaque patch. */
export function drawLanternGlass(ctx: CanvasRenderingContext2D, intensity: number, glass: LanternGlass | null) {
  if (!glass) return;
  const off = 1 - (Number.isFinite(intensity) ? clamp(intensity) : 0);
  if (off <= .01) return;
  ctx.save(); ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = off;
  ctx.imageSmoothingEnabled = glass.scale > 1;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(glass.texture, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
}
