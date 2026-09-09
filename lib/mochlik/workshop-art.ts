import { HabitatAssetError, loadHabitatImage } from "./assets";
let cached: Promise<HTMLCanvasElement> | null = null;
/** Extract the existing workshop sprite once; the neutral atlas matte never enters the scene. */
export function loadWorkshopArt() {
  return cached ??= loadHabitatImage("/world/buildings-v1.webp").then(image => {
    const canvas = document.createElement("canvas"); canvas.width = 418; canvas.height = 627;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 627, 418, 627, 0, 0, 418, 627);
    const pixels = ctx.getImageData(0, 0, 418, 627);
    let x0 = 418, y0 = 627, x1 = 0, y1 = 0;
    for (let y = 0; y < 627; y++) for (let x = 0; x < 418; x++) {
      const i = (y * 418 + x) * 4, r = pixels.data[i], g = pixels.data[i + 1], b = pixels.data[i + 2];
      if (Math.min(r, g, b) > 140 && Math.max(r, g, b) - Math.min(r, g, b) < 16) pixels.data[i + 3] = 0;
      else { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    if (x1 < x0 || y1 < y0) throw new HabitatAssetError();
    ctx.putImageData(pixels, 0, 0);
    const cropped = document.createElement("canvas"); cropped.width = x1 - x0 + 1; cropped.height = y1 - y0 + 1;
    cropped.getContext("2d")!.drawImage(canvas, x0, y0, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    return cropped;
  }).catch(error => { cached = null; throw error; });
}
