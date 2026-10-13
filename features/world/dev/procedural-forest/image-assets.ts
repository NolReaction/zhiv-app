export type ImageAsset = { id: string; name: string; dataUrl: string; width: number; height: number };
export const MAX_PNG_BYTES = 5 * 1024 * 1024;
export const MAX_PNG_SIDE = 4096;
export const MAX_PNG_PIXELS = 16_000_000;
export const MAX_IMAGE_ASSETS = 32;
export const MAX_ASSET_BYTES = 16 * 1024 * 1024;
export const MAX_ASSET_PIXELS = 32_000_000;
const PREFIX = "data:image/png;base64,";
const keys = new Set(["id", "name", "dataUrl", "width", "height"]);

export function cleanImageName(value: string): string {
  const name = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return [...name.normalize("NFC").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim()].slice(0, 120).join("") || "image.png";
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 33 || bytes.length > MAX_PNG_BYTES
    || [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value)) return null;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(8) !== 13 || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return null;
  const width = header.getUint32(16), height = header.getUint32(20);
  const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!width || !height || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE || width * height > MAX_PNG_PIXELS
    || !depths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) return null;
  return { width, height };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function pngError(detail: string): Error { return new Error(`PNG повреждён: ${detail}.`); }

function pngChunks(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data: Uint8Array<ArrayBuffer>[] = [];
  let palette = false, ended = false, dataEnded = false, sawData = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw pngError("оборван блок файла");
    const length = header.getUint32(offset), end = offset + length + 12;
    if (end > bytes.length) throw pngError("неверная длина блока");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) throw pngError("неверный тип блока");
    let crc = 0xffffffff;
    for (let index = offset + 4; index < end - 4; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== header.getUint32(end - 4)) throw pngError("ошибка контрольной суммы блока");
    if ((offset === 8) !== (type === "IHDR")) throw pngError("неверное расположение заголовка");
    if (type === "PLTE") {
      if (palette || sawData || length === 0 || length % 3 || length > 768 || bytes[25] === 0 || bytes[25] === 4
        || (bytes[25] === 3 && length / 3 > 2 ** bytes[24])) throw pngError("неверная палитра");
      palette = true;
    } else if (type === "IDAT") {
      if (dataEnded || (bytes[25] === 3 && !palette)) throw pngError("неверный порядок данных изображения");
      sawData = true;
      if (length) data.push(bytes.subarray(offset + 8, end - 4));
    } else {
      if (sawData) dataEnded = true;
      if (type === "IEND") {
        if (!sawData || length || end !== bytes.length) throw pngError("неверное окончание файла");
        ended = true;
      } else if (type !== "IHDR" && type[0] === type[0].toUpperCase()) throw pngError("неподдерживаемый обязательный блок");
    }
    offset = end;
  }
  if (!ended || !data.length) throw pngError("отсутствуют данные или окончание файла");
  return data;
}

function scanlinePasses(width: number, height: number, depth: number, color: number, interlace: number) {
  const channels = color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 1;
  const layout = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  return layout.map(([x, y, dx, dy]) => ({ columns: Math.max(0, Math.ceil((width - x) / dx)), rows: Math.max(0, Math.ceil((height - y) / dy)) }))
    .filter(pass => pass.columns && pass.rows).map(pass => ({ rows: pass.rows, bytes: 1 + Math.ceil(pass.columns * channels * depth / 8) }));
}

/** Checks chunks and the complete filtered raster stream without allocating a decoded image. */
async function assertPngBytes(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const size = pngSize(bytes);
  if (!size) throw pngError("неверный заголовок или размер изображения");
  const data = pngChunks(bytes);
  const first = new Uint8Array(2);
  let copied = 0, compressedBytes = 0;
  for (const part of data) {
    compressedBytes += part.length;
    for (let index = 0; index < part.length && copied < 2; index++) first[copied++] = part[index];
  }
  if (compressedBytes < 6 || (first[0] & 15) !== 8 || (first[0] >>> 4) > 7
    || ((first[0] << 8) + first[1]) % 31 || (first[1] & 32)) throw pngError("неверный заголовок сжатых данных");
  const passes = scanlinePasses(size.width, size.height, bytes[24], bytes[25], bytes[28]);
  const expected = passes.reduce((sum, pass) => sum + pass.rows * pass.bytes, 0);
  let partIndex = 0, partOffset = 0;
  const compressed = new ReadableStream<BufferSource>({
    pull(controller) {
      if (partIndex === data.length) { controller.close(); return; }
      const part = data[partIndex], end = Math.min(partOffset + 1024, part.length);
      controller.enqueue(part.subarray(partOffset, end));
      partOffset = end;
      if (partOffset === part.length) { partIndex++; partOffset = 0; }
    },
  });
  const reader = compressed.pipeThrough(new DecompressionStream("deflate")).getReader();
  let count = 0, nextFilter = 0, passIndex = 0, row = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.length > expected - count) throw pngError("лишние строки изображения");
      while (nextFilter < count + value.length) {
        if (value[nextFilter - count] > 4) throw pngError("неверный фильтр строки");
        nextFilter += passes[passIndex].bytes;
        if (++row === passes[passIndex].rows) { passIndex++; row = 0; }
      }
      count += value.length;
    }
    if (count !== expected) throw pngError("неполные строки изображения");
  } catch (cause) {
    await reader.cancel().catch(() => {});
    if (cause instanceof Error && cause.message.startsWith("PNG повреждён:")) throw cause;
    throw pngError("оборван или некорректен поток пикселей");
  } finally { reader.releaseLock(); }
}

export async function assertPngDataUrl(dataUrl: string): Promise<void> {
  const bytes = bytesFromUrl(dataUrl);
  if (!bytes) throw pngError("неверное содержимое изображения");
  await assertPngBytes(bytes);
}

/** A deterministic byte fingerprint for asset identity; it never changes PNG encoding. */
function assetId(bytes: Uint8Array): string {
  let first = 2166136261, second = 0x9e3779b9;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 16777619) >>> 0;
    second = Math.imul(second ^ byte, 2246822519) >>> 0;
  }
  return `png:${bytes.length.toString(16)}:${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function byteCount(dataUrl: string): number {
  if (!dataUrl.startsWith(PREFIX)) return NaN;
  const length = dataUrl.length - PREFIX.length;
  if (length <= 0 || length % 4) return NaN;
  return length / 4 * 3 - (dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0);
}

function bytesFromUrl(dataUrl: string): Uint8Array<ArrayBuffer> | null {
  const count = byteCount(dataUrl);
  if (!Number.isFinite(count) || count > MAX_PNG_BYTES) return null;
  const encoded = dataUrl.slice(PREFIX.length);
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (/[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding))) return null;
  try {
    const binary = atob(encoded);
    // Reject alternate padding encodings so one byte sequence has one stored representation.
    if (btoa(binary) !== encoded) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch { return null; }
}

export function validateImageAsset(value: unknown): ImageAsset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const asset = value as Record<string, unknown>;
  if (Object.keys(asset).some(key => !keys.has(key)) || typeof asset.id !== "string" || typeof asset.name !== "string"
    || asset.id.length > 128 || asset.name.length > 240 || typeof asset.dataUrl !== "string" || asset.name !== cleanImageName(asset.name)) return null;
  const bytes = bytesFromUrl(asset.dataUrl), size = bytes && pngSize(bytes);
  if (!bytes || !size || asset.id !== assetId(bytes) || asset.width !== size.width || asset.height !== size.height) return null;
  return { id: asset.id, name: asset.name, dataUrl: asset.dataUrl, ...size };
}

export function sceneAssetsWithinLimits(assets: readonly ImageAsset[]): boolean {
  if (assets.length > MAX_IMAGE_ASSETS) return false;
  let bytes = 0, pixels = 0;
  const ids = new Set<string>();
  for (const asset of assets) {
    const count = byteCount(asset.dataUrl);
    if (!Number.isFinite(count) || count > MAX_PNG_BYTES || ids.has(asset.id)
      || !Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1
      || asset.width > MAX_PNG_SIDE || asset.height > MAX_PNG_SIDE || asset.width * asset.height > MAX_PNG_PIXELS) return false;
    ids.add(asset.id);
    bytes += count; pixels += asset.width * asset.height;
    if (bytes > MAX_ASSET_BYTES || pixels > MAX_ASSET_PIXELS) return false;
  }
  return true;
}

/** Reads the original PNG bytes; neither a canvas nor a resampling operation is used. */
export async function readPngFile(file: File): Promise<ImageAsset> {
  if (!file || file.size > MAX_PNG_BYTES) throw new Error("Выбери PNG размером до 5 МиБ.");
  const bytes = new Uint8Array(await file.arrayBuffer()), size = pngSize(bytes);
  if (!size) throw new Error("Нужен корректный PNG: до 4096 пикселей по стороне и 16 млн пикселей всего.");
  await assertPngBytes(bytes);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { id: assetId(bytes), name: cleanImageName(file.name), dataUrl: PREFIX + btoa(binary), ...size };
}

export function imageObjectSize(asset: Pick<ImageAsset, "width" | "height">): { imageWidth: number; imageHeight: number } {
  const factor = 320 / Math.max(asset.width, asset.height);
  return { imageWidth: asset.width * factor, imageHeight: asset.height * factor };
}
