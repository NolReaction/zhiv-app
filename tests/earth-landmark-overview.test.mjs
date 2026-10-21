import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { earthLandmarkOverviewScale: scale, earthLandmarkVertexBounds: bounds } = await vite.ssrLoadModule("/features/earth/landmark-overview.ts");
const { EARTH_MODEL_REGISTRY } = await vite.ssrLoadModule("/features/earth/landmark-model-registry.ts");
const { EARTH_LANDMARKS } = await vite.ssrLoadModule("/features/earth/landmark-catalog.ts");
const { createEarthLandmarkMesh } = await vite.ssrLoadModule("/features/earth/landmark-mesh.ts");

function normalizedDimensions(box) {
  const multiplier = scale(box);
  return box.max.map((value, axis) => (value - box.min[axis]) * multiplier);
}

test("wide and tall miniatures have the same atlas extent without stretching either axis", () => {
  for (const box of [{ min: [-.2, -.2, 0], max: [.2, .2, 1] },
    { min: [-1.1, -.6, 0], max: [1.1, .6, 1] }, { min: [-.8, -.8, 0], max: [.8, .8, .4] }]) {
    const [width, depth, height] = normalizedDimensions(box);
    assert.ok(Math.abs(Math.max(Math.hypot(width, depth), height) - 1) < 1e-12);
    assert.ok(Math.abs(width / height - (box.max[0] - box.min[0]) / (box.max[2] - box.min[2])) < 1e-12);
    for (let heading = 0; heading <= Math.PI * 2; heading += .1) {
      const rotatedWidth = Math.abs(width * Math.cos(heading)) + Math.abs(depth * Math.sin(heading));
      assert.ok(rotatedWidth <= 1 + 1e-12, "turning a broad roof cannot exceed the atlas frame");
    }
  }
});

test("all published assets and procedural fallbacks fit the same overview frame", () => {
  for (const model of EARTH_MODEL_REGISTRY) {
    const original = structuredClone(model.normalizedBounds);
    const [width, depth, height] = normalizedDimensions(model.normalizedBounds);
    assert.ok(Math.max(Math.hypot(width, depth), height) <= 1 + 1e-12, model.id);
    assert.deepEqual(model.normalizedBounds, original, "manifest, editor and street geometry are untouched");
  }
  const tower = EARTH_MODEL_REGISTRY.find(model => model.id === "eiffel-tower");
  const opera = EARTH_MODEL_REGISTRY.find(model => model.id === "sydney-opera");
  assert.ok(scale(opera.normalizedBounds) < scale(tower.normalizedBounds) / 2,
    "the formerly oversized opera footprint shrinks; the slender tower keeps its height");
  for (const landmark of EARTH_LANDMARKS) {
    const mesh = createEarthLandmarkMesh(landmark.kind);
    const [width, depth, height] = normalizedDimensions(bounds(mesh, 6));
    assert.ok(Math.abs(Math.max(Math.hypot(width, depth), height) - 1) < 1e-12, landmark.id);
  }
});

test("bounds measure positions only for either mesh format and reject unusable dimensions safely", () => {
  for (const stride of [6, 11]) {
    const vertices = new Float32Array(stride * 2).fill(99);
    vertices.set([-2, -3, 0]); vertices.set([2, 3, 1], stride);
    assert.deepEqual(bounds(vertices, stride), { min: [-2, -3, 0], max: [2, 3, 1] });
  }
  for (const box of [{ min: [0, 0, 0], max: [0, 0, 0] }, { min: [2, 0, 0], max: [1, 1, 1] },
    { min: [NaN, 0, 0], max: [1, 1, 1] }, { min: [0, 0, 0], max: [Infinity, 1, 1] }, bounds(new Float32Array(), 6)]) {
    assert.equal(scale(box), 1);
  }
});
