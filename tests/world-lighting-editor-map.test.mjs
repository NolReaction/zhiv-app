import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldLightingEditorStore } = await vite.ssrLoadModule("/features/world/dev/world-lighting-editor-store.ts");
const { createWorldLightingEditorMap } = await vite.ssrLoadModule("/features/world/dev/world-lighting-editor-map.ts");
function rig() {
  const caster = (id, x) => ({ id, points: [{ x, y: 50 }, { x: x + 20, y: 50 }, { x: x + 20, y: 70 }, { x, y: 70 }], height: 20, baseHeight: 0, opacity: 1, softness: 2 });
  const scene = { schemaVersion: 1, id: "editor-map", width: 200, height: 200, terrain: [], sites: [], paths: [], focus: { x: 0, y: 0, width: 100, height: 100 },
    shadowCasters: [caster("tree", 20), caster("house", 100)] };
  const store = createWorldLightingEditorStore(true, scene); store.setEnabled(true);
  const map = createWorldLightingEditorMap(() => store.applyToScene(scene).shadowCasters, store);
  const point = id => store.getSnapshot().casters.find(c => c.id === id).points[0];
  return { scene, store, map, point };
}

test("a dragged vertex is one undo step and cancelling restores only the unfinished gesture", () => {
  const { map, store, point } = rig();
  assert.equal(map.down({ x: 20, y: 50 }, 1), true);
  map.move({ x: 22, y: 52 }); map.move({ x: 23, y: 53 }); map.end(false);
  assert.deepEqual(point("tree"), { x: 23, y: 53 });
  store.undo(); assert.deepEqual(point("tree"), { x: 20, y: 50 });
  store.redo(); map.down({ x: 23, y: 53 }, 1); map.move({ x: 24, y: 54 }); map.end(true);
  assert.deepEqual(point("tree"), { x: 23, y: 53 });
});

test("changing selection during a drag never moves vertices in the newly selected object", () => {
  const { map, store, point } = rig();
  map.down({ x: 20, y: 50 }, 1); map.move({ x: 22, y: 52 });
  store.select("house"); map.move({ x: 120, y: 70 }); map.end(false);
  assert.deepEqual(point("house"), { x: 100, y: 50 });
  assert.deepEqual(point("tree"), { x: 22, y: 52 });
});

test("the upper outline selects its volume; empty map and disabled mode leave camera gestures available", () => {
  const { map, store, point } = rig();
  assert.equal(map.down({ x: 110, y: 35 }, .5), true); assert.equal(store.getSnapshot().selectedId, "house");
  map.move({ x: 115, y: 40 }); map.end(false); assert.deepEqual(point("house"), { x: 100, y: 50 });
  assert.equal(map.down({ x: 180, y: 180 }, .5), false);
  store.setEnabled(false); assert.equal(map.down({ x: 100, y: 50 }, 1), false);
});

test("Escape rolls back before pointer release, and keyboard nudges preserve undo", () => {
  const { map, store, point } = rig();
  map.down({ x: 20, y: 50 }, 1); map.move({ x: 24, y: 53 });
  assert.equal(map.key({ key: "Escape" }), true); map.move({ x: 25, y: 54 }); map.end(false);
  assert.deepEqual(point("tree"), { x: 20, y: 50 }); assert.equal(store.getSnapshot().canUndo, false);
  store.select("tree", 0); map.key({ key: "ArrowRight", shiftKey: true }); assert.deepEqual(point("tree"), { x: 30, y: 50 });
  map.key({ key: "z", ctrlKey: true }); assert.deepEqual(point("tree"), { x: 20, y: 50 });
});
