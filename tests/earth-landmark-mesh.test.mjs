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

function fixture() {
  let zoom = 2.5, nextId = 0, uploads = 0, draws = 0, failCompile = false;
  const live = { program: new Set(), shader: new Set(), buffer: new Set(), vao: new Set() };
  const uniforms = [], drawRanges = [];
  const allocate = kind => { const value = { id: ++nextId }; live[kind].add(value); return value; };
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6,
    FLOAT: 7, CULL_FACE: 8, DEPTH_TEST: 9, BLEND: 10, ONE: 11, ONE_MINUS_SRC_ALPHA: 12, TRIANGLES: 13,
    createProgram: () => allocate("program"), deleteProgram: value => live.program.delete(value),
    createShader: () => allocate("shader"), deleteShader: value => live.shader.delete(value),
    createBuffer: () => allocate("buffer"), deleteBuffer: value => live.buffer.delete(value),
    createVertexArray: () => allocate("vao"), deleteVertexArray: value => live.vao.delete(value),
    getShaderParameter: () => !failCompile, getProgramParameter: () => true,
    getShaderInfoLog: () => "test shader failure", getUniformLocation: (_, name) => name,
    bufferData(_, buffer) { uploads++; assert.ok(buffer.byteLength < 400_000); },
    uniform2fv(name, value) { uniforms.push([name, [...value]]); },
    uniform1f(name, value) { uniforms.push([name, value]); },
    uniformMatrix4fv() {}, uniform4fv() {}, drawArrays(_, start, count) { draws++; drawRanges.push([start, count]); },
  };
  for (const name of ["bindVertexArray", "bindBuffer", "enableVertexAttribArray", "vertexAttribPointer", "shaderSource",
    "compileShader", "attachShader", "linkProgram", "useProgram", "disable", "enable", "depthMask", "blendFunc"]) gl[name] = () => {};
  const map = { getZoom: () => zoom, triggerRepaint() {} };
  const models = createEarthLandmarkMeshLayer(map);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const input = { shaderData: { variantName: "globe", define: "#define GLOBE", vertexShaderPrelude: "" },
    defaultProjectionData: { mainMatrix: matrix, fallbackMatrix: matrix, tileMercatorCoords: [0, 0, 1, 1],
      clippingPlane: [0, 0, 1, 0], projectionTransition: 1 } };
  return { models, gl, map, live, uniforms, input, drawRanges,
    get draws() { return draws; }, get uploads() { return uploads; },
    zoom(value) { zoom = value; }, fail() { failCompile = true; },
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
