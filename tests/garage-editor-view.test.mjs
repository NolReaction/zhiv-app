import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fitGarageEditorView, frameGarageEditorArtwork, frameGarageEditorBounds, garageEditorNodeBounds, garageEditorWorldPoint, panGarageEditorView, zoomGarageEditorView } from "../features/world/dev/boat-garage/garage-editor-view.mjs";
import { validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";
import { garageWaterSetup } from "../features/world/dev/boat-garage/garage-water-setup.mjs";
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

test("water fits the visible hull and attached motor together even though their group covers the whole canvas", async () => {
  const scene = validateGarageScene(JSON.parse(await readFile(new URL("../features/world/dev/boat-garage/garage-scene-example.json", import.meta.url), "utf8")));
  const before = JSON.stringify(scene), bounds = garageWaterSetup(scene).artworkBounds;
  const hull = garageEditorNodeBounds(scene, "starter-hull"), motor = garageEditorNodeBounds(scene, "starter-motor");
  close(bounds.x, Math.min(hull.x, motor.x));
  close(bounds.y, Math.min(hull.y, motor.y));
  close(bounds.x + bounds.width, Math.max(hull.x + hull.width, motor.x + motor.width));
  close(bounds.y + bounds.height, Math.max(hull.y + hull.height, motor.y + motor.height));
  for (const [width, height] of [[825, 510], [320, 440], [820, 280]]) {
    const fit = frameGarageEditorArtwork(scene.canvas, bounds, width, height);
    assert(fit.scale > fitGarageEditorView(scene.canvas, width, height).scale * 1.15);
    close(fit.x + (bounds.x + bounds.width / 2) * fit.scale, width / 2);
    close(fit.y + (bounds.y + bounds.height / 2) * fit.scale, height / 2);
    assert(fit.x + bounds.x * fit.scale > 0 && fit.y + bounds.y * fit.scale > 0);
  }
  assert.equal(JSON.stringify(scene), before);
  scene.nodes.find(node => node.id === "starter-motor").visible = false;
  assert.deepEqual(garageWaterSetup(scene).artworkBounds, hull);
  scene.nodes.find(node => node.id === "boat").visible = false;
  const empty = garageWaterSetup(scene).artworkBounds;
  assert.equal(empty, null);
  assert.deepEqual(frameGarageEditorArtwork(scene.canvas, empty, 400, 600), fitGarageEditorView(scene.canvas, 400, 600));
});
