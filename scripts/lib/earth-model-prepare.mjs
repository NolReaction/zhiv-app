import { createHash } from "node:crypto";
import { MeshoptSimplifier } from "meshoptimizer/simplifier";
import { readEarthModelGlb } from "./earth-model-glb.mjs";

export const EARTH_MODEL_PREPARATION_VERSION = 1;
export const EARTH_MODEL_SIMPLIFIER_VERSION = "1.1.1";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const linearToSrgb = value => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
const light = [-0.35, -0.45, 0.82], lightLength = Math.hypot(...light);

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
  if (config.headingDegrees) {
    const angle = config.headingDegrees * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
    // Geographic clockwise heading: local north turns towards east.
    for (const values of [model.positions, model.normals]) for (let index = 0; index < values.length; index += 3) {
      const x = values[index], y = values[index + 1];
      values[index] = cosine * x + sine * y;
      values[index + 1] = -sine * x + cosine * y;
    }
  }
  const preserveTopFraction = config.preserveTopFraction ?? 0;
  if (!Number.isFinite(preserveTopFraction) || preserveTopFraction < 0 || preserveTopFraction > 0.15)
    throw new Error("Earth model: invalid protected top fraction");
  await MeshoptSimplifier.ready;
  const attributes = new Float32Array(model.positions.length * 2);
  for (let vertex = 0; vertex < model.positions.length / 3; vertex++) {
    attributes.set(model.normals.subarray(vertex * 3, vertex * 3 + 3), vertex * 6);
    attributes.set(model.colors.subarray(vertex * 3, vertex * 3 + 3), vertex * 6 + 3);
  }
  const files = [], manifest = {
    version: 1, id: config.id,
    source: { sha256: sha256(source), bytes: source.byteLength, author: model.attribution.author ?? "",
      license: model.attribution.license ?? "", url: model.attribution.source ?? "", title: model.attribution.title ?? "" },
    coordinates: { axes: "east,north,up", gltfConversion: "x,-z,y", normalizedHeight: 1,
      heightMeters: config.heightMeters, headingDegrees: config.headingDegrees },
    preparation: { version: EARTH_MODEL_PREPARATION_VERSION, simplifier: `meshoptimizer@${EARTH_MODEL_SIMPLIFIER_VERSION}`,
      inputTriangles: model.indices.length / 3, discardedDegenerateTriangles: model.degenerateTriangles, preserveTopFraction,
      sourceHeight: model.sourceHeight, sourceOrigin: model.origin, colors: "linear baseColor + vertexColor, baked diffuse, sRGB output" },
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
    // Permissive crosses exporter normal seams; geometry error still bounds
    // collapse. No sloppy/prune mode: large openings must remain actual holes.
    const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(model.indices, model.positions, 3,
      attributes, 6, [0.1, 0.1, 0.1, 0.4, 0.4, 0.4], locks,
      Math.min(lod.targetTriangles * 3, model.indices.length), lod.error, ["Permissive"]);
    if (!simplified.length || simplified.length > lod.targetTriangles * 3)
      throw new Error(`Earth model: ${lod.name} cannot reach its triangle budget without exceeding the error limit`);
    const indices = simplified.slice(), [remap, count] = MeshoptSimplifier.compactMesh(indices);
    const vertices = new Float32Array(count * 6);
    for (let original = 0; original < remap.length; original++) {
      const next = remap[original];
      if (next === 0xffffffff) continue;
      vertices.set(model.positions.subarray(original * 3, original * 3 + 3), next * 6);
      const normal = model.normals.subarray(original * 3, original * 3 + 3);
      const facing = normal.reduce((sum, value, axis) => sum + value * light[axis], 0) / lightLength;
      const shade = 0.68 + 0.32 * Math.max(0, facing);
      for (let channel = 0; channel < 3; channel++) vertices[next * 6 + 3 + channel] = linearToSrgb(model.colors[original * 3 + channel] * shade);
    }
    const bytes = encodeEarthModel(vertices, indices), name = `${lod.name}.elm`;
    files.push({ name, bytes });
    manifest[lod.name] = { url: `${config.urlPrefix}/${name}`, bytes: bytes.byteLength, sha256: sha256(bytes),
      vertexCount: count, indexCount: indices.length, triangles: indices.length / 3,
      targetTriangles: lod.targetTriangles, error, errorLimit: lod.error, preserveTopFraction: protectedTop };
  }
  return { files, manifest };
}
