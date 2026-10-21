import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthLandmarkMesh } = await vite.ssrLoadModule("/features/earth/landmark-mesh.ts");
const { createEarthLandmarkMeshLayer } = await vite.ssrLoadModule("/features/earth/landmark-mesh-layer.ts");
const { EARTH_LANDMARKS } = await vite.ssrLoadModule("/features/earth/landmark-catalog.ts");
const { updateEarthModelPlacement, resetEarthModelPlacements, getEarthModelPlacements } = await vite.ssrLoadModule("/features/earth/model-placement.ts");
const { isEarthEiffelNearBounds } = await vite.ssrLoadModule("/features/earth/landmark-model-view.ts");

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
  const uniforms = [], drawRanges = [], drawKinds = [], projectionRequests = [], shaderSources = [];
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
    shaderSource(_, source) { shaderSources.push(source); },
    bindBuffer(target, buffer) { boundBuffers.set(target, buffer); },
    bufferData(target, buffer) { uploads++; assert.ok(buffer.byteLength < 400_000); if (!failUpload) bufferSizes.set(boundBuffers.get(target), buffer.byteLength); },
    getBufferParameter(target, parameter) { assert.equal(parameter, gl.BUFFER_SIZE); return bufferSizes.get(boundBuffers.get(target)) ?? 0; },
    uniform2fv(name, value) { uniforms.push([name, [...value]]); },
    uniform1f(name, value) { uniforms.push([name, value]); },
    uniformMatrix4fv() {}, uniform4fv() {}, drawArrays(_, start, count) { draws++; drawRanges.push([start, count]); drawKinds.push("procedural"); },
    drawElements(_, count, type, offset) { assert.equal(type, 15); assert.equal(offset, 0); draws++; drawRanges.push([0, count]); drawKinds.push("uploaded"); },
  };
  for (const name of ["bindVertexArray", "enableVertexAttribArray", "vertexAttribPointer",
    "compileShader", "attachShader", "linkProgram", "useProgram", "disable", "enable", "depthMask", "blendFunc"]) gl[name] = () => {};
  const map = { getZoom: () => zoom, getContainer: () => container, triggerRepaint() {} };
  const models = createEarthLandmarkMeshLayer(map, options);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const input = { shaderData: { variantName: "globe", define: "#define GLOBE", vertexShaderPrelude: "" },
    defaultProjectionData: { mainMatrix: matrix, fallbackMatrix: matrix, tileMercatorCoords: [0, 0, 1, 1],
      clippingPlane: [0, 0, 1, 0], projectionTransition: 1 },
    getProjectionData(request) { projectionRequests.push(request); return this.defaultProjectionData; } };
  return { models, gl, map, live, uniforms, input, drawRanges, drawKinds, projectionRequests, container, shaderSources,
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

test("street zoom draws only a ready imported Eiffel at its saved height with precise native tile coordinates", async () => {
  const f = importedFixture(); f.models.layer.onAdd(f.map, f.gl); f.zoom(17);
  f.models.setVisible(true, new Set(["eiffel-tower", "colosseum"])); f.render(); assert.equal(f.draws, 0, "OSM remains the street fallback while the model loads");
  f.response(0); await flushModel(); f.input.shaderData.variantName = "mercator"; f.input.shaderData.define = "";
  f.render(); assert.equal(f.draws, 1); assert.equal(f.drawKinds.at(-1), "uploaded");
  assert.equal(f.uniforms.filter(([name]) => name === "u_height").at(-1)[1], getEarthModelPlacements().find(model => model.id === "eiffel-tower").heightMeters);
  const request = f.projectionRequests.at(-1);
  assert.equal(request.tileID.canonical.z, 14); assert.equal(request.applyGlobeMatrix, true);
  const anchor = f.uniforms.filter(([name]) => name === "u_anchor").at(-1)[1];
  assert.ok(anchor.every(value => value >= 0 && value < 8192), "local tile coordinates retain street precision");
  f.zoom(10); f.render(); assert.equal(f.draws, 1, "the atlas/street gap never draws a giant model");
  f.zoom(15); f.render(); assert.equal(f.draws, 1, "street fade begins at zero opacity");
  f.zoom(15.6); f.render(); assert.equal(f.draws, 2);
  assert.equal(f.uploads, 5, "returning from a hidden zoom recreates released GPU buffers from cached CPU data"); f.models.dispose();
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

test("live placements update geographic tile, scale, clockwise heading and altitude without reuploading geometry", async () => {
  const f = importedFixture();
  try {
    f.models.layer.onAdd(f.map, f.gl); f.zoom(17);
    f.models.setVisible(true, new Set(["eiffel-tower"])); f.response(0); await flushModel(); f.render();
    assert.deepEqual([...f.models.getActiveStreetModelIds()], ["eiffel-tower"]);
    const uploads = f.uploads, original = [...EARTH_LANDMARKS.find(item => item.id === "eiffel-tower").location];
    updateEarthModelPlacement("eiffel-tower", {
      longitude: 2.31, latitude: 48.87, heightMeters: 412, headingDegrees: 90, elevationMeters: 18,
    });
    assert.equal(f.models.getActiveStreetModelIds().size, 1, "valid transform edits retain the successfully drawn resident GPU model");
    f.render();
    const lastUniform = name => f.uniforms.filter(([key]) => key === name).at(-1)[1];
    assert.equal(lastUniform("u_height"), 412); assert.equal(lastUniform("u_elevation"), 18);
    assert.ok(Math.abs(lastUniform("u_heading")[0]) < 1e-10); assert.equal(lastUniform("u_heading")[1], 1);
    const mercator = [(2.31 + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + 48.87 * Math.PI / 360)) / Math.PI) / 2];
    const tile = mercator.map(value => Math.floor(value * 2 ** 14));
    assert.deepEqual(f.projectionRequests.at(-1).tileID.canonical, { z: 14, x: tile[0], y: tile[1] });
    assert.deepEqual(lastUniform("u_anchor"), mercator.map((value, index) => (value * 2 ** 14 - tile[index]) * 8192));
    assert.equal(lastUniform("u_scale"), 412 / (40_030_228.884 * Math.cos(48.87 * Math.PI / 180)) * 2 ** 14 * 8192);
    assert.match(f.shaderSources.find(source => source.includes("u_heading")), /a_position\.x \* u_heading\.x \+ a_position\.y \* u_heading\.y/);
    assert.equal(f.uploads, uploads, "editing uses uniforms and geographic projection only");
    assert.equal(f.requests.length, 1, "the same model asset is retained");
    assert.deepEqual(EARTH_LANDMARKS.find(item => item.id === "eiffel-tower").location, original, "public catalogue anchors are immutable");
    assert.deepEqual([...f.models.getActiveStreetModelIds()], ["eiffel-tower"]);
    f.models.dispose();
    const uniforms = f.uniforms.length;
    resetEarthModelPlacements(); f.render();
    assert.equal(f.uniforms.length, uniforms, "retired renderers no longer observe placement changes");
  } finally { f.models.dispose(); resetEarthModelPlacements(); }
});

test("street replacement eligibility disappears for every fallback and for an unsuccessful indexed draw", async () => {
  const f = importedFixture(); f.models.layer.onAdd(f.map, f.gl); f.zoom(17);
  f.models.setVisible(true, new Set(["eiffel-tower"])); f.response(0); await flushModel();
  assert.equal(f.models.getActiveStreetModelIds().size, 0, "network completion cannot hide native buildings");
  f.render(); assert.equal(f.models.getActiveStreetModelIds().size, 1);
  f.models.setVisible(false, new Set(["eiffel-tower"])); assert.equal(f.models.getActiveStreetModelIds().size, 0);
  f.models.setVisible(true, new Set(["eiffel-tower"])); f.render(); assert.equal(f.models.getActiveStreetModelIds().size, 1);
  f.models.setVisible(true, new Set()); assert.equal(f.models.getActiveStreetModelIds().size, 0, "geographic culling immediately restores the map");
  f.models.setVisible(true, new Set(["eiffel-tower"])); f.render(); f.zoom(15); f.render();
  assert.equal(f.models.getActiveStreetModelIds().size, 0, "zero opacity cannot hide the fallback");
  f.zoom(17); f.render(); f.models.layer.onRemove(f.map, f.gl);
  assert.equal(f.models.getActiveStreetModelIds().size, 0, "context removal restores the native map");
  f.models.layer.onAdd(f.map, f.gl); f.render(); assert.equal(f.models.getActiveStreetModelIds().size, 1);
  f.gl.drawElements = () => { throw new Error("lost GPU draw"); };
  assert.doesNotThrow(() => f.render()); assert.equal(f.models.getActiveStreetModelIds().size, 0);
  assert.equal(f.models.isImportedModelReady("eiffel-tower"), false);
  assert.equal(f.container.dataset.earthEiffelModelStatus, "error");
  const uploads = f.uploads; f.render(); assert.equal(f.uploads, uploads, "failed draws do not cause an allocation loop");
  f.models.dispose(); for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
});

test("geographic loading padding follows the edited model height and elevation", () => {
  const bounds = { west: -.01, east: .01, south: .01, north: .02 };
  const camera = { width: 390, height: 844, pitch: 0, verticalFieldOfView: 36.87 };
  assert.equal(isEarthEiffelNearBounds([0, 0], bounds, camera, 1, 0), false);
  assert.equal(isEarthEiffelNearBounds([0, 0], bounds, camera, 1_000, 0), true, "a tall roof can remain visible with its base outside the viewport");
  assert.equal(isEarthEiffelNearBounds([0, 0], bounds, camera, 1, 1_000), true, "a raised model needs the same camera-ray allowance");
  assert.equal(isEarthEiffelNearBounds([0, 0], bounds, { ...camera, padding: { top: 20 } }, 1_000, 0),
    isEarthEiffelNearBounds([0, 0], bounds, { ...camera, padding: { top: 20, bottom: 0, left: 0, right: 0 } }, 1_000, 0),
    "MapLibre partial padding defaults each unspecified edge to zero");
  for (const height of [0, -1, NaN, Infinity]) assert.equal(isEarthEiffelNearBounds([0, 0], bounds, camera, height, 0), false);
});

test("both dateline endpoints and extreme accepted latitudes retain valid canonical street tiles", async () => {
  const f = importedFixture();
  try {
    f.models.layer.onAdd(f.map, f.gl); f.zoom(17);
    f.models.setVisible(true, new Set(["eiffel-tower"])); f.response(0); await flushModel();
    const projectionData = f.input.getProjectionData;
    f.input.getProjectionData = function(request) {
      const { z, x, y } = request.tileID.canonical;
      assert.ok(x >= 0 && x < 2 ** z && y >= 0 && y < 2 ** z, "native projection rejects out-of-range canonical tiles");
      return projectionData.call(this, request);
    };
    for (const longitude of [-180, 180]) for (const latitude of [-85, 85]) {
      updateEarthModelPlacement("eiffel-tower", { longitude, latitude });
      assert.doesNotThrow(() => f.render());
      const { tileID } = f.projectionRequests.at(-1);
      assert.equal(tileID.canonical.x, 0); assert.equal(tileID.wrap, longitude === 180 ? 1 : 0);
      const local = f.uniforms.filter(([name]) => name === "u_anchor").at(-1)[1];
      assert.ok(local.every(value => value >= 0 && value < 8192));
      assert.deepEqual([...f.models.getActiveStreetModelIds()], ["eiffel-tower"]);
      const camera = { width: 390, height: 844, pitch: 0, verticalFieldOfView: 36.87 };
      assert.equal(isEarthEiffelNearBounds([longitude, latitude], { west: 179, east: -179, south: latitude - .01, north: latitude + .01 }, camera), true);
    }
    assert.equal(f.requests.length, 1); assert.equal(f.uploads, 3);
  } finally { f.models.dispose(); resetEarthModelPlacements(); }
});

const textureFixtureImages = new Map(await Promise.all([1, 256, 512, 1024].map(async size => [size,
  await sharp({ create: { width: size, height: size, channels: 3, background: "#80a0c0" } }).webp({ lossless: true }).toBuffer(),
])));

function texturedFixture(ids = ["christ-redeemer", "colosseum", "giza-pyramids"], dimensions = [1, 1, 1], boundsById = {}) {
  const images = dimensions.map(size => textureFixtureImages.get(size));
  const buffer = new ArrayBuffer(232 + images.reduce((sum, image) => sum + image.byteLength, 0)), header = new DataView(buffer);
  header.setUint32(0, 0x324d4c45, true); header.setUint32(4, 2, true);
  header.setUint32(8, 3, true); header.setUint32(12, 3, true);
  let textureOffset = 232;
  const textures = ["baseColor", "normal", "metallicRoughness"].map((kind, slot) => {
    const offset = 16 + slot * 20;
    const image = images[slot];
    [image.byteLength, dimensions[slot], dimensions[slot], 10497, 33071].forEach((value, index) => header.setUint32(offset + index * 4, value, true));
    new Uint8Array(buffer, textureOffset, image.byteLength).set(image); textureOffset += image.byteLength;
    return { kind, bytes: image.byteLength, width: dimensions[slot], height: dimensions[slot], wrapS: 10497, wrapT: 33071 };
  });
  header.setFloat32(76, .4, true); header.setFloat32(80, .7, true); header.setFloat32(84, 1, true);
  new Float32Array(buffer, 88, 33).set([
    -.2, -.2, 0, 1, 1, 1, 0, 0, 1, 0, 0,
    .2, -.2, 0, 1, 1, 1, 0, 0, 1, 1, 0,
    0, .2, 1, 1, 1, 1, 0, 0, 1, .5, 1,
  ]);
  new Uint32Array(buffer, 220, 3).set([0, 1, 2]);
  const definitions = ids.map((id, index) => {
    const asset = lod => ({ url: `/earth/models/${id}/${lod}.elm`, bytes: buffer.byteLength, sha256: "a".repeat(64),
      vertexCount: 3, indexCount: 3, format: 2, textures });
    return { id, heightMeters: 40 + index, normalizedBounds: boundsById[id],
      assets: { version: 1, overview: asset("overview"), detail: asset("detail") } };
  });
  const requests = [], bitmaps = [], timers = new Set();
  const f = fixture({ definitions, environment: {
    fetch(url, init) { let resolve; const promise = new Promise(yes => { resolve = yes; }); requests.push({ url, init, resolve }); return promise; },
    sha256: null, schedule(callback) { timers.add(callback); return callback; }, cancel(callback) { timers.delete(callback); },
    async decodeTexture(texture) {
      const image = { width: texture.width, height: texture.height, closed: false, close() { this.closed = true; } };
      bitmaps.push(image); return image;
    },
  } });
  const { gl, live } = f;
  live.texture = new Set();
  Object.assign(gl, { ACTIVE_TEXTURE: 100, TEXTURE0: 200, TEXTURE_BINDING_2D: 101, TEXTURE_2D: 102,
    UNPACK_FLIP_Y_WEBGL: 103, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 104, UNPACK_COLORSPACE_CONVERSION_WEBGL: 105,
    UNPACK_ALIGNMENT: 106, NONE: 0, RGBA8: 107, RGBA: 108, UNSIGNED_BYTE: 109, TEXTURE_WRAP_S: 110,
    TEXTURE_WRAP_T: 111, TEXTURE_MIN_FILTER: 112, TEXTURE_MAG_FILTER: 113, LINEAR_MIPMAP_LINEAR: 114,
    LINEAR: 115, CLAMP_TO_EDGE: 33071, NO_ERROR: 0, SRGB8_ALPHA8: 116 });
  let active = gl.TEXTURE0 + 5, failed = false, nextTexture = 0;
  const bindings = new Map([0, 1, 2, 5].map(unit => [gl.TEXTURE0 + unit, { previous: unit }]));
  const pixelStore = new Map([[103, true], [104, true], [105, 999], [106, 4]]);
  const uploadedTextures = [], textureParameters = [], attributes = [], samplers = [];
  gl.getParameter = name => name === gl.ACTIVE_TEXTURE ? active : name === gl.TEXTURE_BINDING_2D ? bindings.get(active) : pixelStore.get(name);
  gl.activeTexture = value => { active = value; };
  gl.bindTexture = (_, value) => { bindings.set(active, value); };
  gl.pixelStorei = (name, value) => { pixelStore.set(name, value); };
  gl.createTexture = () => { const texture = { id: ++nextTexture }; live.texture.add(texture); return texture; };
  gl.deleteTexture = texture => live.texture.delete(texture);
  gl.texImage2D = (...args) => uploadedTextures.push(args);
  gl.texParameteri = (...args) => textureParameters.push(args);
  gl.generateMipmap = () => {};
  gl.getError = () => { if (!failed) return 0; failed = false; return 1285; };
  gl.uniform1i = (name, value) => samplers.push([name, value]);
  gl.vertexAttribPointer = (...args) => attributes.push(args);
  const textureState = () => ({ active, bindings: [...bindings], pixelStore: [...pixelStore] });
  return Object.assign(f, { requests, definitions, bitmaps, uploadedTextures, textureParameters, attributes, samplers, textureState,
    failTexture() { failed = true; }, response(index) { requests[index].resolve(new Response(buffer.slice(0))); } });
}

test("overview draws fit wide source bounds uniformly across reloads while street height still follows the editor", async () => {
  const f = texturedFixture(["eiffel-tower", "colosseum"], [1, 1, 1], {
    "eiffel-tower": { min: [-.2, -.2, 0], max: [.2, .2, 1] },
    colosseum: { min: [-1, -1, 0], max: [1, 1, 1] },
  });
  try {
    f.zoom(1.499); f.models.layer.onAdd(f.map, f.gl);
    f.models.setVisible(true, new Set(["eiffel-tower", "colosseum"]));
    await flushModel(); f.response(0); f.response(1); await flushModel(); f.render();
    const scales = () => f.uniforms.filter(([name]) => name === "u_scale").slice(-2).map(([, value]) => value);
    const [tower, roof] = scales();
    assert.ok(Math.abs(roof * Math.hypot(2, 2) - tower) < 1e-12,
      "the whole broad footprint fits the same frame as the tall tower");
    assert.deepEqual(f.drawKinds.slice(-2), ["uploaded", "uploaded"]);
    f.models.layer.onRemove(f.map, f.gl); f.models.layer.onAdd(f.map, f.gl); f.render();
    assert.deepEqual(scales(), [tower, roof], "style/context restoration retains overview dimensions");
    updateEarthModelPlacement("colosseum", { heightMeters: 123, headingDegrees: 37 });
    f.zoom(17); f.models.setVisible(true, new Set(["eiffel-tower", "colosseum"]));
    await flushModel(); f.response(2); f.response(3); await flushModel(); f.render();
    assert.deepEqual(f.uniforms.filter(([name]) => name === "u_height").slice(-2).map(([, value]) => value),
      getEarthModelPlacements().filter(model => ["eiffel-tower", "colosseum"].includes(model.id)).map(model => model.heightMeters),
      "overview fitting never rescales published or edited real-world metres");
  } finally { f.models.dispose(); resetEarthModelPlacements(); }
});

test("different imported IDs use their own lazy LOD URLs, share two request permits and release hidden GPU textures", async () => {
  const f = texturedFixture(); f.models.layer.onAdd(f.map, f.gl);
  assert.equal(f.requests.length, 0);
  f.models.setVisible(true, new Set(f.definitions.map(model => model.id))); await flushModel();
  assert.equal(f.requests.length, 2, "only two bodies/image phases may run together");
  assert.ok(f.requests.every(request => request.url.includes("/overview.elm?")), "miniatures do not request street detail");
  f.response(0); await flushModel(); assert.equal(f.requests.length, 3, "finishing the image phase releases the next permit");
  f.response(1); f.response(2); await flushModel(); f.render();
  for (const definition of f.definitions) assert.equal(f.models.isImportedModelReady(definition.id, "overview"), true);
  assert.equal(f.uploadedTextures.length, 9); assert.equal(f.live.texture.size, 9);
  assert.equal(f.models.getModelSnapshot().fetchCount, 3);
  assert.equal(JSON.parse(f.container.dataset.earthModelStatuses).colosseum.lod, "overview");
  f.models.setVisible(false, new Set());
  assert.equal(f.live.texture.size, 0, "all hidden textures are deleted immediately");
  assert.equal(f.live.buffer.size, 1, "only the shared procedural atlas remains resident");
  assert.ok(f.bitmaps.every(image => !image.closed), "small inactive bitmaps remain in the bounded CPU cache");
  f.models.dispose(); assert.ok(f.bitmaps.every(image => image.closed));
  for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
});

test("textured street draws preserve UV0 and MapLibre texture/pixel-store state, and publish replacement only after drawing", async () => {
  const f = texturedFixture(["christ-redeemer"]); f.zoom(17); f.models.layer.onAdd(f.map, f.gl);
  f.models.setVisible(true, new Set(["christ-redeemer"])); await flushModel();
  assert.ok(f.requests[0].url.includes("/christ-redeemer/detail.elm?"));
  f.response(0); await flushModel();
  assert.equal(f.models.getActiveStreetModelIds().size, 0, "decoded textures cannot hide OSM");
  const before = f.textureState(); f.render(); assert.deepEqual(f.textureState(), before);
  assert.deepEqual([...f.models.getActiveStreetModelIds()], ["christ-redeemer"]);
  assert.equal(f.uniforms.filter(([name]) => name === "u_height").at(-1)[1], getEarthModelPlacements().find(model => model.id === "christ-redeemer").heightMeters);
  assert.ok(f.attributes.some(value => value[0] === 3 && value[1] === 2 && value[4] === 44 && value[5] === 36), "UV0 occupies the final two ELM2 floats");
  assert.deepEqual(f.samplers.slice(-3), [["u_base_color", 0], ["u_normal", 1], ["u_metallic_roughness", 2]]);
  assert.ok(f.textureParameters.some(value => value[1] === f.gl.TEXTURE_WRAP_S && value[2] === 10497));
  assert.deepEqual(f.uploadedTextures.map(args => args[2]), [f.gl.SRGB8_ALPHA8, f.gl.RGBA8, f.gl.RGBA8], "base colour decodes before linear mip filtering; data textures stay linear");
  const fragment = f.shaderSources.find(source => source.includes("linearToSrgb"));
  assert.match(fragment, /texture\(u_base_color, v_uv\)\.rgb \* v_color/);
  assert.match(fragment, /texture\(u_normal, v_uv\)/); assert.match(fragment, /material\.g \* u_roughness/);
  assert.match(fragment, /material\.b \* u_metallic/);
  f.models.layer.onRemove(f.map, f.gl); assert.equal(f.live.texture.size, 0);
  f.models.dispose(); assert.ok(f.bitmaps.every(image => image.closed));
});

test("a silent texture upload failure frees partial textures, preserves shared state and retains native buildings", async () => {
  const f = texturedFixture(["christ-redeemer"]); f.zoom(17); f.models.layer.onAdd(f.map, f.gl);
  f.models.setVisible(true, new Set(["christ-redeemer"])); await flushModel(); f.response(0); await flushModel();
  const before = f.textureState(); f.failTexture(); f.render();
  assert.deepEqual(f.textureState(), before); assert.equal(f.live.texture.size, 0);
  assert.equal(f.models.getActiveStreetModelIds().size, 0); assert.equal(f.models.isImportedModelReady("christ-redeemer"), false);
  assert.equal(JSON.parse(f.container.dataset.earthModelStatuses)["christ-redeemer"].status, "error");
  const uploads = f.uploadedTextures.length; f.render(); assert.equal(f.uploadedTextures.length, uploads);
  f.models.dispose(); for (const resources of Object.values(f.live)) assert.equal(resources.size, 0);
});

test("street detail candidates remain local when horizon bounds include landmarks across the entire globe", async () => {
  const f = texturedFixture(); f.map.getCenter = () => ({ lng: -43.21049, lat: -22.95192 });
  f.zoom(17); f.models.layer.onAdd(f.map, f.gl); f.models.setVisible(true, new Set(f.definitions.map(model => model.id)));
  await flushModel(); assert.equal(f.requests.length, 1); assert.match(f.requests[0].url, /christ-redeemer\/detail/);
  f.models.dispose(); assert.ok(f.requests[0].init.signal.aborted);
});

test("visiting different textured street models evicts old CPU bitmaps before exceeding the 16 MiB cache budget", async () => {
  const f = texturedFixture(["christ-redeemer", "colosseum", "giza-pyramids", "taj-mahal"], [1024, 512, 256]);
  f.zoom(17); f.models.layer.onAdd(f.map, f.gl);
  for (const [index, definition] of f.definitions.entries()) {
    f.models.setVisible(true, new Set([definition.id])); await flushModel();
    assert.equal(f.requests.length, index + 1); f.response(index); await flushModel(); f.render();
    assert.equal(f.models.isImportedModelReady(definition.id), true);
    assert.ok(f.models.getModelSnapshot().bytes <= 16 * 1024 * 1024);
    assert.equal(f.live.texture.size, 3, "only the currently visible model occupies GPU texture memory");
  }
  assert.ok(f.bitmaps.slice(0, 3).every(image => image.closed), "the oldest set was closed before replacement allocations");
  assert.ok(f.bitmaps.slice(-9).every(image => !image.closed));
  f.models.dispose(); assert.ok(f.bitmaps.every(image => image.closed));
});

test("atlas draw evidence belongs to the current rendered camera, visibility and placement", () => {
  const f = fixture();
  let center = { lng: 2.29444, lat: 48.85826 }, pitch = 0, bearing = 0;
  const padding = { top: 0, right: 0, bottom: 0, left: 0 };
  Object.assign(f.map, { getCenter: () => center, getPitch: () => pitch, getBearing: () => bearing, getPadding: () => padding });
  f.container.clientWidth = 640; f.container.clientHeight = 480;
  f.models.layer.onAdd(f.map, f.gl); f.models.setVisible(true, new Set(["eiffel-tower"]));
  assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), false, "a ready GPU context has not drawn this view");
  f.render(); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), true, "valid procedural artwork is real renderer evidence");
  assert.equal(f.models.isLandmarkDrawn("landmark:eiffel-tower"), false); assert.equal(f.models.isLandmarkDrawn("unknown"), false);
  for (const change of [() => f.zoom(2.6), () => { center = { ...center, lng: center.lng + .01 }; },
    () => { pitch = 20; }, () => { bearing = 30; }, () => { padding.bottom = 100; }, () => { f.container.clientWidth = 700; }]) {
    change(); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), false, "old drawn data cannot certify a new camera");
    f.render(); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), true);
  }
  const placement = getEarthModelPlacements().find(value => value.id === "eiffel-tower");
  try {
    updateEarthModelPlacement(placement.id, { headingDegrees: placement.headingDegrees + 1 });
    assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), false, "a transform edit needs another actual draw");
    f.render(); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), true);
  } finally { resetEarthModelPlacements(placement.id); }
  f.models.setVisible(true, new Set()); f.models.setVisible(true, new Set(["eiffel-tower"]));
  assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), false, "a newly revealed target cannot reuse an earlier hidden frame");
  f.render(); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), true);
  f.models.setVisible(false, new Set()); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), false);
  f.models.dispose(); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), false);
});

test("decoded or resident imported models become atlas evidence only after a successful indexed draw", async () => {
  const f = importedFixture(); f.models.layer.onAdd(f.map, f.gl); f.zoom(16);
  f.models.setVisible(true, new Set(["eiffel-tower"]));
  assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), false);
  f.response(0); await flushModel();
  assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), false, "network/decode completion alone is not an inspected object");
  f.render(); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), true);
  f.models.layer.onRemove(f.map, f.gl); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), false);
  f.models.layer.onAdd(f.map, f.gl); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), false, "retained decoded RAM does not certify a recreated context");
  f.render(); assert.equal(f.models.isLandmarkDrawn("eiffel-tower"), true); f.models.dispose();
});

test("atlas failure evidence follows actual loader or GPU errors and yields to valid drawn fallback artwork", async () => {
  const network = importedFixture(); network.models.layer.onAdd(network.map, network.gl); network.zoom(16);
  network.models.setVisible(true, new Set(["eiffel-tower"]));
  assert.equal(network.models.isLandmarkFailed("eiffel-tower"), false);
  network.requests[0].resolve(new Response("unavailable", { status: 503 })); await flushModel();
  assert.equal(network.models.isLandmarkDrawn("eiffel-tower"), false);
  assert.equal(network.models.isLandmarkFailed("eiffel-tower"), true, "a completed network failure must not remain pending forever");
  assert.equal(network.models.isLandmarkFailed("unknown"), false);
  network.models.setVisible(false, new Set()); assert.equal(network.models.isLandmarkFailed("eiffel-tower"), false); network.models.dispose();

  const gpu = importedFixture(); gpu.models.layer.onAdd(gpu.map, gpu.gl); gpu.zoom(16);
  gpu.models.setVisible(true, new Set(["eiffel-tower"])); gpu.response(0); await flushModel(); gpu.failUpload(); gpu.render();
  assert.equal(gpu.models.isLandmarkDrawn("eiffel-tower"), false);
  assert.equal(gpu.models.isLandmarkFailed("eiffel-tower"), true, "failed buffers are unavailable even when decoded CPU data is ready"); gpu.models.dispose();

  const fallback = importedFixture(); fallback.models.layer.onAdd(fallback.map, fallback.gl);
  fallback.models.setVisible(true, new Set(["eiffel-tower"]));
  fallback.requests[0].resolve(new Response("unavailable", { status: 503 })); await flushModel(); fallback.render();
  assert.equal(fallback.models.getModelSnapshot().detail, "error");
  assert.equal(fallback.models.isLandmarkDrawn("eiffel-tower"), true);
  assert.equal(fallback.models.isLandmarkFailed("eiffel-tower"), false, "a valid procedural draw remains meaningful despite an optional asset error"); fallback.models.dispose();
});

test("only an explicitly selected landmark uses full-quality physical detail below ordinary street zoom", async () => {
  const ids = ["giza-pyramids", "great-wall-badaling"], f = texturedFixture(ids);
  f.zoom(13); f.models.layer.onAdd(f.map, f.gl); f.models.setVisible(true, new Set(ids)); await flushModel();
  assert.equal(f.requests.length, 0, "ordinary atlas/street gap remains dormant");
  f.render(); assert.equal(f.draws, 0);
  for (const [index, id] of ids.entries()) {
    f.models.setLandmarkPreview(id); await flushModel();
    assert.equal(f.requests.length, index + 1); assert.ok(f.requests[index].url.includes(`/${id}/detail.elm`));
    f.response(index); await flushModel(); f.render();
    assert.equal(f.models.isLandmarkDrawn(id), true); assert.equal(f.models.isLandmarkDrawn(ids[1 - index]), false);
    const placement = getEarthModelPlacements().find(value => value.id === id);
    const uniform = name => f.uniforms.filter(([key]) => key === name).at(-1)[1];
    assert.equal(uniform("u_opacity"), 1, "a fitted inspection does not use the fading overview miniature");
    assert.equal(uniform("u_height"), placement.heightMeters, "published real-world metres are never reduced to fit the phone");
    assert.equal(uniform("u_scale"), placement.heightMeters / (40_030_228.884 * Math.cos(placement.latitude * Math.PI / 180)) * 2 ** 14 * 8192);
    assert.equal(f.drawKinds.at(-1), "uploaded"); assert.equal(f.draws, index + 1, "unselected models remain hidden at the lower zoom");
  }
  f.models.setLandmarkPreview(null); f.render(); assert.equal(f.draws, 2);
  assert.equal(f.models.isLandmarkDrawn(ids[1]), false);
  f.models.setLandmarkPreview("unknown"); f.render(); assert.equal(f.draws, 2); assert.equal(f.requests.length, 2);
  f.models.setLandmarkPreview(ids[0]); f.zoom(11.9); f.render(); assert.equal(f.draws, 2, "explicit override has a bounded minimum");
  f.models.setLandmarkPreview(null); f.zoom(17); f.render();
  assert.equal(f.draws, 4, "ordinary street models resume their unchanged rules after closing inspection");
  assert.equal(f.requests.length, 2, "decoded detail data is reused without prefetching other catalogue entries"); f.models.dispose();
});
