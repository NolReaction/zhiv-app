import { WORLD_ART } from "@/features/world/art";

export type SettlementArt = { grass: HTMLImageElement; buildings: HTMLImageElement; fence: HTMLCanvasElement };
let loaded: Promise<SettlementArt> | null = null;
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.decoding = "async";
    image.onload = () => resolve(image); image.onerror = () => reject(new Error("Не удалось загрузить оформление поляны."));
    image.src = src;
  });
}
/** Interpret the neutral atlas matte once, like a colour-keyed sprite sheet.
 * Flood only background-connected pixels; metal inside the fence stays intact. */
export function fenceTexture(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Графика недоступна в этом браузере.");
  ctx.drawImage(image, 0, 0);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height), pixels = frame.data;
  const count = canvas.width * canvas.height, visited = new Uint8Array(count), queue = new Uint32Array(count);
  let read = 0, write = 0;
  const add = (index: number) => {
    if (index < 0 || index >= count || visited[index]) return;
    visited[index] = 1;
    const offset = index * 4, r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
    if (Math.min(r, g, b) > 115 && Math.max(r, g, b) - Math.min(r, g, b) < 32) {
      pixels[offset + 3] = 0; queue[write++] = index;
    }
  };
  for (let x = 0; x < canvas.width; x++) { add(x); add(count - canvas.width + x); }
  for (let y = 0; y < canvas.height; y++) { add(y * canvas.width); add((y + 1) * canvas.width - 1); }
  // The two rail openings are enclosed by wood, so each needs a background seed.
  for (const [x, y] of [[320, 360], [940, 370]]) {
    add(Math.floor(y / 1254 * canvas.height) * canvas.width + Math.floor(x / 1254 * canvas.width));
  }
  while (read < write) {
    const index = queue[read++], x = index % canvas.width;
    if (x > 0) add(index - 1); if (x + 1 < canvas.width) add(index + 1);
    add(index - canvas.width); add(index + canvas.width);
  }
  ctx.putImageData(frame, 0, 0); return canvas;
}
export function loadSettlementArt() {
  if (!loaded) loaded = Promise.all([loadImage(WORLD_ART.settlement.grass), loadImage(WORLD_ART.settlement.buildings), loadImage(WORLD_ART.settlement.fence)])
    .then(([grass, buildings, fence]) => ({ grass, buildings, fence: fenceTexture(fence) }))
    .catch(error => { loaded = null; throw error; });
  return loaded;
}
