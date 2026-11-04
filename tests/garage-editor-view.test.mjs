import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fitGarageEditorView, frameGarageEditorBounds, garageEditorNodeBounds, garageEditorWorldPoint, panGarageEditorView, zoomGarageEditorView } from "../features/world/dev/boat-garage/garage-editor-view.mjs";
import { validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";
const close = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("assembly fit uses the entire available area without a device-size ceiling", () => {
  const view = fitGarageEditorView({ width: 1671, height: 941 }, 1600, 900);
  assert(view.scale > .9);
  assert(view.x >= 24); assert(view.y >= 24);
  assert(view.x + 1671 * view.scale <= 1576 + 1e-8);
  assert(view.y + 941 * view.scale <= 876 + 1e-8);
  const small = fitGarageEditorView({ width: 1671, height: 941 }, 320, 250);
  assert(small.scale > 0 && small.scale < view.scale);
});

test("wheel and explicit zoom preserve the world point under the mouse across repeated changes", () => {
  let view = { x: -234, y: 88, scale: .45 };
  const cursor = { x: 713, y: 433 }, world = garageEditorWorldPoint(view, cursor);
  for (const scale of [.7, 1, 2, 5, .12, .001, 500]) {
    view = zoomGarageEditorView(view, scale, cursor);
    const next = garageEditorWorldPoint(view, cursor);
    close(next.x, world.x); close(next.y, world.y);
    assert(view.scale >= .001 && view.scale <= 8);
  }
  assert.equal(zoomGarageEditorView(view, Number.NaN, cursor), view);
});

test("pan is screen-space only and fit-to-selection centers rotated bounds", () => {
  const original = { x: 25, y: 40, scale: 2 }, moved = panGarageEditorView(original, 80, -50);
  assert.deepEqual(original, { x: 25, y: 40, scale: 2 });
  assert.deepEqual(moved, { x: 105, y: -10, scale: 2 });
  const bounds = { x: -40, y: 260, width: 500, height: 180 };
  const framed = frameGarageEditorBounds(bounds, 900, 700);
  close(framed.x + (bounds.x + bounds.width / 2) * framed.scale, 450);
  close(framed.y + (bounds.y + bounds.height / 2) * framed.scale, 350);
});

test("selection framing reads all world corners through parent transforms without altering scene", async () => {
  const scene = validateGarageScene(JSON.parse(await readFile(new URL("../features/world/dev/boat-garage/garage-scene-default.json", import.meta.url), "utf8")));
  const before = JSON.stringify(scene), node = scene.nodes.find(item => item.id === "stand-left");
  node.rotation = 90;
  const bounds = garageEditorNodeBounds(scene, node.id);
  close(bounds.width, node.height * node.scale); close(bounds.height, node.width * node.scale);
  const afterRotation = JSON.stringify(scene);
  frameGarageEditorBounds(bounds, 1000, 700);
  assert.equal(JSON.stringify(scene), afterRotation);
  assert.notEqual(before, afterRotation);
  assert.equal(garageEditorNodeBounds(scene, "missing"), null);
});
