import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { withExpandedCanvasViewport, checkExpandedCanvasMask } = await vite.ssrLoadModule("/features/world/scene/canvas-viewport-compatibility.ts");
const context = (width = 1088, height = 1088) => ({ canvas: { width, height } });
const normal = { x: 32, y: 32, width: 1024, height: 1024 };
const mask = (ctx, left = 0, top = 0, right = ctx.canvas.width, bottom = ctx.canvas.height) =>
  checkExpandedCanvasMask(ctx, left, top, right, bottom, 32, 2048, 1024 * 1024);

test("pan border cannot turn a visible one-megapixel feathered subject into a hard clip", () => {
  const ctx = context(); let paints = 0;
  assert.equal(withExpandedCanvasViewport(ctx, normal, () => { paints++; mask(ctx); }), false);
  assert.equal(paints, 1, "compatibility inspection neither replays paint nor allocates another surface");
  assert.equal(withExpandedCanvasViewport(ctx, normal, () => mask(ctx, 20, 20, 600, 600)), true);
  assert.equal(withExpandedCanvasViewport(ctx, normal, () => mask(ctx, 0, 0, 20, 20)), true,
    "a subject entirely in the border cannot change existing viewport pixels");
});

test("physical side limit and existing hard-clip decisions survive expansion", () => {
  const wide = context(2112, 128);
  assert.equal(withExpandedCanvasViewport(wide, { x: 32, y: 32, width: 2048, height: 64 }, () => mask(wide)), false);
  const large = context(3000, 3000);
  assert.equal(withExpandedCanvasViewport(large, { x: 32, y: 32, width: 2936, height: 2936 }, () => mask(large)), true,
    "a subject that already requires the bounded vector path keeps that same path");
  assert.equal(withExpandedCanvasViewport(wide, { x: 0, y: 0, width: 2112, height: 128 }, () => mask(wide)), true,
    "an unchanged viewport cannot introduce a different mask choice");
});

test("mask choice stays safe for every shifted crop, including a subject entering from the border", () => {
  const ctx = context(2200, 1200), viewport = { x: 32, y: 32, width: 2136, height: 1136 };
  assert.equal(withExpandedCanvasViewport(ctx, viewport, () => mask(ctx, -100, -100, 5000, 5000)), true,
    "a subject covering every possible crop always takes the same hard-clip path");
  assert.equal(withExpandedCanvasViewport(ctx, viewport, () => mask(ctx, 0, 0, 960, 1200)), false,
    "capture can exceed one megapixel while a later crop fits, so equality at capture alone is insufficient");
  const narrowViewport = { x: 32, y: 32, width: 10, height: 1136 };
  assert.equal(withExpandedCanvasViewport(ctx, narrowViewport, () => mask(ctx, 100, 0, 2200, 1200)), false,
    "a currently invisible subject must not enter later with a different mask");
});

test("compatibility scopes are per context, restore after nesting, and never leak after errors", () => {
  const ctx = context(), other = context();
  assert.equal(withExpandedCanvasViewport(ctx, normal, () => mask(other)), true);
  assert.equal(withExpandedCanvasViewport(ctx, normal, () => {
    assert.equal(withExpandedCanvasViewport(ctx, { x: 0, y: 0, width: 1088, height: 1088 }, () => mask(ctx)), true);
    mask(ctx);
  }), false, "the outer normal viewport is restored after a nested draw");
  assert.throws(() => withExpandedCanvasViewport(ctx, normal, () => { throw new Error("interrupted paint"); }), /interrupted paint/);
  mask(ctx);
  assert.equal(withExpandedCanvasViewport(ctx, normal, () => {}), true, "a later frame starts with a clean decision");
});

test("invalid normal viewports cannot approve presentation of an expanded frame", () => {
  const ctx = context();
  for (const viewport of [{ ...normal, x: -1 }, { ...normal, width: NaN }, { ...normal, height: 0 }, { ...normal, x: 100 }]) {
    let painted = false;
    assert.equal(withExpandedCanvasViewport(ctx, viewport, () => { painted = true; }), false);
    assert.equal(painted, true, "the caller receives the failed compatibility result after its paint callback");
  }
});
