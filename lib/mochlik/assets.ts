export class HabitatAssetError extends Error {
  constructor(readonly timedOut = false) { super(timedOut ? "Habitat asset timed out" : "Habitat asset unavailable"); }
}
const images = new Map<string, Promise<HTMLImageElement>>();

/** Shared downloads have a deadline and can be retried after a network failure. */
export function loadHabitatImage(path: string): Promise<HTMLImageElement> {
  const cached = images.get(path); if (cached) return cached;
  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => finish(new HabitatAssetError(true)), 15_000);
    function finish(error?: Error) {
      clearTimeout(timer); image.onload = null; image.onerror = null;
      if (error) reject(error); else resolve(image);
    }
    image.onload = () => finish(); image.onerror = () => finish(new HabitatAssetError()); image.src = path;
  }).catch(error => { images.delete(path); throw error; });
  images.set(path, request); return request;
}

/** Remove only the neutral atlas matte; preserve saturated flowers and pale wood. */
export function atlasSprite(image: HTMLImageElement, cell: { x: number; y: number; width: number; height: number }) {
  const canvas = document.createElement("canvas"); canvas.width = cell.width; canvas.height = cell.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }); if (!ctx) throw new HabitatAssetError();
  ctx.drawImage(image, cell.x, cell.y, cell.width, cell.height, 0, 0, cell.width, cell.height);
  const pixels = ctx.getImageData(0, 0, cell.width, cell.height);
  let left = cell.width, top = cell.height, right = 0, bottom = 0;
  for (let y = 0; y < cell.height; y++) for (let x = 0; x < cell.width; x++) {
    const at = (y * cell.width + x) * 4, r = pixels.data[at], g = pixels.data[at + 1], b = pixels.data[at + 2];
    if (Math.min(r, g, b) > 195 && Math.max(r, g, b) - Math.min(r, g, b) < 12) pixels.data[at + 3] = 0;
    if (pixels.data[at + 3]) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  if (right < left || bottom < top) throw new HabitatAssetError();
  ctx.putImageData(pixels, 0, 0);
  const result = document.createElement("canvas"); result.width = right - left + 1; result.height = bottom - top + 1;
  result.getContext("2d")!.drawImage(canvas, left, top, result.width, result.height, 0, 0, result.width, result.height);
  return result;
}
