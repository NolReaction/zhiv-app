import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { previewForestBuilder, builderPreviewActive, BUILDER_PREVIEW_SECONDS } = await vite.ssrLoadModule("/features/world/dev/forest-builder-preview.ts");
const natural = Object.freeze({ id: "builder", x: 124, y: 216, size: 40,
  direction: "right", action: "work", frame: 8, phase: .4, targetId: "home" });
const preview = (action, repeat = false, direction = "front") => Object.freeze({ id: 1, action, repeat, direction });

test("builder animation samples never create, move or complete a working resident", () => {
  for (const action of Object.keys(BUILDER_PREVIEW_SECONDS)) {
    const settings = preview(action), duration = BUILDER_PREVIEW_SECONDS[action];
    assert.equal(previewForestBuilder(null, 100, false, settings, 100), null, "pending artwork/construction stays hidden");
    const frame = previewForestBuilder(natural, 100 + duration / 2, false, settings, 100);
    assert.equal(frame.action, action); assert.ok(Math.abs(frame.phase - .5) < 1e-10);
    for (const key of ["x", "y", "size", "id", "targetId"]) assert.equal(frame[key], natural[key]);
    assert.equal(natural.action, "work"); assert.equal(natural.phase, .4);
    assert.equal(previewForestBuilder(natural, 100 + duration + 1e-8, false, settings, 100), natural);
    assert.equal(builderPreviewActive(settings, 100 + duration + 1e-8, 100), false, "finished single shots release the speech gate");
    assert.equal(previewForestBuilder(natural, 101, false, null, 100), natural);
  }
});

test("repeating builder actions keep phases while turning and track natural feet without writing them", () => {
  const settings = preview("walk", true), duration = BUILDER_PREVIEW_SECONDS.walk;
  const first = previewForestBuilder(natural, 100.75, false, settings, 100);
  const loop = previewForestBuilder(natural, 100.75 + duration * 10, false, settings, 100);
  assert.ok(Math.abs(first.phase - loop.phase) < 1e-10);
  for (const direction of ["front", "back", "left", "right"]) {
    const frame = previewForestBuilder(natural, 100.75, false, { ...settings, direction }, 100);
    assert.deepEqual({ ...frame, direction: first.direction }, first);
  }
  const moved = { ...natural, x: 130, y: 220 };
  const frame = previewForestBuilder(moved, 101, false, settings, 100);
  assert.deepEqual([frame.x, frame.y], [130, 220]);
  assert.deepEqual([natural.x, natural.y], [124, 216]);
});

test("reduced motion and invalid timestamps have stable finite builder poses", () => {
  for (const action of Object.keys(BUILDER_PREVIEW_SECONDS)) {
    const settings = preview(action, true, "back");
    const still = previewForestBuilder(natural, 20, true, settings, 20);
    assert.equal(still.frame, 0); assert.equal(still.phase, .5);
    for (const elapsed of [20.1, 2000, Infinity, NaN]) {
      assert.deepEqual(previewForestBuilder(natural, elapsed, true, settings, 20), still);
    }
    const initial = previewForestBuilder(natural, 20, false, settings, 20);
    for (const [elapsed, started] of [[19, 20], [NaN, 20], [Infinity, 20], [20, Infinity]]) {
      assert.deepEqual(previewForestBuilder(natural, elapsed, false, settings, started), initial);
    }
  }
});
