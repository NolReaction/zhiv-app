import { EARTH_MODEL_PLACEMENT_IDS } from "@/lib/earth-model-placement-contract.mjs";

export type EarthModelLod = "overview" | "detail";
export type EarthModelTextureKind = "baseColor" | "normal" | "metallicRoughness";
export type EarthModelTextureAsset = { kind: EarthModelTextureKind; bytes: number; width: number; height: number; wrapS: number; wrapT: number };
export type EarthModelAsset = { url: string; bytes: number; sha256: string; vertexCount: number; indexCount: number;
  format?: number; textures?: readonly EarthModelTextureAsset[] };
export type EarthModelAssets = { version: number; overview: EarthModelAsset; detail: EarthModelAsset };
export type EarthModelEncodedTexture = Omit<EarthModelTextureAsset, "bytes"> & { bytes: Uint8Array };
export type EarthModelTexture = Omit<EarthModelTextureAsset, "bytes"> & { image: ImageBitmap };
export type EarthModelMaterial = { metallicFactor: number; roughnessFactor: number; normalScale: number; textures: readonly EarthModelTexture[] };
export type EarthIndexedModel = { vertices: Float32Array; indices: Uint32Array; bytes: number; vertexStride?: 11;
  textureMaterial?: EarthModelMaterial;
  encodedMaterial?: Omit<EarthModelMaterial, "textures"> & { textures: readonly EarthModelEncodedTexture[] } };
export const EARTH_MODEL_MAX_BYTES = 4 * 1024 * 1024;
export const EARTH_MODEL_MAX_VERTICES = 100_000;
export const EARTH_MODEL_MAX_INDICES = 180_000;
export const EARTH_MODEL_TEXTURE_KINDS: readonly EarthModelTextureKind[] = ["baseColor", "normal", "metallicRoughness"];
const LODS: readonly EarthModelLod[] = ["overview", "detail"];
const maximumSize = { baseColor: 1024, normal: 512, metallicRoughness: 256 };
const wraps = new Set([10497, 33071, 33648]);
function reject(): never { throw new Error("Invalid Earth model manifest or geometry"); }

/** Check actual WebP frame dimensions before invoking a browser image decoder. */
function validateTextureFrame(bytes: Uint8Array, width: number, height: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12, image = false, chunks = 0;
  const dimensions = (actualWidth: number, actualHeight: number) => { if (actualWidth !== width || actualHeight !== height) reject(); };
  while (offset < bytes.byteLength) {
    if (++chunks > 16 || offset + 8 > bytes.byteLength) reject();
    const kind = view.getUint32(offset, false), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size + size % 2 > bytes.byteLength) reject();
    if (kind === 0x56503858) { // VP8X: extended canvas, never an animation.
      if (size !== 10 || bytes[start] & 2) reject();
      const uint24 = (position: number) => bytes[position] + bytes[position + 1] * 256 + bytes[position + 2] * 65536;
      dimensions(uint24(start + 4) + 1, uint24(start + 7) + 1);
    } else if (kind === 0x5650384c) { // VP8L: lossless frame.
      if (image || size < 5 || bytes[start] !== 0x2f) reject();
      const packed = view.getUint32(start + 1, true);
      dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1); image = true;
    } else if (kind === 0x56503820) { // VP8: key frame signature and dimensions.
      if (image || size < 10 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) reject();
      dimensions(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff); image = true;
    } else if (kind !== 0x414c5048) reject(); // Only the optional ALPH plane is needed by prepared images.
    offset = start + size + size % 2;
  }
  if (!image || offset !== bytes.byteLength) reject();
}

function validateTextureAssets(asset: EarthModelAsset): number {
  if (asset.format !== 2) {
    if (asset.format !== undefined && asset.format !== 1 || asset.textures !== undefined) reject();
    return 16 + asset.vertexCount * 24 + asset.indexCount * 4;
  }
  if (!Array.isArray(asset.textures) || !asset.textures.length || asset.textures.length > 3 || asset.textures[0].kind !== "baseColor") reject();
  let last = -1, bytes = 0;
  for (const texture of asset.textures as readonly EarthModelTextureAsset[]) {
    const order = EARTH_MODEL_TEXTURE_KINDS.indexOf(texture.kind);
    if (order <= last || !Number.isInteger(texture.bytes) || texture.bytes < 12 || texture.bytes > 2 * 1024 * 1024
      || !Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width < 1 || texture.height < 1
      || texture.width > maximumSize[texture.kind] || texture.height > maximumSize[texture.kind]
      || !wraps.has(texture.wrapS) || !wraps.has(texture.wrapT)) reject();
    last = order; bytes += texture.bytes;
  }
  return 88 + asset.vertexCount * 44 + asset.indexCount * 4 + bytes;
}

function validateAsset(asset: EarthModelAsset) {
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || !Number.isInteger(asset.vertexCount) || asset.vertexCount < 3 || asset.vertexCount > EARTH_MODEL_MAX_VERTICES
    || !Number.isInteger(asset.indexCount) || asset.indexCount < 3 || asset.indexCount % 3 !== 0 || asset.indexCount > EARTH_MODEL_MAX_INDICES
    || !Number.isInteger(asset.bytes) || asset.bytes > EARTH_MODEL_MAX_BYTES || asset.bytes !== validateTextureAssets(asset)) reject();
}

/** The allowlist contains local prepared assets only, never arbitrary URLs or GLBs. */
export function validateEarthModelAssets(value: EarthModelAssets): EarthModelAssets {
  if (!value || value.version !== 1) reject();
  let id: string | null = null;
  for (const lod of LODS) {
    const asset = value[lod]; validateAsset(asset);
    const match = /^\/earth\/models\/([a-z0-9-]+)\/(overview|detail)\.elm$/.exec(asset.url);
    if (!match || !EARTH_MODEL_PLACEMENT_IDS.includes(match[1]) || match[2] !== lod || id !== null && match[1] !== id) reject();
    id = match[1];
  }
  return value;
}

/** Decoding exposes bounded views; image decoding happens later under the loader's abort/deadline fence. */
export function decodeEarthModel(buffer: ArrayBuffer, asset: EarthModelAsset): EarthIndexedModel {
  validateAsset(asset);
  const textured = asset.format === 2, headerBytes = textured ? 88 : 16, stride = textured ? 11 : 6;
  if (buffer.byteLength !== asset.bytes || buffer.byteLength < headerBytes || buffer.byteLength > EARTH_MODEL_MAX_BYTES) reject();
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== (textured ? 0x324d4c45 : 0x314d4c45) || header.getUint32(4, true) !== (textured ? 2 : 1)
    || header.getUint32(8, true) !== asset.vertexCount || header.getUint32(12, true) !== asset.indexCount) reject();
  const vertices = new Float32Array(buffer, headerBytes, asset.vertexCount * stride);
  const indices = new Uint32Array(buffer, headerBytes + asset.vertexCount * stride * 4, asset.indexCount);
  let minimumZ = Infinity, maximumZ = -Infinity;
  for (let offset = 0; offset < vertices.length; offset += stride) {
    for (let component = 0; component < stride; component++) {
      const value = vertices[offset + component];
      if (!Number.isFinite(value) || component < 2 && Math.abs(value) > 1.5
        || component === 2 && (value < -0.00001 || value > 1.00001)
        || component >= 3 && component < 6 && (value < 0 || value > 1)
        || component >= 9 && Math.abs(value) > 64) reject();
    }
    if (textured && Math.abs(Math.hypot(vertices[offset + 6], vertices[offset + 7], vertices[offset + 8]) - 1) > .01) reject();
    minimumZ = Math.min(minimumZ, vertices[offset + 2]); maximumZ = Math.max(maximumZ, vertices[offset + 2]);
  }
  if (Math.abs(minimumZ) > .00001 || Math.abs(maximumZ - 1) > .00001 || indices.some(index => index >= asset.vertexCount)) reject();
  const model: EarthIndexedModel = { vertices, indices, bytes: buffer.byteLength };
  if (!textured) return model;
  model.vertexStride = 11;
  const material = { metallicFactor: header.getFloat32(76, true), roughnessFactor: header.getFloat32(80, true), normalScale: header.getFloat32(84, true) };
  if (!Object.values(material).every(Number.isFinite) || material.metallicFactor < 0 || material.metallicFactor > 1
    || material.roughnessFactor < 0 || material.roughnessFactor > 1 || material.normalScale < 0 || material.normalScale > 16) reject();
  const textures: EarthModelEncodedTexture[] = [];
  let offset = headerBytes + vertices.byteLength + indices.byteLength;
  for (const [index, kind] of EARTH_MODEL_TEXTURE_KINDS.entries()) {
    const start = 16 + index * 20, bytes = header.getUint32(start, true), expected = asset.textures!.find(texture => texture.kind === kind);
    const values = Array.from({ length: 4 }, (_, component) => header.getUint32(start + 4 + component * 4, true));
    if (!expected) { if (bytes || values.some(value => value !== 0)) reject(); continue; }
    if (bytes !== expected.bytes || values.some((value, component) => value !== [expected.width, expected.height, expected.wrapS, expected.wrapT][component])
      || offset + bytes > buffer.byteLength) reject();
    const encoded = new Uint8Array(buffer, offset, bytes), signature = new DataView(buffer, offset, bytes);
    if (signature.getUint32(0, false) !== 0x52494646 || signature.getUint32(8, false) !== 0x57454250
      || signature.getUint32(4, true) + 8 !== bytes) reject();
    validateTextureFrame(encoded, expected.width, expected.height);
    textures.push({ ...expected, bytes: encoded }); offset += bytes;
  }
  if (offset !== buffer.byteLength) reject();
  model.encodedMaterial = { ...material, textures };
  return model;
}
