import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readEarthModelGlb } from "../scripts/lib/earth-model-glb.mjs";
import { encodeEarthModel, prepareEarthModelGeometry } from "../scripts/lib/earth-model-prepare.mjs";
import { prepareEarthModel, readEarthModelSource } from "../scripts/prepare-earth-model.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const close = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const config = () => ({ id: "test-tower", urlPrefix: "/earth/models/test-tower", heightMeters: 330, headingDegrees: 0,
  lods: [{ name: "overview", targetTriangles: 4, error: .02 }, { name: "detail", targetTriangles: 4, error: .01 }] });

function glb(json, binary) {
  const text = Buffer.from(JSON.stringify(json)), jsonSize = Math.ceil(text.length / 4) * 4, binSize = Math.ceil(binary.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonSize + binSize);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonSize, 12); bytes.writeUInt32LE(0x4e4f534a, 16); bytes.fill(0x20, 20, 20 + jsonSize); text.copy(bytes, 20);
  bytes.writeUInt32LE(binSize, 20 + jsonSize); bytes.writeUInt32LE(0x004e4942, 24 + jsonSize); binary.copy(bytes, 28 + jsonSize);
  return bytes;
}

function fixture({ change = () => {}, unused = false, degenerate = false, colors = false, transform = false, mirrored = false, normals = false } = {}) {
  const positions = [0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1];
  if (unused) positions.push(1e6, 1e6, 1e6);
  const triangles = [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
  if (degenerate) triangles.push(0, 0, 0);
  const pieces = [Buffer.from(new Float32Array(positions).buffer), Buffer.from(new Uint16Array(triangles).buffer)];
  const views = [{ buffer: 0, byteOffset: 0, byteLength: pieces[0].length }, { buffer: 0, byteOffset: pieces[0].length, byteLength: pieces[1].length }];
  const accessors = [{ bufferView: 0, componentType: 5126, type: "VEC3", count: positions.length / 3 },
    { bufferView: 1, componentType: 5123, type: "SCALAR", count: triangles.length }];
  const primitive = { attributes: { POSITION: 0 }, indices: 1, material: 0 };
  const append = (bytes, type, componentType, normalized) => {
    views.push({ buffer: 0, byteOffset: pieces.reduce((sum, piece) => sum + piece.length, 0), byteLength: bytes.length });
    pieces.push(bytes); accessors.push({ bufferView: views.length - 1, componentType, type, count: positions.length / 3, ...(normalized ? { normalized: true } : {}) });
    return accessors.length - 1;
  };
  if (colors) primitive.attributes.COLOR_0 = append(Buffer.from(Array.from({ length: positions.length / 3 }, () => [255, 128, 0, 255]).flat()), "VEC4", 5121, true);
  if (normals) primitive.attributes.NORMAL = append(Buffer.from(new Float32Array(Array.from({ length: positions.length / 3 }, () => [Math.SQRT1_2, Math.SQRT1_2, 0]).flat()).buffer), "VEC3", 5126);
  const binary = Buffer.concat(pieces), json = {
    asset: { version: "2.0", extras: { author: "Fixture author", license: "CC0", source: "https://example.invalid/source", title: "Fixture" } },
    buffers: [{ byteLength: binary.length }], bufferViews: views, accessors,
    meshes: [{ primitives: [primitive] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [.25, .5, .75, 1] } }],
    nodes: [{ children: [1], ...(transform ? { translation: [5, 7, -2] } : {}) },
      { mesh: 0, ...(transform ? { scale: [mirrored ? -2 : 2, 3, 4] } : {}) }], scenes: [{ nodes: [0] }], scene: 0,
  };
  change(json, binary);
  return glb(json, binary);
}

function unpack(bytes) {
  const vertexCount = bytes.readUInt32LE(8), indexCount = bytes.readUInt32LE(12);
  return { vertices: new Float32Array(bytes.buffer, bytes.byteOffset + 16, vertexCount * 6),
    indices: new Uint32Array(bytes.buffer, bytes.byteOffset + 16 + vertexCount * 24, indexCount) };
}

test("GLB preparation applies nested transforms, ENU axes, height/base normalization and inverse-transpose normals", () => {
  const model = readEarthModelGlb(fixture({ transform: true, normals: true }));
  assert.equal(model.sourceHeight, 6); assert.deepEqual(model.origin, [6, 0, 7]);
  const expected = [-1 / 6, 1 / 3, 0, 1 / 6, 1 / 3, 0, -1 / 6, 1 / 3, 1, -1 / 6, -1 / 3, 0];
  model.positions.forEach((value, index) => close(value, expected[index]));
  const normalLength = Math.hypot(1 / 2, 1 / 3);
  close(model.normals[0], .5 / normalLength); close(model.normals[1], 0); close(model.normals[2], (1 / 3) / normalLength);
  const mirrored = readEarthModelGlb(fixture({ transform: true, mirrored: true }));
  assert.deepEqual([...mirrored.indices.subarray(0, 3)], [0, 1, 2], "negative determinant restores triangle winding");
});

test("discarded degenerates and unreferenced exporter vertices never alter bounds, locks or prepared geometry", async () => {
  const source = fixture(), extra = fixture({ unused: true, degenerate: true }), model = readEarthModelGlb(extra);
  assert.equal(model.degenerateTriangles, 1); assert.equal(model.positions.length / 3, 4);
  assert.deepEqual([...model.positions], [...readEarthModelGlb(source).positions]);
  const a = await prepareEarthModelGeometry(source, config()), b = await prepareEarthModelGeometry(extra, config());
  assert.deepEqual(a.files, b.files); assert.equal(b.manifest.preparation.discardedDegenerateTriangles, 1);
});

test("normalized vertex colors multiply linear material color and bake diffuse into sRGB; heading rotates east/north clockwise", async () => {
  const source = fixture({ colors: true }), raw = readEarthModelGlb(source);
  close(raw.colors[0], .25); close(raw.colors[1], .5 * 128 / 255); close(raw.colors[2], 0);
  const a = await prepareEarthModelGeometry(source, config());
  const b = await prepareEarthModelGeometry(source, { ...config(), headingDegrees: 90 });
  const av = unpack(a.files[0].bytes).vertices, bv = unpack(b.files[0].bytes).vertices;
  for (let vertex = 0; vertex < av.length; vertex += 6) {
    close(bv[vertex], av[vertex + 1]); close(bv[vertex + 1], -av[vertex]); close(bv[vertex + 2], av[vertex + 2]);
    const original = [...Array(raw.positions.length / 3).keys()].find(index => [0, 1, 2].every(axis => raw.positions[index * 3 + axis] === av[vertex + axis]));
    assert.notEqual(original, undefined);
    const light = [-.35, -.45, .82], facing = light.reduce((sum, value, axis) => sum + value * raw.normals[original * 3 + axis], 0) / Math.hypot(...light);
    const linear = .25 * (.68 + .32 * Math.max(0, facing));
    close(av[vertex + 3], 1.055 * linear ** (1 / 2.4) - .055);
    assert.equal(av[vertex + 5], 0);
  }
});

test("the offline profile rejects external resources, unsupported appearance, invalid buffers and cyclic or singular transforms", () => {
  for (const change of [
    json => json.buffers[0].uri = "https://example.invalid/mesh.bin",
    json => json.images = [{ uri: "data:image/png;base64," }],
    json => json.textures = [{}],
    json => json.extensionsUsed = ["KHR_draco_mesh_compression"],
    json => json.animations = [{}],
    json => json.skins = [{}],
    json => json.nodes[1].skin = 0,
    json => json.nodes[1].weights = [1],
    json => json.meshes[0].primitives[0].targets = [{}],
    json => json.meshes[0].primitives[0].mode = 1,
    json => json.materials[0].alphaMode = "BLEND",
    json => json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 },
    json => json.materials[0].pbrMetallicRoughness.baseColorFactor[3] = .5,
    json => json.materials[0].emissiveFactor = [1, 0, 0],
    json => json.accessors[0].sparse = {},
    json => json.accessors[0].byteOffset = 4,
    json => json.bufferViews[0].byteStride = 256,
    json => json.bufferViews[0].buffer = 1,
    json => json.nodes[1].children = [0],
    json => json.nodes[1].scale = [0, 1, 1],
    json => json.nodes[1].rotation = [0, 0, 0, 2],
    (json, bytes) => bytes.writeFloatLE(NaN, 0),
    (json, bytes) => bytes.writeUInt16LE(4, json.bufferViews[1].byteOffset),
  ]) assert.throws(() => readEarthModelGlb(fixture({ change })), /Earth model GLB:/);
  for (const mutate of [
    bytes => bytes.writeUInt32LE(1, 4), bytes => bytes.writeUInt32LE(bytes.length + 4, 8),
    bytes => bytes.writeUInt32LE(bytes.readUInt32LE(12) + 1, 12),
  ]) { const bytes = fixture(); mutate(bytes); assert.throws(() => readEarthModelGlb(bytes), /Earth model GLB:/); }
  const padded = Buffer.concat([Buffer.from([9]), fixture(), Buffer.from([9])]);
  assert.equal(readEarthModelGlb(padded.subarray(1, -1)).indices.length, 12, "typed-array offsets are respected");
});

test("source work limits count vertices, all source indices and repeated instances before accessor allocations", () => {
  assert.throws(() => readEarthModelGlb(fixture({ change: json => json.accessors[0].count = 1_000_001 })), /vertex budget/);
  assert.throws(() => readEarthModelGlb(fixture({ change: json => json.accessors[1].count = 3_000_003 })), /source triangle budget/);
  assert.throws(() => readEarthModelGlb(fixture({ change: json => { json.scenes[0].nodes = Array(1025).fill(1); } })), /node graph/);
  assert.throws(() => readEarthModelGlb(fixture({ change: json => { json.nodes[1].scale = [10, 1, 1]; } })), /normalized bounds/);
});

test("preparation rejects invalid or reversed LOD budgets and encoder rejects invalid output geometry", async () => {
  for (const patch of [
    { id: "../escape" }, { urlPrefix: "https://example.invalid/models" }, { heightMeters: 0 }, { heightMeters: 1001 },
    { headingDegrees: NaN }, { preserveTopFraction: .151 },
    { lods: [{ name: "overview", targetTriangles: 40_001, error: .02 }, config().lods[1]] },
    { lods: [{ name: "overview", targetTriangles: 10, error: .001 }, config().lods[1]] },
    { lods: [config().lods[0], { name: "detail", targetTriangles: 4, error: .03 }] },
  ]) await assert.rejects(prepareEarthModelGeometry(fixture(), { ...config(), ...patch }), /Earth model:/);
  const vertices = new Float32Array([-.2, -.2, 0, .5, .5, .5, .2, -.2, 0, .5, .5, .5, 0, .2, 1, .5, .5, .5]);
  assert.equal(encodeEarthModel(vertices, new Uint32Array([0, 1, 2])).toString("ascii", 0, 4), "ELM1");
  assert.throws(() => encodeEarthModel(vertices, new Uint32Array([0, 1, 3])), /index/);
  assert.throws(() => encodeEarthModel(vertices, new Uint32Array([0, 0, 2])), /degenerate/);
  for (const [index, value] of [[0, Infinity], [2, -.01], [3, 1.1]]) {
    const invalid = vertices.slice(); invalid[index] = value;
    assert.throws(() => encodeEarthModel(invalid, new Uint32Array([0, 1, 2])), /vertex/);
  }
});

test("shipped Eiffel LODs reproduce byte-for-byte, retain the ornamental top, and meet explicit error and memory budgets", async () => {
  const sourceUrl = new URL("../art/earth/models/eiffel-tower/source.glb", import.meta.url);
  const configUrl = new URL("../art/earth/models/eiffel-tower/model.json", import.meta.url);
  const source = await readFile(sourceUrl), settings = JSON.parse(await readFile(configUrl, "utf8"));
  const a = await prepareEarthModelGeometry(source, settings), b = await prepareEarthModelGeometry(source, settings);
  const shipped = JSON.parse(await readFile(new URL("../features/earth/data/eiffel-model.json", import.meta.url), "utf8"));
  assert.deepEqual(a.files, b.files); assert.deepEqual(a.manifest, b.manifest); assert.deepEqual(a.manifest, shipped);
  assert.equal(shipped.source.sha256, digest(source)); assert.equal(shipped.preparation.inputTriangles, 147604);
  const original = readEarthModelGlb(source), protectedPositions = new Set();
  for (let index = 0; index < original.positions.length; index += 3) if (original.positions[index + 2] >= .9)
    protectedPositions.add([...original.positions.subarray(index, index + 3)].join(","));
  for (const [index, lod] of ["overview", "detail"].entries()) {
    const meta = shipped[lod], bytes = await readFile(new URL(`../public${meta.url}`, import.meta.url));
    assert.deepEqual(a.files[index].bytes, bytes); assert.equal(digest(bytes), meta.sha256);
    assert.ok(meta.triangles <= settings.lods[index].targetTriangles); assert.ok(meta.error <= meta.errorLimit);
    assert.ok(meta.vertexCount <= 50_000); assert.ok(meta.indexCount <= 120_000);
    assert.equal(meta.bytes, 16 + meta.vertexCount * 24 + meta.indexCount * 4);
    const { vertices, indices } = unpack(bytes), positions = new Set(); let minZ = Infinity, maxZ = -Infinity;
    for (let vertex = 0; vertex < vertices.length; vertex += 6) {
      positions.add([...vertices.subarray(vertex, vertex + 3)].join(",")); minZ = Math.min(minZ, vertices[vertex + 2]); maxZ = Math.max(maxZ, vertices[vertex + 2]);
    }
    assert.equal(minZ, 0); assert.equal(maxZ, 1); assert.equal(indices.length, meta.triangles * 3);
    for (const position of protectedPositions) assert.ok(positions.has(position), `${lod} lost protected ornamental top geometry`);
  }
  assert.ok(shipped.overview.bytes + shipped.detail.bytes < 1024 * 1024, "both decoded LOD files together stay below 1 MiB");
});

test("bounded file read rejects oversized GLB and --check detects stale output without modifying source or generated files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "earth-model-prepare-"));
  try {
    const sourcePath = join(directory, "source.glb"), configPath = join(directory, "model.json");
    const source = fixture(), settings = { ...config(), source: "source.glb", outputDirectory: "output", runtimeManifest: "manifest.json" };
    await writeFile(sourcePath, source); await writeFile(configPath, JSON.stringify(settings));
    assert.deepEqual(await readEarthModelSource(sourcePath), source);
    await prepareEarthModel(configPath); await prepareEarthModel(configPath, { check: true });
    const outputPath = join(directory, "output", "overview.elm"), saved = await readFile(outputPath), corrupt = Buffer.from(saved);
    corrupt[corrupt.length - 1] ^= 1; await writeFile(outputPath, corrupt);
    await assert.rejects(prepareEarthModel(configPath, { check: true }), /Stale prepared model/);
    assert.deepEqual(await readFile(outputPath), corrupt); assert.deepEqual(await readFile(sourcePath), source);
    await writeFile(configPath, JSON.stringify({ ...settings, runtimeManifest: "output/overview.elm" }));
    await assert.rejects(prepareEarthModel(configPath), /paths overlap/);
    assert.deepEqual(await readFile(outputPath), corrupt, "all outputs validate before any write");
    const huge = await open(join(directory, "oversized.glb"), "w"); await huge.truncate(32 * 1024 * 1024 + 1); await huge.close();
    await assert.rejects(readEarthModelSource(join(directory, "oversized.glb")), /size budget/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
