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

test("fractional camera raster phases cannot cross the pixel budget or side cap in either direction", () => {
  const check = (width, height, bounds) => {
    const ctx = context(width + 64, height + 64);
    return withExpandedCanvasViewport(ctx, { x: 32, y: 32, width, height }, () => mask(ctx, ...bounds));
  };
  assert.equal(check(1400, 900, [70, 70, 1350, 870]), false,
    "1280 × 800 fits, but fractional x movement needs 1312 × 800 after allocation rounding");
  assert.equal(check(2200, 100, [70, 20, 2118, 80]), false,
    "a 2048-pixel subject becomes 2080 physical pixels when its floor/ceil phase changes");
  assert.equal(check(1336, 1136, [70, 70, 1127, 1062]), false,
    "a fractional interior crop can shrink 1088 × 992 hard clipping to 1056 × 992 soft masking");
  assert.equal(check(1400, 900, [70, 70, 1318, 838]), true,
    "ordinary bounded subjects remain eligible despite a one-pixel phase change");
});

test("approved masks keep the renderer's choice across cropped corners and fractional DPR phases", () => {
  const fits = (width, height) => width <= 2048 && height <= 2048 && width * height <= 1024 * 1024;
  const requested = (start, end, offset, visible) => Math.ceil(Math.max(0,
    Math.min(visible, Math.ceil(end - offset) + 2) - Math.max(0, Math.floor(start - offset) - 2)) / 32) * 32;
  let seed = 0x071acc5;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  let approved = 0, rejected = 0;
  for (const dpr of [1, 1.25, 1.5, 2, 2.625]) for (let sample = 0; sample < 100; sample++) {
    const width = Math.round((500 + random() * 1100) * dpr), height = Math.round((300 + random() * 900) * dpr);
    const pad = Math.ceil(32 * dpr), ctx = context(width + pad * 2, height + pad * 2);
    const viewport = { x: pad, y: pad, width, height };
    const left = (random() * 600 - 300) * dpr, top = (random() * 600 - 300) * dpr;
    const right = left + (100 + random() * 2200) * dpr, bottom = top + (100 + random() * 1400) * dpr;
    const compatible = withExpandedCanvasViewport(ctx, viewport, () =>
      mask(ctx, Math.floor(left) - 2, Math.floor(top) - 2, Math.ceil(right) + 2, Math.ceil(bottom) + 2));
    if (!compatible) { rejected++; continue; }
    approved++;
    const original = fits(requested(left, right, 0, ctx.canvas.width), requested(top, bottom, 0, ctx.canvas.height));
    // Independently recompute the renderer's floor/ceil envelope after moving
    // its physical camera; include both crop edges and interior raster phases.
    const offsets = [0, .125, .5, pad - .25, pad, pad + .375, pad * 2 - .125, pad * 2];
    for (const x of offsets) for (const y of offsets) {
      const w = requested(left, right, x, width), h = requested(top, bottom, y, height);
      if (w && h) assert.equal(fits(w, h), original,
        `DPR ${dpr}, subject ${[left, top, right, bottom]}, crop ${[x, y]}, allocation ${[w, h]}`);
    }
  }
  assert.ok(approved > 100 && rejected > 20, "the oracle exercises both ordinary reuse and guarded fallbacks");
});
