import { createHash } from "node:crypto";
import { MeshoptSimplifier } from "meshoptimizer/simplifier";
import sharp from "sharp";
import { readEarthModelGlb } from "./earth-model-glb.mjs";

export const EARTH_MODEL_PREPARATION_VERSION = 1;
export const EARTH_MODEL_SIMPLIFIER_VERSION = "1.1.1";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const linearToSrgb = value => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
const light = [-0.35, -0.45, 0.82], lightLength = Math.hypot(...light);
const textureKinds = ["baseColor", "normal", "metallicRoughness"];
const defaultTextureSizes = { overview: { baseColor: 256, normal: 128, metallicRoughness: 64 },
  detail: { baseColor: 1024, normal: 512, metallicRoughness: 256 } };

/** ELM2 keeps linear color factors, normals and UVs for runtime lighting. */
export function encodeTexturedEarthModel(vertices, indices, textures, material) {
  if (!(vertices instanceof Float32Array) || !vertices.length || vertices.length % 11 || !(indices instanceof Uint32Array)
    || !indices.length || indices.length % 3 || vertices.length / 11 > 50_000 || indices.length > 120_000)
    throw new Error("Earth model: invalid textured geometry budget");
  for (let vertex = 0; vertex < vertices.length; vertex += 11) {
    for (let channel = 0; channel < 11; channel++) {
      const value = vertices[vertex + channel];
      if (!Number.isFinite(value) || channel < 3 && Math.abs(value) > 1.5
        || channel === 2 && (value < -1e-6 || value > 1.000001)
        || channel >= 3 && channel < 6 && (value < 0 || value > 1)
        || channel >= 6 && channel < 9 && Math.abs(value) > 1.000001
        || channel >= 9 && Math.abs(value) > 64) throw new Error("Earth model: invalid textured vertex");
    }
    if (Math.abs(Math.hypot(...vertices.subarray(vertex + 6, vertex + 9)) - 1) > .001)
      throw new Error("Earth model: invalid textured normal");
  }
  for (const index of indices) if (index >= vertices.length / 11) throw new Error("Earth model: invalid textured index");
  for (let offset = 0; offset < indices.length; offset += 3) {
    const [a, b, c] = Array.from(indices.subarray(offset, offset + 3), index => index * 11);
    const u = [0, 1, 2].map(axis => vertices[b + axis] - vertices[a + axis]);
    const v = [0, 1, 2].map(axis => vertices[c + axis] - vertices[a + axis]);
    if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) < 1e-14)
      throw new Error("Earth model: degenerate textured triangle");
  }
  if (!Array.isArray(textures) || !textures.length || textures.length > 3 || textures[0].kind !== "baseColor"
    || textures.some((texture, index) => !textureKinds.includes(texture.kind) || index && textureKinds.indexOf(texture.kind) <= textureKinds.indexOf(textures[index - 1].kind)))
    throw new Error("Earth model: invalid prepared texture slots");
  for (const texture of textures) if (!Buffer.isBuffer(texture.bytes) || texture.bytes.length < 12 || texture.bytes.length > 2 * 1024 * 1024
    || texture.bytes.toString("ascii", 0, 4) !== "RIFF" || texture.bytes.toString("ascii", 8, 12) !== "WEBP"
    || texture.bytes.readUInt32LE(4) + 8 !== texture.bytes.length || !Number.isInteger(texture.width) || !Number.isInteger(texture.height)
    || texture.width < 1 || texture.height < 1 || texture.width > 1024 || texture.height > 1024
    || ![10497, 33071, 33648].includes(texture.wrapS) || ![10497, 33071, 33648].includes(texture.wrapT))
    throw new Error("Earth model: invalid prepared texture");
  if (!material || ![material.metallicFactor, material.roughnessFactor, material.normalScale].every(Number.isFinite)
    || material.metallicFactor < 0 || material.metallicFactor > 1 || material.roughnessFactor < 0 || material.roughnessFactor > 1
    || material.normalScale < 0 || material.normalScale > 4) throw new Error("Earth model: invalid prepared material factors");
  const bytes = Buffer.alloc(88 + vertices.byteLength + indices.byteLength + textures.reduce((sum, texture) => sum + texture.bytes.length, 0));
  bytes.write("ELM2", 0, "ascii"); bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(vertices.length / 11, 8); bytes.writeUInt32LE(indices.length, 12);
  for (const texture of textures) {
    const offset = 16 + textureKinds.indexOf(texture.kind) * 20;
    [texture.bytes.length, texture.width, texture.height, texture.wrapS, texture.wrapT].forEach((value, index) => bytes.writeUInt32LE(value, offset + index * 4));
  }
  bytes.writeFloatLE(material.metallicFactor, 76); bytes.writeFloatLE(material.roughnessFactor, 80); bytes.writeFloatLE(material.normalScale, 84);
  for (let index = 0; index < vertices.length; index++) bytes.writeFloatLE(vertices[index], 88 + index * 4);
  for (let index = 0; index < indices.length; index++) bytes.writeUInt32LE(indices[index], 88 + vertices.byteLength + index * 4);
  let offset = 88 + vertices.byteLength + indices.byteLength;
  for (const texture of textures) { texture.bytes.copy(bytes, offset); offset += texture.bytes.length; }
  return bytes;
}

async function prepareTextures(textures, lod) {
  const sizes = { ...defaultTextureSizes[lod.name], ...lod.textureSizes };
  for (const [kind, value] of Object.entries(sizes)) if (!textureKinds.includes(kind) || !Number.isInteger(value)
    || value < 16 || value > defaultTextureSizes[lod.name][kind] || (value & value - 1)) throw new Error("Earth model: invalid LOD texture size");
  const result = [];
  for (const texture of textures) {
    const image = sharp(texture.bytes, { limitInputPixels: 4096 * 4096, failOn: "warning", sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.width !== texture.width || metadata.height !== texture.height || metadata.pages && metadata.pages !== 1)
      throw new Error("Earth model: invalid decoded texture dimensions");
    const pipeline = image.resize({ width: sizes[texture.kind], height: sizes[texture.kind], fit: "inside", withoutEnlargement: true });
    // Normal/roughness maps contain data, not sRGB color; avoid color transforms,
    // lossy encoding and alpha premultiplication on those channels.
    const bytes = await pipeline.webp(texture.kind === "baseColor" ? { quality: 85, effort: 6 } : { lossless: true, effort: 6 }).toBuffer();
    const prepared = await sharp(bytes, { limitInputPixels: 1024 * 1024, failOn: "warning" }).metadata();
    if (prepared.format !== "webp" || !prepared.width || !prepared.height || prepared.width > sizes[texture.kind] || prepared.height > sizes[texture.kind])
      throw new Error("Earth model: invalid encoded texture dimensions");
    result.push({ kind: texture.kind, bytes, width: prepared.width, height: prepared.height, wrapS: texture.wrapS, wrapT: texture.wrapT });
  }
  return result;
}

/** The browser consumes fixed, indexed position/color geometry, never the GLB. */
export function encodeEarthModel(vertices, indices) {
  if (!(vertices instanceof Float32Array) || vertices.length % 6 || !(indices instanceof Uint32Array)
    || !indices.length || indices.length % 3 || vertices.length / 6 > 50_000 || indices.length > 120_000)
    throw new Error("Earth model: invalid prepared geometry budget");
  for (let index = 0; index < vertices.length; index++) {
    const value = vertices[index], channel = index % 6;
    if (!Number.isFinite(value) || channel < 3 && Math.abs(value) > 1.5
      || channel === 2 && (value < -1e-6 || value > 1.000001) || channel >= 3 && (value < 0 || value > 1))
      throw new Error("Earth model: invalid prepared vertex");
  }
  for (const index of indices) if (index >= vertices.length / 6) throw new Error("Earth model: invalid prepared index");
  for (let offset = 0; offset < indices.length; offset += 3) {
    const [a, b, c] = Array.from(indices.subarray(offset, offset + 3), index => index * 6);
    const u = [0, 1, 2].map(axis => vertices[b + axis] - vertices[a + axis]);
    const v = [0, 1, 2].map(axis => vertices[c + axis] - vertices[a + axis]);
    if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) < 1e-14)
      throw new Error("Earth model: degenerate prepared triangle");
  }
  const bytes = Buffer.alloc(16 + vertices.byteLength + indices.byteLength);
  bytes.write("ELM1", 0, "ascii"); bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(vertices.length / 6, 8); bytes.writeUInt32LE(indices.length, 12);
  for (let index = 0; index < vertices.length; index++) bytes.writeFloatLE(vertices[index], 16 + index * 4);
  for (let index = 0; index < indices.length; index++) bytes.writeUInt32LE(indices[index], 16 + vertices.byteLength + index * 4);
  return bytes;
}

export async function prepareEarthModelGeometry(source, config) {
  if (!config || !/^[a-z0-9-]+$/.test(config.id) || !/^\/earth\/models\/[a-z0-9/-]+$/.test(config.urlPrefix)
    || !Number.isFinite(config.heightMeters) || config.heightMeters <= 0 || config.heightMeters > 1000
    || !Number.isFinite(config.headingDegrees) || Math.abs(config.headingDegrees) > 360
    || !Array.isArray(config.lods) || config.lods.length !== 2
    || config.lods[0].name !== "overview" || config.lods[1].name !== "detail") throw new Error("Earth model: invalid preparation config");
  // Reject all budgets before source parsing or the simplifier allocates work.
  for (const [index, lod] of config.lods.entries()) {
    if (!Number.isInteger(lod.targetTriangles) || lod.targetTriangles < 4 || lod.targetTriangles > 40_000
      || !Number.isFinite(lod.error) || lod.error <= 0 || lod.error > 0.05
      || index > 0 && (lod.targetTriangles < config.lods[index - 1].targetTriangles || lod.error > config.lods[index - 1].error))
      throw new Error("Earth model: invalid LOD budget");
  }
  const model = readEarthModelGlb(source);
  const textured = Boolean(model.textures), attributeStride = textured ? 8 : 6;
  if (config.headingDegrees) {
    const angle = config.headingDegrees * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
    // Geographic clockwise heading: local north turns towards east.
    for (const values of [model.positions, model.normals]) for (let index = 0; index < values.length; index += 3) {
      const x = values[index], y = values[index + 1];
      values[index] = cosine * x + sine * y;
      values[index + 1] = -sine * x + cosine * y;
    }
  }
  // Source bounds, after transforms/normalization/heading and before LOD,
  // describe broad landmarks accurately for the editor's camera framing.
  let bounds;
  if (textured) {
    bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let index = 0; index < model.positions.length; index++) {
      const axis = index % 3, value = model.positions[index];
      bounds.min[axis] = Math.min(bounds.min[axis], value); bounds.max[axis] = Math.max(bounds.max[axis], value);
    }
  }
  const preserveTopFraction = config.preserveTopFraction ?? 0;
  if (!Number.isFinite(preserveTopFraction) || preserveTopFraction < 0 || preserveTopFraction > 0.15)
    throw new Error("Earth model: invalid protected top fraction");
  await MeshoptSimplifier.ready;
  const attributes = new Float32Array(model.positions.length / 3 * attributeStride);
  for (let vertex = 0; vertex < model.positions.length / 3; vertex++) {
    attributes.set(model.normals.subarray(vertex * 3, vertex * 3 + 3), vertex * attributeStride);
    attributes.set(model.colors.subarray(vertex * 3, vertex * 3 + 3), vertex * attributeStride + 3);
    if (textured) attributes.set(model.uvs.subarray(vertex * 2, vertex * 2 + 2), vertex * attributeStride + 6);
  }
  const files = [], manifest = {
    version: 1, id: config.id,
    source: { sha256: sha256(source), bytes: source.byteLength, author: model.attribution.author ?? "",
      license: model.attribution.license ?? "", url: model.attribution.source ?? "", title: model.attribution.title ?? "" },
    coordinates: { axes: "east,north,up", gltfConversion: "x,-z,y", normalizedHeight: 1,
      heightMeters: config.heightMeters, headingDegrees: config.headingDegrees, ...(textured ? { bounds } : {}) },
    preparation: { version: textured ? 2 : EARTH_MODEL_PREPARATION_VERSION, simplifier: `meshoptimizer@${EARTH_MODEL_SIMPLIFIER_VERSION}`,
      inputTriangles: model.indices.length / 3, discardedDegenerateTriangles: model.degenerateTriangles, preserveTopFraction,
      sourceHeight: model.sourceHeight, sourceOrigin: model.origin, colors: textured
        ? "linear baseColor + vertexColor; sRGB baseColor texture; runtime normal/metallic/roughness lighting"
        : "linear baseColor + vertexColor, baked diffuse, sRGB output" },
  };
  for (const lod of config.lods) {
    const protectedTop = lod.preserveTopFraction ?? preserveTopFraction;
    if (!Number.isFinite(protectedTop) || protectedTop < 0 || protectedTop > 0.15) throw new Error("Earth model: invalid LOD protected top");
    const locks = new Uint8Array(model.positions.length / 3);
    for (let vertex = 0; vertex < locks.length; vertex++) {
      const z = model.positions[vertex * 3 + 2];
      // Keep ground/height. A fragile ornamental cap can have its own budget.
      if (z < 1e-6 || z >= 1 - Math.max(protectedTop, 1e-6)) locks[vertex] = 1;
    }
    // The original untextured exporter requires permissive normal seams. For
    // textured models the default topology rules preserve UV discontinuities.
    // No sloppy/prune mode: large openings must remain actual holes.
    const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(model.indices, model.positions, 3,
      attributes, attributeStride, textured ? [0.05, 0.05, 0.05, 0.4, 0.4, 0.4, 0.1, 0.1] : [0.1, 0.1, 0.1, 0.4, 0.4, 0.4], locks,
      Math.min(lod.targetTriangles * 3, model.indices.length), lod.error, textured ? [] : ["Permissive"]);
    if (!simplified.length || simplified.length > lod.targetTriangles * 3)
      throw new Error(`Earth model: ${lod.name} cannot reach its triangle budget without exceeding the error limit`);
    const indices = simplified.slice(), [remap, count] = MeshoptSimplifier.compactMesh(indices);
    const stride = textured ? 11 : 6, vertices = new Float32Array(count * stride);
    for (let original = 0; original < remap.length; original++) {
      const next = remap[original];
      if (next === 0xffffffff) continue;
      vertices.set(model.positions.subarray(original * 3, original * 3 + 3), next * stride);
      const normal = model.normals.subarray(original * 3, original * 3 + 3);
      if (textured) {
        vertices.set(model.colors.subarray(original * 3, original * 3 + 3), next * stride + 3);
        vertices.set(normal, next * stride + 6);
        vertices.set(model.uvs.subarray(original * 2, original * 2 + 2), next * stride + 9);
        continue;
      }
      const facing = normal.reduce((sum, value, axis) => sum + value * light[axis], 0) / lightLength;
      const shade = 0.68 + 0.32 * Math.max(0, facing);
      for (let channel = 0; channel < 3; channel++) vertices[next * 6 + 3 + channel] = linearToSrgb(model.colors[original * 3 + channel] * shade);
    }
    const textures = textured ? await prepareTextures(model.textures, lod) : undefined;
    const bytes = textured ? encodeTexturedEarthModel(vertices, indices, textures, model.material) : encodeEarthModel(vertices, indices), name = `${lod.name}.elm`;
    files.push({ name, bytes });
    manifest[lod.name] = { url: `${config.urlPrefix}/${name}`, bytes: bytes.byteLength, sha256: sha256(bytes),
      vertexCount: count, indexCount: indices.length, triangles: indices.length / 3,
      targetTriangles: lod.targetTriangles, error, errorLimit: lod.error, preserveTopFraction: protectedTop,
      ...(textured ? { format: 2, textures: textures.map(({ kind, bytes, width, height, wrapS, wrapT }) => ({ kind, bytes: bytes.length, width, height, wrapS, wrapT })) } : {}) };
  }
  return { files, manifest };
}
