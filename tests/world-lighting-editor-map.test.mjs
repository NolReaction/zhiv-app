import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, cacheDir: "node_modules/.vite-editor-map", configFile: false, appType: "custom", logLevel: "silent",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldLightingEditorStore } = await vite.ssrLoadModule("/features/world/dev/world-lighting-editor-store.ts");
const { createWorldLightingEditorMap, requestWorldLightingEditorFocus, takeWorldLightingEditorFocus, requestWorldStudioCreate, takeWorldStudioCreate } = await vite.ssrLoadModule("/features/world/dev/world-lighting-editor-map.ts");
function rig(studio = false, surfaces = false) {
  const caster = (id, x) => ({ id, points: [{ x, y: 50 }, { x: x + 20, y: 50 }, { x: x + 20, y: 70 }, { x, y: 70 }], height: 20, baseHeight: 0, opacity: 1, softness: 2 });
  const scene = { schemaVersion: 1, id: "editor-map", width: 200, height: 200, terrain: [], sites: [], paths: [], focus: { x: 0, y: 0, width: 100, height: 100 },
    shadowCasters: [caster("tree", 20), caster("house", 100)],
    shadowReceivers: surfaces ? [{ id: "clearing", points: [{ x: 20, y: 110 }, { x: 40, y: 110 }, { x: 40, y: 130 }, { x: 20, y: 130 }], height: 0 }] : [],
    lights: studio ? [{ id: "home-lamp", kind: "lantern", position: { x: 120, y: 100 }, height: 20, radius: 15, intensity: 1, color: "#ffd28a", flicker: 0 }] : [] };
  const store = createWorldLightingEditorStore(true, scene); store.setEnabled(true);
  const focuses = [];
  const getLights = () => store.getSnapshot().lights.map(light => light.manualPosition ? light : { ...light, position: { x: 150, y: 100 } })
    .concat({ id: "generated-lamp", kind: "lantern", position: { x: 180, y: 50 }, radius: 12, intensity: 1, color: "#ffffff", flicker: 0 });
  const map = createWorldLightingEditorMap(() => store.applyToScene(scene).shadowCasters, store, studio ? { getLights, getReceivers: () => store.applyToScene(scene).shadowReceivers, onFocus: request => focuses.push(request) } : undefined);
  const point = id => store.getSnapshot().casters.find(c => c.id === id).points[0];
  return { scene, store, map, point, focuses };
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

test("whole-volume translation preserves the shape, snaps its anchor and is one undo action", () => {
  const { store, map } = rig(true), before = structuredClone(store.getSnapshot().casters[0]);
  store.setTool("move"); store.setSnap(5);
  assert.equal(map.down({ x: 30, y: 60 }, 1), true);
  map.move({ x: 37, y: 67 }); map.move({ x: 42, y: 73 }); map.end(false);
  assert.deepEqual(store.getSnapshot().casters[0].points, before.points.map(p => ({ x: p.x + 10, y: p.y + 15 })));
  store.undo(); assert.deepEqual(store.getSnapshot().casters[0], before); assert.equal(store.getSnapshot().canUndo, false);
});

test("edge insertion and vertex dragging undo together; invalid movement keeps the last valid polygon", () => {
  const { map, store } = rig(true), before = structuredClone(store.getSnapshot().casters[0]);
  store.select("tree"); store.setTool("vertex");
  assert.equal(map.down({ x: 30, y: 50 }, 1), true);
  map.move({ x: 30, y: 45 }); map.end(false);
  assert.equal(store.getSnapshot().casters[0].points.length, 5);
  assert.deepEqual(store.getSnapshot().casters[0].points[1], { x: 30, y: 45 });
  store.undo(); assert.deepEqual(store.getSnapshot().casters[0], before);
  map.down({ x: 20, y: 50 }, 1); map.move({ x: 40, y: 70 });
  assert.ok(store.getSnapshot().error); map.end(true); assert.deepEqual(store.getSnapshot().casters[0], before);
});

test("height handles preserve the opposite boundary and cancellation restores the volume", () => {
  const { store, map } = rig(true);
  store.select("tree"); store.setTool("height");
  assert.equal(map.down({ x: 30, y: 40 }, 1), true); map.move({ x: 30, y: 30 }); map.end(false);
  assert.equal(store.getSnapshot().casters[0].height, 30); assert.equal(store.getSnapshot().casters[0].baseHeight, 0);
  assert.equal(map.down({ x: 30, y: 60 }, 1), true); map.move({ x: 30, y: 50 }); map.end(false);
  assert.equal(store.getSnapshot().casters[0].baseHeight, 10); assert.equal(store.getSnapshot().casters[0].height, 20);
  map.down({ x: 30, y: 30 }, 1); map.move({ x: 30, y: -300 }); map.end(true);
  assert.equal(store.getSnapshot().casters[0].baseHeight, 10); assert.equal(store.getSnapshot().casters[0].height, 20);
});

test("placing a source commits only on release; pinch or Escape cancellation creates nothing", () => {
  const { store, map } = rig(true), count = store.getSnapshot().lights.length;
  store.setTool("light"); store.setLightKind("torch"); store.setSnap(5);
  map.down({ x: 156, y: 133 }, 1); map.move({ x: 161, y: 137 }); map.end(true);
  assert.equal(store.getSnapshot().lights.length, count);
  map.down({ x: 156, y: 133 }, 1); map.key({ key: "Escape" }); map.end(false);
  assert.equal(store.getSnapshot().lights.length, count); assert.equal(store.getSnapshot().tool, "select");
  store.setTool("light"); map.down({ x: 156, y: 133 }, 1); map.end(false);
  const source = store.getSnapshot().lights.at(-1);
  assert.equal(source.kind, "torch"); assert.deepEqual(source.position, { x: 155, y: 135 });
  assert.equal(store.getSnapshot().selectedKind, "light"); store.undo(); assert.equal(store.getSnapshot().lights.length, count);
});

test("effective building-lamp coordinates select and move without jumping; generated lights remain read-only", () => {
  const { store, map } = rig(true);
  assert.equal(map.down({ x: 180, y: 50 }, 1), false); assert.equal(store.getSnapshot().selectedId, null);
  store.setTool("move"); map.down({ x: 150, y: 100 }, 1); map.move({ x: 154, y: 103 }); map.end(false);
  assert.deepEqual(store.getSnapshot().lights[0].position, { x: 154, y: 103 }); assert.equal(store.getSnapshot().lights[0].manualPosition, true);
  store.undo(); store.selectLight("home-lamp"); map.key({ key: "ArrowRight" });
  assert.deepEqual(store.getSnapshot().lights[0].position, { x: 151, y: 100 });
});

test("a move-tool click on an attached source does not detach it or create an undo step", () => {
  const { store, map } = rig(true), before = structuredClone(store.getSnapshot().lights[0]);
  store.setTool("move"); map.down({ x: 150, y: 100 }, 11); map.move({ x: 151, y: 100 }); map.end(false);
  assert.deepEqual(store.getSnapshot().lights[0], before); assert.equal(store.getSnapshot().canUndo, false);
});

test("source radius and height gizmos edit the real source, keeping its ground anchor during height drag", () => {
  const { store, map } = rig(true); store.selectLight("home-lamp");
  map.down({ x: 165, y: 100 }, 1); map.move({ x: 175, y: 100 }); map.end(false);
  assert.equal(store.getSnapshot().lights[0].radius, 25);
  store.setTool("height"); map.down({ x: 150, y: 100 }, 1); map.move({ x: 150, y: 90 }); map.end(false);
  assert.equal(store.getSnapshot().lights[0].height, 30); assert.deepEqual(store.getSnapshot().lights[0].position, { x: 150, y: 90 });
  assert.equal(store.getSnapshot().lights[0].position.y + store.getSnapshot().lights[0].height, 120);
});

test("tool shortcuts, Space pan and focus leave geometry unchanged and release on blur", () => {
  const { store, map, focuses } = rig(true); store.select("tree");
  const revision = store.getSnapshot().revision;
  for (const [key, tool] of [["g", "move"], ["p", "vertex"], ["h", "height"], ["l", "light"], ["v", "select"]]) {
    assert.equal(map.key({ key }), true); assert.equal(store.getSnapshot().tool, tool);
  }
  assert.equal(map.key({ key: " ", code: "Space" }), true); assert.equal(map.isPanning(), true);
  assert.equal(map.down({ x: 20, y: 50 }, 1), false); map.keyUp({ key: " ", code: "Space" }); assert.equal(map.isPanning(), false);
  map.key({ key: " ", code: "Space" }); map.blur(); assert.equal(map.isPanning(), false);
  assert.equal(map.key({ key: "f" }), true); assert.equal(focuses.length, 1); assert.ok(focuses[0].bounds.height >= 40);
  assert.equal(store.getSnapshot().revision, revision);
  requestWorldLightingEditorFocus({ point: { x: 50, y: 60 } }); assert.deepEqual(takeWorldLightingEditorFocus(), { point: { x: 50, y: 60 } });
  assert.equal(takeWorldLightingEditorFocus(), null);
  requestWorldLightingEditorFocus(); assert.equal(takeWorldLightingEditorFocus(), "selection");
});

test("original comparison permits selection and focus without mutating the draft", () => {
  const { store, map, focuses } = rig(true); store.selectLight("home-lamp"); store.setPreviewDraft(false);
  const before = structuredClone(store.getSnapshot().lights), revision = store.getSnapshot().revision;
  map.key({ key: "g" }); map.down({ x: 150, y: 100 }, 1); map.move({ x: 155, y: 105 }); map.end(false);
  map.key({ key: "ArrowRight" }); map.key({ key: "z", ctrlKey: true });
  map.key({ key: "l" }); map.down({ x: 180, y: 150 }, 1); map.end(false);
  assert.deepEqual(store.getSnapshot().lights, before); assert.equal(store.getSnapshot().revision, revision);
  store.selectLight("home-lamp"); map.key({ key: "f" }); assert.equal(focuses.length, 1);
});


test("receiving surfaces are selected explicitly, edited in painted coordinates and share one gesture undo", () => {
  const { store, map } = rig(true, true), original = structuredClone(store.getSnapshot().receivers[0]);
  assert.equal(map.down({ x: 30, y: 120 }, 1), false, "unselected hidden surfaces do not steal map navigation");
  store.setShowReceivers(true); store.setTool("move"); store.setSnap(5);
  assert.equal(map.down({ x: 30, y: 120 }, 1), true); assert.equal(store.getSnapshot().selectedKind, "receiver");
  map.move({ x: 37, y: 128 }); map.move({ x: 42, y: 133 }); map.end(false);
  assert.deepEqual(store.getSnapshot().receivers[0].points, original.points.map(p => ({ x: p.x + 10, y: p.y + 15 })));
  store.undo(); assert.deepEqual(store.getSnapshot().receivers[0], original);
  store.setShowReceivers(false); store.selectReceiver("clearing"); store.setTool("vertex");
  map.down({ x: 20, y: 110 }, 1); map.move({ x: 15, y: 105 }); map.end(false);
  assert.deepEqual(store.getSnapshot().receivers[0].points[0], { x: 15, y: 105 }, "selected hidden-class surface remains editable");
  store.undo(); store.setTool("height");
  map.down({ x: 30, y: 120 }, 1); map.move({ x: 30, y: 100 }); map.end(false);
  assert.equal(store.getSnapshot().receivers[0].height, 20); assert.deepEqual(store.getSnapshot().receivers[0].points, original.points);
  store.undo(); assert.deepEqual(store.getSnapshot().receivers[0], original);
});

test("surface edge insertion, focus and cancellation preserve semantic selection", () => {
  const { store, map, focuses } = rig(true, true);
  store.selectReceiver("clearing"); store.setTool("vertex");
  map.down({ x: 30, y: 110 }, 1); map.move({ x: 30, y: 105 }); map.end(false);
  assert.equal(store.getSnapshot().receivers[0].points.length, 5);
  store.undo(); assert.equal(store.getSnapshot().receivers[0].points.length, 4);
  map.down({ x: 20, y: 110 }, 1); map.move({ x: 15, y: 105 }); map.key({ key: "Escape" }); map.end(false);
  assert.deepEqual(store.getSnapshot().receivers[0].points[0], { x: 20, y: 110 });
  assert.equal(store.getSnapshot().selectedKind, "receiver");
  map.key({ key: "f" }); assert.equal(focuses.length, 1); assert.deepEqual(focuses[0].point, { x: 30, y: 120 });
});

test("Delete removes selected elements and only removes a vertex when its contour tool is active", () => {
  const { store, map } = rig(true, true);
  store.select("tree"); map.key({ key: "Delete" }); assert.equal(store.getSnapshot().casters.some(c => c.id === "tree"), false);
  store.undo(); assert.ok(store.getSnapshot().casters.some(c => c.id === "tree"));
  store.selectReceiver("clearing", 0); store.setTool("vertex"); map.key({ key: "Delete" });
  assert.equal(store.getSnapshot().receivers[0].points.length, 3);
  store.undo(); store.setTool("select"); store.selectReceiver("clearing", 0); map.key({ key: "Backspace" });
  assert.equal(store.getSnapshot().receivers.length, 0); store.undo(); assert.equal(store.getSnapshot().receivers.length, 1);
  store.selectLight("home-lamp"); map.key({ key: "Delete" }); assert.equal(store.getSnapshot().lights[0].enabled, false);
  const created = store.addLight({ x: 170, y: 150 }, "glow"); map.key({ key: "Delete" });
  assert.equal(store.getSnapshot().lights.some(l => l.id === created), false);
});

test("text entry and original comparison cannot delete or mutate geometry", () => {
  const { store, map } = rig(true, true); store.selectReceiver("clearing");
  const original = structuredClone(store.getSnapshot().receivers), revision = store.getSnapshot().revision;
  for (const key of ["Delete", "Backspace", "g", "ArrowRight", "z"]) {
    assert.equal(map.key({ key, target: { closest: () => ({}) } }), false);
  }
  store.setPreviewDraft(false); map.key({ key: "Delete" }); map.key({ key: "g" });
  map.down({ x: 30, y: 120 }, 1); map.move({ x: 35, y: 125 }); map.end(false);
  assert.deepEqual(store.getSnapshot().receivers, original); assert.equal(store.getSnapshot().revision, revision);
});

test("selected overlays explain volumes and receiving surfaces without painting every outline", () => {
  const { store, map } = rig(true, true), labels = [];
  const ctx = new Proxy({}, { get: (_, key) => key === "fillText" ? text => labels.push(text) : () => {}, set: () => true });
  assert.equal(store.getSnapshot().overlay, "selected");
  map.draw(ctx, p => p); assert.deepEqual(labels, []);
  store.selectReceiver("clearing"); map.draw(ctx, p => p);
  assert.ok(labels.some(text => text.includes("Поверхность") && text.includes("принимает тени")));
  assert.equal(labels.some(text => text.includes("Объём")), false);
  labels.length = 0; store.select("tree"); map.draw(ctx, p => p);
  assert.ok(labels.some(text => text.startsWith("Объём · tree")));
  assert.equal(labels.some(text => text.includes("house")), false);
});

test("renamed elements display their studio name on the map and undo restores their ID labels", () => {
  const { store, map } = rig(true, true), labels = [];
  const ctx = new Proxy({}, { get: (_, key) => key === "fillText" ? text => labels.push(text) : () => {}, set: () => true });
  for (const [kind, id, name] of [["caster", "tree", "Дерево у дома"], ["receiver", "clearing", "Земля вокруг дома"], ["light", "home-lamp", "Тёплый фонарь"]]) {
    if (kind === "caster") store.select(id);
    else if (kind === "receiver") store.selectReceiver(id);
    else store.selectLight(id);
    assert.equal(store.setElementMetadata(kind, id, { studioName: name }), true);
    labels.length = 0; map.draw(ctx, p => p);
    assert.ok(labels.some(text => text.includes(name)));
    assert.equal(labels.some(text => text.includes(id)), false);
    store.undo(); labels.length = 0; map.draw(ctx, p => p);
    assert.ok(labels.some(text => text.includes(id)));
  }
});

test("creation requests survive delayed map mounting and are consumed once", () => {
  requestWorldStudioCreate("receiver"); assert.equal(takeWorldStudioCreate(), "receiver"); assert.equal(takeWorldStudioCreate(), null);
  requestWorldStudioCreate("caster"); assert.equal(takeWorldStudioCreate(), "caster");
});


test("original comparison never draws or focuses unsaved elements through optional fallbacks or draft-backed getters", () => {
  for (const kind of ["caster", "receiver", "light"]) {
    const { store, map } = rig(true, true);
    const id = kind === "caster" ? store.addCaster({ x: 80, y: 150 }) : kind === "receiver" ? store.addReceiver({ x: 80, y: 150 }) : store.addLight({ x: 80, y: 150 }, "glow");
    assert.ok(map.focus(), "new draft element can be framed while editing");
    const fallbackMap = createWorldLightingEditorMap(() => store.getSnapshot().casters, store, { onFocus() {} });
    store.setPreviewDraft(false);
    assert.equal(map.focus(), null); assert.equal(fallbackMap.focus(), null, "missing effective getters never borrow unsaved snapshot elements");
    const labels = [], ctx = new Proxy({}, { get: (_, key) => key === "fillText" ? text => labels.push(text) : () => {}, set: () => true });
    map.draw(ctx, p => p); fallbackMap.draw(ctx, p => p);
    assert.equal(labels.some(text => text.includes(id)), false, "unsaved element has no original overlay");
    store.setPreviewDraft(true); assert.ok(fallbackMap.focus());
  }
});

test("Ctrl and Cmd clicks toggle mixed selection; dragging a selected member keeps the group and creates one Undo", () => {
  const { store, map } = rig(true, true);
  store.setShowReceivers(true);
  map.down({ x: 30, y: 60 }, 1); map.end(false);
  map.down({ x: 30, y: 120 }, 1, { ctrlKey: true }); map.end(false);
  map.down({ x: 150, y: 100 }, 1, { metaKey: true }); map.end(false);
  assert.deepEqual(store.getSnapshot().selectedElements, [{ kind: "caster", id: "tree" }, { kind: "receiver", id: "clearing" }, { kind: "light", id: "home-lamp" }]);
  const before = structuredClone({ casters: store.getSnapshot().casters, receivers: store.getSnapshot().receivers, lights: store.getSnapshot().lights });
  store.setTool("move"); store.setSnap(5);
  map.down({ x: 30, y: 60 }, 1); map.move({ x: 37, y: 68 }); map.move({ x: 42, y: 73 }); map.end(false);
  assert.equal(store.getSnapshot().selectedElements.length, 3);
  assert.deepEqual(store.getSnapshot().casters[0].points[0], { x: 30, y: 65 });
  assert.deepEqual(store.getSnapshot().receivers[0].points[0], { x: 30, y: 125 });
  assert.deepEqual(store.getSnapshot().lights[0].position, { x: 160, y: 115 }, "an attached source starts from its actual painted position");
  store.undo();
  assert.deepEqual(store.getSnapshot().casters, before.casters); assert.deepEqual(store.getSnapshot().receivers, before.receivers); assert.deepEqual(store.getSnapshot().lights, before.lights);
  assert.equal(store.getSnapshot().canUndo, false);
  map.down({ x: 30, y: 120 }, 1, { ctrlKey: true }); map.end(false);
  assert.equal(store.getSnapshot().selectedElements.length, 2);
  assert.equal(store.getSnapshot().selectedElements.some(element => element.id === "clearing"), false);
});

test("a locked group cannot move, locked items stay selectable, and hidden guides never intercept the map", () => {
  const { store, map } = rig(true, true);
  store.selectElements([{ kind: "caster", id: "tree" }, { kind: "light", id: "home-lamp" }]);
  store.setElementFlags("light", "home-lamp", { locked: true }); store.setTool("move");
  const before = structuredClone(store.getSnapshot().casters);
  map.down({ x: 30, y: 60 }, 1); map.move({ x: 40, y: 70 }); map.end(false);
  assert.deepEqual(store.getSnapshot().casters, before); assert.equal(store.getSnapshot().canUndo, false);
  map.down({ x: 150, y: 100 }, 1); map.end(false); assert.equal(store.getSnapshot().selectedId, "home-lamp");
  store.setElementFlags("caster", "tree", { hidden: true }); store.select("tree");
  assert.equal(map.down({ x: 30, y: 60 }, 1), false);
  const labels = [], ctx = new Proxy({}, { get: (_, key) => key === "fillText" ? text => labels.push(text) : () => {}, set: () => true });
  map.draw(ctx, point => point); assert.equal(labels.some(text => text.includes("tree")), false);
  assert.ok(map.focus(), "a hidden element chosen through the list can still be framed");
  assert.equal(store.applyToScene(rig(true).scene).shadowCasters.some(caster => caster.id === "tree"), true, "hiding a guide never removes runtime lighting geometry");
});

test("focus bounds include every selected volume, surface and effective source position", () => {
  const { store, map } = rig(true, true);
  store.selectElements([{ kind: "caster", id: "tree" }, { kind: "receiver", id: "clearing" }, { kind: "light", id: "home-lamp" }]);
  assert.deepEqual(map.focus(), { point: { x: 92.5, y: 82.5 }, bounds: { x: 20, y: 30, width: 145, height: 105 } });
});

test("exclusion creation fits a selected surface and hole vertex, edge and Delete edits preserve its outer contour", () => {
  const { store, map } = rig(true, true); store.selectReceiver("clearing");
  const outer = structuredClone(store.getSnapshot().receivers[0].points);
  assert.equal(map.createReceiverHole({ x: 190, y: 190 }), true, "viewport centre outside the receiver is relocated inside it");
  assert.equal(store.getSnapshot().selectedHole, 0); assert.equal(store.getSnapshot().tool, "vertex");
  const hole = structuredClone(store.getSnapshot().receivers[0].holes[0]);
  assert.equal(hole.length, 4);
  const edge = { x: (hole[0].x + hole[1].x) / 2, y: hole[0].y };
  assert.equal(map.down(edge, .2), true); map.move({ x: edge.x, y: edge.y - .3 }); map.end(false);
  assert.equal(store.getSnapshot().receivers[0].holes[0].length, 5);
  assert.deepEqual(store.getSnapshot().receivers[0].points, outer);
  store.undo(); assert.deepEqual(store.getSnapshot().receivers[0].holes[0], hole);
  map.down(hole[0], .2); map.move({ x: hole[0].x + .2, y: hole[0].y + .2 }); map.end(false);
  assert.deepEqual(store.getSnapshot().receivers[0].holes[0][0], { x: hole[0].x + .2, y: hole[0].y + .2 });
  store.selectHole(0, null); map.key({ key: "Delete" });
  assert.equal(store.getSnapshot().receivers[0].holes?.length ?? 0, 0); assert.equal(store.getSnapshot().receivers.length, 1);
  store.undo(); assert.equal(store.getSnapshot().receivers[0].holes.length, 1);
});

test("the empty interior of an exclusion lets camera gestures through while its boundary can be edited", () => {
  const { store, map } = rig(true, true); store.selectReceiver("clearing");
  store.addReceiverHole([{ x: 25, y: 115 }, { x: 35, y: 115 }, { x: 35, y: 125 }, { x: 25, y: 125 }]);
  store.setTool("select");
  assert.equal(map.down({ x: 30, y: 120 }, .2), false);
  assert.equal(map.down({ x: 30, y: 115 }, .2), true); map.end(false);
  requestWorldStudioCreate("receiver-hole"); assert.equal(takeWorldStudioCreate(), "receiver-hole");
});
