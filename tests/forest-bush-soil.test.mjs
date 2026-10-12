import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { forestBushSoilGeometry, drawForestBushSoil } = await vite.ssrLoadModule("/features/world/activities/garden/forest-bush-soil.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  await vite.close();
});

function context() {
  const stack = [], draws = [], operations = [];
  const ctx = { globalAlpha: .4, globalCompositeOperation: "source-over", fillStyle: "initial", filter: "none", draws, operations,
    save() { stack.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation,
      fillStyle: this.fillStyle, filter: this.filter }); },
    restore() { Object.assign(this, stack.pop()); },
    drawImage(...args) { draws.push({ args, alpha: this.globalAlpha, filter: this.filter }); },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { operations.push("feather"); return { addColorStop() {} }; },
  };
  for (const method of ["scale", "translate", "beginPath", "moveTo", "lineTo", "closePath", "fill", "clip", "fillRect", "ellipse", "stroke"]) {
    ctx[method] = (...args) => { assert.ok(args.every(Number.isFinite)); operations.push(method); };
  }
  return ctx;
}
const points = () => [{ x: 10, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 10, y: 80 }];

test("root bed follows translated foliage; watering remains on its exposed front lip", () => {
  const shape = points(), original = structuredClone(shape);
  const bed = forestBushSoilGeometry(shape), left = forestBushSoilGeometry(shape, { x: -500, y: 700 });
  const right = forestBushSoilGeometry(shape, { x: 900, y: 0 });
  assert.ok(bed.bounds.y < 80 && bed.bounds.y + bed.bounds.height > 80);
  assert.ok(bed.bounds.height < 25);
  for (const target of [left.wateringPoint, right.wateringPoint]) {
    assert.ok(target.y > 80 && target.y < bed.bounds.y + bed.bounds.height);
    assert.ok(Math.abs(target.x - bed.center.x) < bed.radiusX * .5);
  }
  const moved = forestBushSoilGeometry(shape.map(point => ({ x: point.x + 130, y: point.y - 240 })), { x: 1030, y: -240 });
  assert.ok(Math.abs(moved.wateringPoint.x - right.wateringPoint.x - 130) < 1e-9);
  assert.ok(Math.abs(moved.wateringPoint.y - right.wateringPoint.y + 240) < 1e-9);
  assert.deepEqual(shape, original);
  assert.equal(forestBushSoilGeometry(shape), bed);
  for (const invalid of [[], [{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 2 }, { x: 0, y: 5 }], [{ x: NaN, y: 2 }, ...shape]]) {
    assert.equal(forestBushSoilGeometry(invalid), null);
  }
});

test("moist soil dries from crop state with bounded shared textures and no drawing side effects", () => {
  const surfaces = [];
  globalThis.document = { createElement(tag) {
    assert.equal(tag, "canvas"); const ctx = context(); ctx.globalAlpha = 1;
    const canvas = { width: 0, height: 0, getContext() { return ctx; } }; surfaces.push(canvas); return canvas;
  } };
  const shape = points(), state = JSON.stringify(shape), alphas = [];
  for (const moisture of [0, .2, .5, .8, 1]) {
    const ctx = context(); drawForestBushSoil(ctx, shape, moisture);
    assert.equal(ctx.globalAlpha, .4); assert.equal(ctx.fillStyle, "initial"); assert.equal(ctx.filter, "none");
    assert.equal(ctx.draws[0].args[0], surfaces[0]);
    assert.ok(ctx.draws.every(draw => draw.alpha <= .4 && draw.filter === "none"));
    alphas.push(ctx.draws[1]?.alpha ?? 0);
  }
  assert.equal(surfaces.length, 2, "changing moisture and camera reuses dry/wet textures");
  assert.ok(surfaces.every(surface => surface.width <= 256 && surface.height <= 256));
  assert.ok(surfaces.every(surface => surface.getContext().operations.includes("feather")));
  assert.ok(alphas.every((alpha, index) => !index || alpha > alphas[index - 1]));
  assert.equal(JSON.stringify(shape), state);
  for (const moisture of [NaN, -20, Infinity]) {
    const ctx = context(); drawForestBushSoil(ctx, shape, moisture);
    assert.equal(ctx.draws.length, 1); assert.ok(ctx.draws.every(draw => Number.isFinite(draw.alpha)));
  }
});
