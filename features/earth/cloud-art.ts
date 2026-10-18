/** Original continuous cloud material: no bitmaps, icons or external imagery. */
export const EARTH_CLOUD_TILE_SIZE = 256;
export const EARTH_CLOUD_TILE_SPAN = 2048;
export type EarthCloudMaterial = { coverage: number; night: boolean; storm: boolean };
export type EarthCloudClip = { left: number; right: number; top: number; bottom: number; feather: number };
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const smooth = (value: number) => { const n = clamp(value); return n * n * (3 - 2 * n); };
export function earthCloudSeed(value: string) {
  let seed = 2166136261;
  for (let index = 0; index < value.length; index++) seed = Math.imul(seed ^ value.charCodeAt(index), 16777619);
  return seed >>> 0;
}
function hash(x: number, y: number, seed: number) {
  let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967295;
}
function noise(x: number, y: number, seed: number, period = 0) {
  const left = Math.floor(x), top = Math.floor(y), u = smooth(x - left), v = smooth(y - top);
  const wrap = (n: number) => period ? ((n % period) + period) % period : n;
  const a = hash(wrap(left), top, seed), b = hash(wrap(left + 1), top, seed);
  const c = hash(wrap(left), top + 1, seed), d = hash(wrap(left + 1), top + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
function density(x: number, y: number, seed: number, worldSize: number) {
  return .52 * noise(x / 512, y / 512, seed, worldSize / 512)
    + .29 * noise(x / 256 + 17, y / 256 - 3, seed ^ 0x1a3f, worldSize / 256)
    + .14 * noise(x / 64 - 11, y / 64 + 7, seed ^ 0x94fb, worldSize / 64)
    + .05 * noise(x / 16 + 6, y / 16 + 5, seed ^ 0x23c1, worldSize / 16);
}

/** Neighbouring atlas tiles share exactly the same world-space noise and edges. */
export function earthCloudTilePixels(originX: number, originY: number, worldSize: number, seed: number,
  material: EarthCloudMaterial, size = EARTH_CLOUD_TILE_SIZE, span = EARTH_CLOUD_TILE_SPAN, clip?: EarthCloudClip) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const coverage = clamp(material.coverage), threshold = .72 - coverage * .39;
  if (!coverage) return pixels;
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
    const x = originX + column / (size - 1) * span;
    const y = originY + row / (size - 1) * span;
    const mass = density(x, y, seed, worldSize);
    const body = smooth((mass - threshold) / .23);
    const light = clamp(.62 + (density(x - 28, y - 22, seed, worldSize) - mass) * 3 + body * .12);
    const at = (row * size + column) * 4;
    const shade = material.night ? [145, 177, 184] : material.storm ? [175, 197, 200] : [221, 232, 228];
    pixels[at] = shade[0] + light * (material.night ? 39 : 30);
    pixels[at + 1] = shade[1] + light * 22;
    pixels[at + 2] = shade[2] + light * 21;
    const distance = clip ? Math.min(x - clip.left, clip.right - x, y - clip.top, clip.bottom - y) : Infinity;
    const edge = clip ? smooth(distance / clip.feather) : 1;
    pixels[at + 3] = Math.min(89, Math.round((coverage * 8 + body * (material.storm ? 87 : 79)) * edge));
  }
  return pixels;
}

/** A finite wispy silhouette for decorative overview clouds, unrelated to weather. */
export function earthCloudBankPixels(seed: number, width = 256, height = 128) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const x = column / (width - 1) * 2 - 1, y = row / (height - 1) * 2 - 1;
    const bend = .18 * Math.sin(x * 3 + seed % 7);
    const envelope = Math.exp(-((x * 1.38) ** 2 + ((y + bend) * 2.0) ** 2));
    const grain = .6 * noise(x * 3 + 12, y * 3 + 9, seed) + .28 * noise(x * 8 + 11, y * 8 + 5, seed ^ 0x8731)
      + .12 * noise(x * 18 + 19, y * 18 + 9, seed ^ 0x84e2);
    const body = smooth((envelope * .75 + grain * .65 - .6) / .5);
    const rim = smooth((1 - Math.max(Math.abs(x), Math.abs(y))) / .18);
    const light = clamp(.25 + grain * .95 - y * .12);
    const at = (row * width + column) * 4;
    pixels[at] = 170 + light * 75;
    pixels[at + 1] = 193 + light * 60;
    pixels[at + 2] = 196 + light * 54;
    pixels[at + 3] = Math.round(body * rim * 195);
  }
  return pixels;
}
