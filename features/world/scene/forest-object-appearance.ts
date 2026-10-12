import type { FixedSite } from "@/features/world/tiled/types";

export type ForestObjectMaterial = "wood" | "stone" | "bark" | "foliage";
const artwork = new WeakMap<HTMLImageElement, Map<ForestObjectMaterial, HTMLCanvasElement | HTMLImageElement>>();
const MAX_ARTWORK_SIZE = 1024;
const profiles = {
  wood: { saturation: .94, contrast: .975, bounce: .09, warmth: .025 },
  stone: { saturation: .95, contrast: .985, bounce: .07, warmth: .035 },
  bark: { saturation: 1.025, contrast: .985, bounce: .07, warmth: .025 },
  foliage: { saturation: .985, contrast: .97, bounce: .10, warmth: .015 },
} as const;

export function forestSiteMaterial(site: Pick<FixedSite, "id">): ForestObjectMaterial {
  if (site.id === "home") return "bark";
  if (site.id === "quarry" || site.id === "lighthouse") return "stone";
  return "wood";
}

/** Warm highlights and reflected forest light in the darks; never alters alpha,
 * transparent RGB, silhouette, or the source PNG. The scene still owns day/night. */
export function harmonizeForestPixels(pixels: Uint8ClampedArray, material: ForestObjectMaterial) {
  const profile = profiles[material];
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
    const luminance = r * .2126 + g * .7152 + b * .0722;
    const shadow = Math.max(0, 1 - luminance / 155) * profile.bounce;
    const light = Math.max(0, (luminance - 90) / 165) * profile.warmth;
    // A small contrast reduction softens imported ink without spatial blur.
    const red = ((luminance + (r - luminance) * profile.saturation) - 128) * profile.contrast + 128;
    const green = ((luminance + (g - luminance) * profile.saturation) - 128) * profile.contrast + 128;
    const blue = ((luminance + (b - luminance) * profile.saturation) - 128) * profile.contrast + 128;
    pixels[offset] = red * (1 - shadow - light) + 43 * shadow + 239 * light;
    pixels[offset + 1] = green * (1 - shadow - light) + 61 * shadow + 218 * light;
    pixels[offset + 2] = blue * (1 - shadow - light) + 32 * shadow + 155 * light;
  }
}

/** One bounded offscreen surface per image/material shared by both cameras and
 * the bush foreground pass. Use drawImage's five-argument form: it may be smaller
 * than the source PNG. Unreadable artwork remains drawable without processing. */
export function forestObjectArtwork(image: HTMLImageElement, material: ForestObjectMaterial): HTMLCanvasElement | HTMLImageElement {
  if (!image.naturalWidth || !image.naturalHeight || typeof document === "undefined") return image;
  let byMaterial = artwork.get(image);
  if (!byMaterial) { byMaterial = new Map(); artwork.set(image, byMaterial); }
  const cached = byMaterial.get(material);
  if (cached) return cached;
  let result: HTMLCanvasElement | HTMLImageElement = image;
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, MAX_ARTWORK_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      harmonizeForestPixels(pixels.data, material);
      ctx.putImageData(pixels, 0, 0);
      result = canvas;
    }
  } catch { /* Canvas can be unavailable or tainted; retain the original artwork. */ }
  byMaterial.set(material, result);
  return result;
}
