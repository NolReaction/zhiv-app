import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { canvasWorldViewport, boundsInCanvas } = await vite.ssrLoadModule("/features/world/scene/canvas-viewport.ts");
const { paintFixedWorld } = await vite.ssrLoadModule("/features/world/tiled/renderer.ts");

test("viewport follows pan, zoom and DPR instead of retaining the previous camera crop", () => {
  const ctx = { canvas: { width: 780, height: 1688 }, getTransform: () => ({ a: 4, b: 0, c: 0, d: 4, e: -400, f: -800 }) };
  assert.deepEqual(canvasWorldViewport(ctx), { x: 100, y: 200, width: 195, height: 422 });
  ctx.getTransform = () => ({ a: 2, b: 0, c: 0, d: 2, e: -600, f: -400 });
  assert.deepEqual(canvasWorldViewport(ctx), { x: 300, y: 200, width: 390, height: 844 });
});

test("rotated and mirrored camera envelopes remain conservative; unsupported transforms do not hide art", () => {
  const ctx = { canvas: { width: 100, height: 200 }, getTransform: () => ({ a: 0, b: 2, c: -2, d: 0, e: 100, f: 0 }) };
  assert.deepEqual(canvasWorldViewport(ctx), { x: 0, y: 0, width: 100, height: 50 });
  ctx.getTransform = () => ({ a: -2, b: 0, c: 0, d: 2, e: 100, f: 0 });
  const mirrored = canvasWorldViewport(ctx);
  assert.ok(mirrored.x === 0 && mirrored.y === 0 && mirrored.width === 50 && mirrored.height === 100);
  ctx.getTransform = () => ({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 });
  assert.equal(canvasWorldViewport(ctx), null);
  assert.equal(canvasWorldViewport({}), null);
  assert.ok(boundsInCanvas(null, { x: 900, y: 900, width: 1, height: 1 }));
});

test("affine viewport envelope retains all corners through shear, rotation, reflection and nonsquare DPR", () => {
  for (let index = 0; index < 120; index++) {
    const angle = index * .37, sx = index % 2 ? -1.75 : 2.5, sy = .4 + index / 50, shear = .35;
    const t = { a: Math.cos(angle) * sx, b: Math.sin(angle) * sx,
      c: (shear * Math.cos(angle) - Math.sin(angle)) * sy,
      d: (shear * Math.sin(angle) + Math.cos(angle)) * sy, e: -120.3 + index * 7, f: 480.7 - index * 3 };
    const ctx = { canvas: { width: 1170, height: 2532 }, getTransform: () => t };
    const view = canvasWorldViewport(ctx), determinant = t.a * t.d - t.b * t.c;
    const corners = [[0, 0], [1170, 0], [0, 2532], [1170, 2532]].map(([x, y]) => ({
      x: (t.d * (x - t.e) - t.c * (y - t.f)) / determinant,
      y: (-t.b * (x - t.e) + t.a * (y - t.f)) / determinant,
    }));
    const expected = { x: Math.min(...corners.map(point => point.x)), y: Math.min(...corners.map(point => point.y)) };
    expected.width = Math.max(...corners.map(point => point.x)) - expected.x;
    expected.height = Math.max(...corners.map(point => point.y)) - expected.y;
    for (const axis of ["x", "y", "width", "height"]) assert.ok(Math.abs(view[axis] - expected[axis]) < 1e-8,
      `${axis} preserves the inverse-corner envelope for transform ${index}`);
  }
  const ctx = { canvas: { width: 100, height: 200 }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: Infinity, f: 0 }) };
  assert.equal(canvasWorldViewport(ctx), null, "invalid transforms keep conservative no-culling fallback");
});

test("offscreen artwork is skipped before image preparation, but border shadows and Tiled draw order survive", () => {
  const bounds = x => ({ x, y: 20, width: 40, height: 40 });
  const site = (id, x) => ({ id, bounds: bounds(x), anchor: { x, y: 50 }, initialLevel: 1 });
  const scene = { width: 1000, height: 1000, sites: [site("edge", 105), site("far", 500)],
    terrain: [{ id: "ground", image: "ground", bounds: { x: 0, y: 0, width: 1000, height: 1000 } },
      { id: "decal", image: "decal", bounds: bounds(700) }], lights: [] };
  let offset = 0;
  const draws = [];
  const ctx = { canvas: { width: 100, height: 100 }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: offset, f: 0 }),
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, drawImage(image) { draws.push(image); } };
  const frame = { images: new Map(["ground", "decal", "edge", "far"].map(id => [id, { id }])),
    visuals: { edge: { image: "edge" }, far: { image: "far" } }, actor: null,
    paintGround() { draws.push("ground effects"); },
    options: { levels: {}, night: false, showBuildings: true, buildingShadow: false, selectedSiteId: null, debug: false } };
  paintFixedWorld(ctx, scene, frame);
  assert.deepEqual(draws.map(value => value.id ?? value), ["ground", "ground effects", "edge"]);
  draws.length = 0; offset = -480;
  paintFixedWorld(ctx, scene, frame);
  assert.deepEqual(draws.map(value => value.id ?? value), ["ground", "ground effects", "far"]);
});
