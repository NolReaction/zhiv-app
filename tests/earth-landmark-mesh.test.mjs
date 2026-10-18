import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthLandmarkMesh } = await vite.ssrLoadModule("/features/earth/landmark-mesh.ts");
const { createEarthLandmarkMeshLayer } = await vite.ssrLoadModule("/features/earth/landmark-mesh-layer.ts");
const { EARTH_LANDMARKS } = await vite.ssrLoadModule("/features/earth/landmark-catalog.ts");

test("nine original models have bounded solid geometry grounded at z=0 and no external assets", () => {
  const meshes = EARTH_LANDMARKS.map(item => createEarthLandmarkMesh(item.kind));
  let bytes = 0;
  for (const mesh of meshes) {
    assert.ok(mesh instanceof Float32Array);
    assert.equal(mesh.length % 18, 0, "whole position/color triangles");
    assert.ok(mesh.length > 300);
    bytes += mesh.byteLength;
    const axes = [[], [], []];
    for (let index = 0; index < mesh.length; index += 6) {
      for (let axis = 0; axis < 3; axis++) axes[axis].push(mesh[index + axis]);
      for (const channel of mesh.slice(index + 3, index + 6)) assert.ok(channel >= 0 && channel <= 1);
    }
    for (const axis of axes) {
      assert.ok(axis.every(Number.isFinite));
      assert.ok(Math.max(...axis) - Math.min(...axis) > 0.1, "not a plane or billboard");
      assert.ok(Math.max(...axis) <= 1 && Math.min(...axis) >= -1);
    }
    assert.equal(Math.min(...axes[2]), 0, "the model stands on the geographic ground");
  }
  assert.ok(bytes < 400_000, `fixed model buffer budget: ${bytes}`);
  assert.equal(new Set(meshes.map(mesh => Buffer.from(mesh.buffer).toString("base64"))).size, 9);
});

// Orthographic front-view ray hit. This checks the actual solid triangles, not
// names/comments: a solid pedestal or braces across the arch would fail it.
function frontHit(mesh, x, z) {
  for (let offset = 0; offset < mesh.length; offset += 18) {
    const points = [0, 6, 12].map(vertex => [mesh[offset + vertex], mesh[offset + vertex + 2]]);
    const [a, b, c] = points;
    const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const area = cross(a, b, c);
    if (Math.abs(area) < 1e-10) continue;
    const weights = [cross(a, b, [x, z]), cross(b, c, [x, z]), cross(c, a, [x, z])];
    if (weights.every(value => value >= -1e-10) || weights.every(value => value <= 1e-10)) return true;
  }
  return false;
}

test("Eiffel keeps its slender proportions, three low platforms and an actual open arch in both levels", () => {
  for (const level of ["overview", "detail"]) {
    const mesh = createEarthLandmarkMesh("eiffel-tower", level);
    const x = [], z = [];
    for (let index = 0; index < mesh.length; index += 6) { x.push(mesh[index]); z.push(mesh[index + 2]); }
    const ratio = Math.max(...z) / (Math.max(...x) - Math.min(...x));
    assert.ok(ratio > 2.5 && ratio < 2.8, `330 m high, 125 m base silhouette: ${ratio}`);
    assert.equal(frontHit(mesh, 0, 0.08), false, "ground-level arch is hollow through the whole model");
    assert.equal(frontHit(mesh, 0, 0.15), true, "curved arch crown connects the supports");
    for (const floor of [57, 115, 276]) assert.equal(frontHit(mesh, 0, floor / 330 + 0.005), true);
    assert.equal(frontHit(mesh, 0, 0.96), true, "slender upper antenna remains visible");
    assert.ok(mesh.length / 18 < 2_000, "the detailed tower remains a small static mesh");
  }
});

test("overview geometry is a shared prefix; detail adds railings without moving the foundation", () => {
  const overview = createEarthLandmarkMesh("eiffel-tower", "overview");
  const detail = createEarthLandmarkMesh("eiffel-tower", "detail");
  assert.ok(overview.length < detail.length * 0.75);
  assert.deepEqual(detail.subarray(0, overview.length), overview, "no duplicate LOD upload is needed");
});

function fixture(options = {}) {
  let zoom = 2.5, nextId = 0, uploads = 0, draws = 0, failCompile = false, failUpload = false;
  const live = { program: new Set(), shader: new Set(), buffer: new Set(), vao: new Set() };
  const uniforms = [], drawRanges = [], drawKinds = [], projectionRequests = [];
  const boundBuffers = new Map(), bufferSizes = new Map();
  const container = { dataset: {}, ownerDocument: { defaultView: null } };
  const allocate = kind => { const value = { id: ++nextId }; live[kind].add(value); return value; };
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6,
    FLOAT: 7, CULL_FACE: 8, DEPTH_TEST: 9, BLEND: 10, ONE: 11, ONE_MINUS_SRC_ALPHA: 12, TRIANGLES: 13, ELEMENT_ARRAY_BUFFER: 14, UNSIGNED_INT: 15, BUFFER_SIZE: 16,
    createProgram: () => allocate("program"), deleteProgram: value => live.program.delete(value),
    createShader: () => allocate("shader"), deleteShader: value => live.shader.delete(value),
    createBuffer: () => allocate("buffer"), deleteBuffer: value => live.buffer.delete(value),
    createVertexArray: () => allocate("vao"), deleteVertexArray: value => live.vao.delete(value),
    getShaderParameter: () => !failCompile, getProgramParameter: () => true,
    getShaderInfoLog: () => "test shader failure", getUniformLocation: (_, name) => name,
    bindBuffer(target, buffer) { boundBuffers.set(target, buffer); },
    bufferData(target, buffer) { uploads++; assert.ok(buffer.byteLength < 400_000); if (!failUpload) bufferSizes.set(boundBuffers.get(target), buffer.byteLength); },
    getBufferParameter(target, parameter) { assert.equal(parameter, gl.BUFFER_SIZE); return bufferSizes.get(boundBuffers.get(target)) ?? 0; },
    uniform2fv(name, value) { uniforms.push([name, [...value]]); },
    uniform1f(name, value) { uniforms.push([name, value]); },
    uniformMatrix4fv() {}, uniform4fv() {}, drawArrays(_, start, count) { draws++; drawRanges.push([start, count]); drawKinds.push("procedural"); },
    drawElements(_, count, type, offset) { assert.equal(type, 15); assert.equal(offset, 0); draws++; drawRanges.push([0, count]); drawKinds.push("uploaded"); },
  };
  for (const name of ["bindVertexArray", "enableVertexAttribArray", "vertexAttribPointer", "shaderSource",
    "compileShader", "attachShader", "linkProgram", "useProgram", "disable", "enable", "depthMask", "blendFunc"]) gl[name] = () => {};
  const map = { getZoom: () => zoom, getContainer: () => container, triggerRepaint() {} };
  const models = createEarthLandmarkMeshLayer(map, options);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const input = { shaderData: { variantName: "globe", define: "#define GLOBE", vertexShaderPrelude: "" },
    defaultProjectionData: { mainMatrix: matrix, fallbackMatrix: matrix, tileMercatorCoords: [0, 0, 1, 1],
      clippingPlane: [0, 0, 1, 0], projectionTransition: 1 },
    getProjectionData(request) { projectionRequests.push(request); return this.defaultProjectionData; } };
  return { models, gl, map, live, uniforms, input, drawRanges, drawKinds, projectionRequests, container,
    get draws() { return draws; }, get uploads() { return uploads; },
    zoom(value) { zoom = value; }, fail() { failCompile = true; },
    failUpload(value = true) { failUpload = value; },
    render() { models.layer.render(gl, input); } };
}

test("one fixed GPU buffer serves anchored geometry; hidden, distant and culled models never draw", () => {
  const f = fixture();
  f.models.layer.onAdd(f.map, f.gl);
  f.render(); assert.equal(f.draws, 0);
  f.models.setVisible(true, new Set(["eiffel-tower", "colosseum"]));
  f.render(); assert.equal(f.draws, 2);
  const firstAnchors = f.uniforms.filter(([name]) => name === "u_anchor");
  f.zoom(3.5); f.render();
  assert.deepEqual(f.uniforms.filter(([name]) => name === "u_anchor").slice(-2), firstAnchors,
    "zoom changes drawing scale, never geographic anchors");
  assert.equal(f.uploads, 1, "camera changes never rebuild meshes");
  f.zoom(-0.5); f.render(); assert.equal(f.draws, 4);
  f.zoom(6); f.render(); assert.equal(f.draws, 4);
  f.zoom(2.5); f.models.setVisible(false, new Set(["eiffel-tower"])); f.render(); assert.equal(f.draws, 4);
  f.models.setVisible(true, new Set()); f.render(); assert.equal(f.draws, 4);
  f.models.dispose(); f.models.dispose(); f.models.layer.onRemove(f.map, f.gl);
  for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
  f.models.setVisible(true, new Set(["eiffel-tower"])); f.render(); assert.equal(f.draws, 4);
});

test("Eiffel detail changes only the fixed draw count as the globe grows", () => {
  const f = fixture(); f.models.layer.onAdd(f.map, f.gl);
  f.models.setVisible(true, new Set(["eiffel-tower"]));
  f.zoom(0.5); f.render();
  const [start, overviewCount] = f.drawRanges.at(-1);
  assert.equal(overviewCount, createEarthLandmarkMesh("eiffel-tower", "overview").length / 6);
  f.zoom(1.5); f.render();
  assert.deepEqual(f.drawRanges.at(-1), [start, createEarthLandmarkMesh("eiffel-tower", "detail").length / 6]);
  f.zoom(1.49); f.render();
  assert.deepEqual(f.drawRanges.at(-1), [start, overviewCount]);
  assert.equal(f.uploads, 1);
  f.models.dispose();
});

test("projection shader variants stay bounded and shader failures cannot break or leak the map", () => {
  const f = fixture(); f.models.layer.onAdd(f.map, f.gl);
  f.models.setVisible(true, new Set(["eiffel-tower"]));
  for (const name of ["globe", "mercator", "globe-updated"]) {
    f.input.shaderData.variantName = name; f.render();
    assert.ok(f.live.program.size <= 2);
    assert.equal(f.live.shader.size, 0);
  }
  f.models.layer.onRemove(f.map, f.gl);
  for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
  f.models.layer.onAdd(f.map, f.gl); f.fail();
  assert.doesNotThrow(() => f.render());
  assert.equal(f.live.shader.size, 0); assert.equal(f.live.program.size, 0);
  f.models.dispose();
  for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
});


const flushModel = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function importedFixture() {
  const bytes = new ArrayBuffer(100), view = new DataView(bytes);
  view.setUint32(0, 0x314d4c45, true); view.setUint32(4, 1, true); view.setUint32(8, 3, true); view.setUint32(12, 3, true);
  new Float32Array(bytes, 16, 18).set([-.2, -.2, 0, .4, .4, .4, .2, -.2, 0, .5, .5, .5, 0, .2, 1, .6, .6, .6]);
  new Uint32Array(bytes, 88, 3).set([0, 1, 2]);
  const asset = lod => ({ url: `/earth/models/eiffel-tower/${lod}.elm`, bytes: 100, sha256: "a".repeat(64), vertexCount: 3, indexCount: 3 });
  const requests = [], timers = new Map(); let nextTimer = 0;
  const f = fixture({ assets: { version: 1, overview: asset("overview"), detail: asset("detail") }, environment: {
    fetch(url, init) { let resolve; const promise = new Promise(yes => { resolve = yes; }); requests.push({ url, init, resolve }); return promise; },
    sha256: null, schedule(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, cancel(id) { timers.delete(id); },
  } });
  return Object.assign(f, { requests, timers, response(index) { requests[index].resolve(new Response(bytes.slice(0))); } });
}

test("a prepared Eiffel replaces exactly one procedural draw and async bodies never upload GPU data", async () => {
  const f = importedFixture(); f.models.layer.onAdd(f.map, f.gl);
  assert.equal(f.requests.length, 0); f.models.setVisible(true, new Set(["eiffel-tower"]));
  assert.equal(f.requests.length, 1); f.render(); assert.deepEqual(f.drawKinds, ["procedural"]);
  assert.equal(f.container.dataset.earthEiffelModelStatus, "loading");
  f.response(0); await flushModel(); assert.equal(f.models.isImportedEiffelReady("detail"), false, "decoded RAM alone is not a visible street target");
  assert.equal(f.uploads, 1, "a network completion only retains decoded RAM views");
  f.render(); assert.deepEqual(f.drawKinds, ["procedural", "uploaded"]);
  assert.equal(f.models.isImportedEiffelReady("detail"), true);
  assert.equal(f.drawRanges.at(-1)[1], 3); assert.equal(f.uploads, 3);
  assert.equal(f.container.dataset.earthEiffelModelDraw, "uploaded");
  f.render(); assert.equal(f.uploads, 3, "camera frames reuse the index/vertex buffer");
  f.models.dispose(); for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
  assert.equal(f.models.getModelSnapshot().bytes, 0);
});

test("hidden or retired scenes cannot upload a late body and context restore reuses decoded model data", async () => {
  const f = importedFixture(); f.models.layer.onAdd(f.map, f.gl); f.models.setVisible(true, new Set(["eiffel-tower"]));
  f.models.setVisible(false, new Set()); assert.equal(f.requests[0].init.signal.aborted, true);
  f.response(0); await flushModel(); f.render(); assert.equal(f.uploads, 1);
  assert.equal(f.models.isImportedEiffelReady(), false);
  f.models.setVisible(true, new Set(["eiffel-tower"])); f.response(1); await flushModel(); f.render();
  assert.equal(f.uploads, 3); f.models.layer.onRemove(f.map, f.gl);
  for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
  assert.equal(f.models.isImportedEiffelReady(), false, "a removed context never provides an invisible target");
  assert.equal(f.models.getModelSnapshot().detail, "ready", "decoded CPU data survives GPU context removal");
  f.models.layer.onAdd(f.map, f.gl); f.render(); assert.equal(f.requests.length, 2);
  assert.equal(f.uploads, 6, "one procedural, one imported vertex and one imported index buffer per context");
  assert.equal(f.models.isImportedEiffelReady(), true);
  f.models.dispose(); f.models.layer.onRemove(f.map, f.gl);
  for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
});

test("street zoom draws only a ready imported Eiffel at 330 metres with precise native tile coordinates", async () => {
  const f = importedFixture(); f.models.layer.onAdd(f.map, f.gl); f.zoom(17);
  f.models.setVisible(true, new Set(["eiffel-tower", "colosseum"])); f.render(); assert.equal(f.draws, 0, "OSM remains the street fallback while the model loads");
  f.response(0); await flushModel(); f.input.shaderData.variantName = "mercator"; f.input.shaderData.define = "";
  f.render(); assert.equal(f.draws, 1); assert.equal(f.drawKinds.at(-1), "uploaded");
  assert.equal(f.uniforms.filter(([name]) => name === "u_height").at(-1)[1], 330);
  const request = f.projectionRequests.at(-1);
  assert.equal(request.tileID.canonical.z, 14); assert.equal(request.applyGlobeMatrix, true);
  const anchor = f.uniforms.filter(([name]) => name === "u_anchor").at(-1)[1];
  assert.ok(anchor.every(value => value >= 0 && value < 8192), "local tile coordinates retain street precision");
  f.zoom(10); f.render(); assert.equal(f.draws, 1, "the atlas/street gap never draws a giant model");
  f.zoom(15); f.render(); assert.equal(f.draws, 1, "street fade begins at zero opacity");
  f.zoom(15.6); f.render(); assert.equal(f.draws, 2);
  assert.equal(f.uploads, 3); f.models.dispose();
});

test("silent WebGL allocation failure releases partial imports and leaves no street target or retry loop", async () => {
  const f = importedFixture(); f.models.layer.onAdd(f.map, f.gl); f.zoom(17);
  f.models.setVisible(true, new Set(["eiffel-tower"])); f.response(0); await flushModel();
  f.failUpload(); f.render();
  assert.equal(f.draws, 0); assert.equal(f.models.isImportedEiffelReady(), false);
  assert.equal(f.container.dataset.earthEiffelModelStatus, "error");
  assert.equal(f.live.buffer.size, 1, "the partial imported allocation is released");
  assert.equal(f.live.vao.size, 1);
  const uploads = f.uploads;
  f.render(); assert.equal(f.uploads, uploads, "failed GPU allocations do not retry every frame");
  f.zoom(2.5); f.render(); assert.equal(f.drawKinds.at(-1), "procedural");
  f.models.layer.onRemove(f.map, f.gl); f.failUpload(false);
  f.models.layer.onAdd(f.map, f.gl); f.render();
  assert.equal(f.drawKinds.at(-1), "uploaded", "a new context can reuse and reupload retained CPU data");
  assert.equal(f.requests.length, 1);
  f.models.dispose(); for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
});

test("failed initial procedural buffers do not fetch imported assets", () => {
  const f = importedFixture(); f.failUpload(); f.models.layer.onAdd(f.map, f.gl);
  f.models.setVisible(true, new Set(["eiffel-tower"])); f.render();
  assert.equal(f.requests.length, 0); assert.equal(f.draws, 0);
  assert.equal(f.container.dataset.earthEiffelModelStatus, "error");
  f.models.dispose(); for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
});
