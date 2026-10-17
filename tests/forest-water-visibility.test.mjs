import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { createForestWaterBoundsVisibility: visibility } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-render-mask.ts");
const { createForestWaterDynamics: create } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-dynamics.ts");
const { drawForestWaterRefraction: draw } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-refraction.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
after(() => vite.close());

const oldVisible = (box, t, canvas) => {
  if (!t || t.b || t.c) return true;
  const xs = [box.x * t.a + t.e, (box.x + box.width) * t.a + t.e];
  const ys = [box.y * t.d + t.f, (box.y + box.height) * t.d + t.f];
  return Math.max(...xs) >= 0 && Math.min(...xs) <= canvas.width && Math.max(...ys) >= 0 && Math.min(...ys) <= canvas.height;
};
function context(transform) {
  const ctx = { draws: [], clips: [], reads: 0, globalAlpha: 1, imageSmoothingEnabled: false, canvas: { width: 1254, height: 1254 },
    getTransform() { ctx.reads++; return transform; }, save() {}, restore() {},
    clip(...args) { ctx.clips.push(args); }, drawImage(...args) { ctx.draws.push(args); },
  };
  return ctx;
}

test("one-paint viewport snapshot preserves exact previous culling for translated, mirrored and unsupported rotated views", () => {
  for (const transform of [undefined, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    { a: 2.2, b: 0, c: 0, d: 1.8, e: -900, f: -1100 }, { a: -2, b: 0, c: 0, d: -1.5, e: 1700, f: 1100 },
    { a: 1, b: .1, c: -.1, d: 1, e: -3000, f: -3000 }]) {
    const ctx = context(transform), visible = visibility(ctx);
    for (let x = -500; x < 2000; x += 61) for (let y = -300; y < 1800; y += 79) {
      const box = { x, y, width: 35, height: 46 };
      assert.equal(visible(box), oldVisible(box, transform, ctx.canvas));
    }
    assert.equal(ctx.reads, 1, "all candidate patches share a single browser matrix read");
  }
});

test("the next paint snapshots a moved or resized camera instead of keeping a context-wide visibility cache", () => {
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, ctx = context(matrix), box = { x: 50, y: 50, width: 10, height: 10 };
  const first = visibility(ctx); assert.equal(first(box), true);
  matrix.e = -1000; ctx.canvas.width = 40;
  assert.equal(first(box), true, "the current paint owns a value snapshot, including canvas size");
  assert.equal(visibility(ctx)(box), false, "the next paint always reads the new camera");
  matrix.e = 0; ctx.canvas.width = 100;
  assert.equal(visibility(ctx)(box), true); assert.equal(ctx.reads, 3);
});

test("actual Tiled water refraction keeps the same patch offsets and culling with one matrix read per camera paint", () => {
  const previousPath = globalThis.Path2D;
  globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} rect() {} };
  try {
    const state = create(TILED_WORLD), terrain = TILED_WORLD.terrain[0], image = { naturalWidth: 2508, naturalHeight: 2508 };
    state.elapsed = 5;
    const full = context({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); draw(full, TILED_WORLD, state, image, terrain, {});
    assert.ok(full.draws.length > 100, "measurement uses the actual map, not an empty artificial pond");
    assert.equal(full.reads, 1);
    for (const transform of [{ a: 2.2, b: 0, c: 0, d: 1.8, e: -900, f: -1100 },
      { a: -2, b: 0, c: 0, d: -1.5, e: 1700, f: 1100 }, { a: 1, b: .1, c: -.1, d: 1, e: 0, f: 0 }]) {
      const ctx = context(transform); draw(ctx, TILED_WORLD, state, image, terrain, {});
      const expected = full.draws.filter(([, , , , , x, y, width, height]) => oldVisible({ x, y, width, height }, transform, ctx.canvas));
      assert.deepEqual(ctx.draws, expected, "camera culling changes no source sample or destination patch");
      assert.equal(ctx.reads, 1);
    }
    const moved = context({ a: 1, b: 0, c: 0, d: 1, e: -10000, f: -10000 });
    draw(moved, TILED_WORLD, state, image, terrain, {}); assert.deepEqual(moved.draws, []); assert.equal(moved.reads, 1);
    const still = context({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    draw(still, TILED_WORLD, state, image, terrain, { reducedMotion: true }); assert.equal(still.reads, 0);
  } finally { if (previousPath === undefined) delete globalThis.Path2D; else globalThis.Path2D = previousPath; }
});
