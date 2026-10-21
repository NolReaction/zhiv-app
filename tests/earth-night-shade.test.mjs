import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthNightMesh, createEarthNightShadeLayer, earthNightAlpha, earthTwilightAlpha, earthAtmosphereAlpha, earthAtmosphereStrength, EARTH_NIGHT_MAX_ALPHA, EARTH_TWILIGHT_MAX_ALPHA, EARTH_ATMOSPHERE_MAX_ALPHA } = await vite.ssrLoadModule("/features/earth/night-shade-layer.ts");

test("one bounded nonoverlapping world surface includes both poles and keeps date-line triangles local", () => {
  const mesh = createEarthNightMesh();
  assert.ok(mesh instanceof Float32Array); assert.equal(mesh.length % 21, 0);
  assert.ok(mesh.byteLength < 1_500_000);
  let north = 0, south = 0;
  for (let start = 0; start < mesh.length; start += 21) {
    const centers = [mesh[start + 6], mesh[start + 13], mesh[start + 20]];
    assert.equal(centers[0], centers[1]); assert.equal(centers[1], centers[2]);
    for (const center of [-1.01, -0.001, 0.001, 0.999, 1.001, 2.01]) {
      const wrap = Math.floor(center - centers[0] + 0.5);
      const positions = [mesh[start] + wrap, mesh[start + 7] + wrap, mesh[start + 14] + wrap];
      assert.ok(Math.max(...positions) - Math.min(...positions) <= 1 / 128 + 1e-8);
    }
    for (let index = start; index < start + 21; index += 7) {
      const [x, y, pole, ...normal] = mesh.slice(index, index + 6);
      assert.ok([x, y, pole, ...normal].every(Number.isFinite));
      assert.ok(x >= 0 && x <= 1 && y >= -1e-7 && y <= 1 + 1e-7);
      assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-6);
      if (pole < 0) { north++; assert.equal(normal[2], 1); }
      if (pole > 0) { south++; assert.equal(normal[2], -1); }
    }
  }
  assert.equal(north, 128); assert.equal(south, 128);
});

test("night never exceeds the readable tint and changes continuously across twilight without zoom input", () => {
  assert.equal(EARTH_NIGHT_MAX_ALPHA, 0.36);
  assert.equal(earthNightAlpha(1), 0); assert.equal(earthNightAlpha(-1), 0.36);
  let previous = earthNightAlpha(-1);
  for (let facing = -1; facing <= 1; facing += 0.001) {
    const value = earthNightAlpha(facing);
    assert.ok(value >= 0 && value <= 0.36 && value <= previous + 1e-10);
    assert.ok(Math.abs(value - previous) < 0.002);
    previous = value;
  }
});

test("sunset is a narrow continuous band and the atmospheric rim leaves the centre and detailed map clear", () => {
  assert.equal(earthTwilightAlpha(-1), 0); assert.equal(earthTwilightAlpha(1), 0);
  assert.equal(earthTwilightAlpha(0), EARTH_TWILIGHT_MAX_ALPHA);
  let previous = earthTwilightAlpha(-1);
  for (let facing = -1; facing <= 1; facing += 0.001) {
    const value = earthTwilightAlpha(facing);
    assert.ok(value >= 0 && value <= EARTH_TWILIGHT_MAX_ALPHA);
    assert.ok(Math.abs(value - previous) < 0.001); previous = value;
  }
  assert.equal(earthAtmosphereAlpha(1, 0.6), 0, "no blue wash across central biomes");
  assert.equal(earthAtmosphereAlpha(0, 0.6), EARTH_ATMOSPHERE_MAX_ALPHA);
  assert.equal(earthAtmosphereAlpha(0, 5.5), 0);
  assert.equal(earthAtmosphereAlpha(0, 0.6, 0), 0, "no flat-map halo");
  let strength = 1;
  for (let zoom = 0; zoom <= 8; zoom += 0.01) {
    const value = earthAtmosphereStrength(zoom);
    assert.ok(value >= 0 && value <= strength + 1e-10);
    assert.ok(Math.abs(value - strength) < 0.006); strength = value;
  }
});

function fixture() {
  let next = 0, uploads = 0, draws = 0, compileFailure = false, center = 179.99, zoom = 0.6;
  const live = Object.fromEntries(["program", "shader", "buffer", "vao"].map(name => [name, new Set()]));
  const uniforms = [], source = [], depths = [];
  const allocate = kind => { const value = { id: ++next }; live[kind].add(value); return value; };
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6,
    FLOAT: 7, DEPTH_TEST: 8, CULL_FACE: 9, BLEND: 10, ONE: 11, ONE_MINUS_SRC_ALPHA: 12, TRIANGLES: 13,
    createProgram: () => allocate("program"), deleteProgram: value => live.program.delete(value),
    createShader: () => allocate("shader"), deleteShader: value => live.shader.delete(value),
    createBuffer: () => allocate("buffer"), deleteBuffer: value => live.buffer.delete(value),
    createVertexArray: () => allocate("vao"), deleteVertexArray: value => live.vao.delete(value),
    getShaderParameter: () => !compileFailure, getProgramParameter: () => true, getUniformLocation: (_, name) => name,
    shaderSource(_, value) { source.push(value); }, bufferData(_, value) { uploads++; assert.ok(value.byteLength < 1_500_000); },
    uniform1f(name, value) { uniforms.push([name, value]); }, uniform3fv(name, value) { uniforms.push([name, [...value]]); },
    uniform4fv() {}, uniformMatrix4fv() {}, depthMask(value) { depths.push(value); }, drawArrays() { draws++; },
  };
  for (const name of ["bindVertexArray", "bindBuffer", "enableVertexAttribArray", "vertexAttribPointer", "compileShader", "attachShader", "linkProgram", "useProgram", "disable", "enable", "blendFunc"]) gl[name] = () => {};
  const map = { getCenter: () => ({ lng: center, lat: 0 }), getZoom: () => zoom, triggerRepaint() {} };
  const shade = createEarthNightShadeLayer(map), matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const input = { shaderData: { variantName: "globe", define: "#define GLOBE", vertexShaderPrelude: "" },
    defaultProjectionData: { mainMatrix: matrix, fallbackMatrix: matrix, tileMercatorCoords: [0, 0, 1, 1], clippingPlane: [0, 0, 1, 0], projectionTransition: 1 } };
  return { shade, map, gl, input, live, uniforms, source, depths,
    get draws() { return draws; }, get uploads() { return uploads; },
    center(value) { center = value; }, zoom(value) { zoom = value; }, fail() { compileFailure = true; }, render() { shade.layer.render(gl, input); } };
}

test("GPU shade is a single draw with stable geographic lighting, no depth writes and no hidden/disabled work", () => {
  const f = fixture(); f.shade.layer.onAdd(f.map, f.gl); f.render(); assert.equal(f.draws, 0);
  f.shade.setLighting([-1, 0, 0]); f.render(); assert.equal(f.draws, 1);
  assert.equal(f.uploads, 1); assert.ok(f.depths.every(value => value === false));
  assert.ok(f.source.some(value => value.includes("projectTile(position, vec2(0.0, a_position.z))")), "SDK clips the far hemisphere and special polar vertices");
  for (const transition of [1, 0.75, 0.01, 0]) { f.input.defaultProjectionData.projectionTransition = transition; f.render(); }
  assert.deepEqual(f.uniforms.filter(([name]) => name === "u_sun").map(([,value]) => value), Array.from({ length: 5 }, () => [-1, 0, 0]));
  f.center(180.01); f.render(); assert.equal(f.uploads, 1);
  f.shade.setVisible(false); f.render(); assert.equal(f.draws, 6);
  f.shade.setVisible(true); f.shade.setLighting(null); f.render(); assert.equal(f.draws, 6);
  f.shade.dispose(); f.shade.layer.onRemove(f.map, f.gl);
  for (const values of Object.values(f.live)) assert.equal(values.size, 0);
});

test("day draws only the globe rim, skips detailed/flat views and keeps one static allocation", () => {
  const f = fixture(); f.shade.layer.onAdd(f.map, f.gl);
  f.shade.setLighting([1, 0, 0], { night: false }); f.render();
  assert.equal(f.draws, 1);
  assert.equal(f.uniforms.findLast(([name]) => name === "u_night_enabled")[1], 0);
  assert.equal(f.uniforms.findLast(([name]) => name === "u_atmosphere_strength")[1], 1);
  f.zoom(5.5); f.render(); assert.equal(f.draws, 1);
  f.zoom(0.6); f.input.defaultProjectionData.projectionTransition = 0; f.render(); assert.equal(f.draws, 1);
  f.input.defaultProjectionData.projectionTransition = 1; f.center(-180.01); f.render();
  assert.equal(f.draws, 2); assert.equal(f.uploads, 1);
  const view = f.uniforms.findLast(([name]) => name === "u_view_normal")[1];
  assert.ok(view.every(Number.isFinite)); assert.ok(Math.abs(Math.hypot(...view) - 1) < 1e-10);
  f.shade.setVisible(false); f.render(); assert.equal(f.draws, 2);
  f.shade.dispose(); f.shade.layer.onRemove(f.map, f.gl);
  for (const values of Object.values(f.live)) assert.equal(values.size, 0);
});

test("projection variants, context restoration and shader failures keep every native resource bounded", () => {
  const f = fixture(); f.shade.layer.onAdd(f.map, f.gl); f.shade.setLighting([1, 0, 0]);
  for (const name of ["globe", "mercator", "globe-new"]) { f.input.shaderData.variantName = name; f.render(); assert.ok(f.live.program.size <= 2); assert.equal(f.live.shader.size, 0); }
  f.shade.layer.onRemove(f.map, f.gl);
  for (const values of Object.values(f.live)) assert.equal(values.size, 0);
  f.shade.layer.onAdd(f.map, f.gl); f.fail(); assert.doesNotThrow(() => f.render());
  assert.equal(f.live.program.size, 0); assert.equal(f.live.shader.size, 0);
  f.shade.dispose(); f.shade.dispose();
  for (const values of Object.values(f.live)) assert.equal(values.size, 0);
});
