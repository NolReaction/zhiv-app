import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { initialScene, cloneScene, validateScene, parseScene, serializeScene, createSceneHistory, readStoredScene, writeStoredScene, SCENE_STORAGE_KEY, MAX_SCENE_BYTES } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/editor-scene.ts");
const { forestObjects, initialProps, WORLD_HEIGHT } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/objects.ts");
const { createForestPainter } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/renderer.ts");
const { createForestController } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/controller.ts");

function editedScene() {
  const scene = initialScene();
  const original = forestObjects(scene.seed, { x: 0, y: 0, width: scene.width, height: WORLD_HEIGHT })
    .find(object => object.x > 0 && object.x < scene.width && object.y > 0 && object.y < WORLD_HEIGHT);
  scene.planted.push({ id: "planted:17", kind: "rock", x: 850, y: 780, scale: 1.4, variant: 3, rotation: -35 });
  scene.modified.push({ ...original, x: 600, y: 680, rotation: 70 });
  scene.modified.push({ ...initialProps()[0], x: 300, y: 500, scale: 1.25, rotation: 90 });
  scene.removed.push(initialProps()[1].id);
  return scene;
}

test("versioned JSON round trips edited vegetation and all authored props without renderer dependencies", () => {
  const scene = editedScene();
  const restored = parseScene(serializeScene(scene));
  assert.deepEqual(restored, scene);
  const painter = createForestPainter(() => { throw new Error("queries must not create a canvas"); });
  const list = painter.objects({ ...restored, trees: true, grid: false, removed: new Set(restored.removed), modified: new Map(restored.modified.map(object => [object.id, object])) });
  for (const modified of restored.modified) assert.deepEqual(list.find(object => object.id === modified.id), modified);
  assert.ok(!list.some(object => object.id === restored.removed[0]));
  assert.deepEqual(list.find(object => object.id === "planted:17"), restored.planted[0]);
  painter.dispose();
});

test("validation rejects entire invalid scenes, duplicate IDs, unknown references, kind changes and unsafe keys", () => {
  const source = editedScene();
  const invalid = [
    { ...source, version: 2 }, { ...source, seed: NaN }, { ...source, seed: 2.5 },
    { ...source, width: 2000 }, { ...source, width: Infinity },
    { ...source, planted: [source.planted[0], source.planted[0]] },
    { ...source, planted: [{ ...source.planted[0], id: source.modified[0].id }] },
    { ...source, planted: [{ ...source.planted[0], id: "planted:<script>" }] },
    { ...source, modified: [source.modified[0], source.modified[0]] },
    { ...source, modified: [{ ...source.modified[0], id: "missing:1" }] },
    { ...source, modified: [{ ...source.modified[0], kind: "jetty" }] },
    { ...source, removed: ["missing:1"] }, { ...source, removed: [source.removed[0], source.removed[0]] },
    { ...source, removed: [source.modified[0].id] },
    { ...source, constructor: { prototype: { polluted: true } } },
  ];
  for (const scene of invalid) assert.equal(validateScene(scene), null);
  assert.equal(parseScene('{"version":1,"seed":7391,"width":1600,"planted":[],"removed":[],"modified":[],"__proto__":{"polluted":true}}'), null);
  assert.equal({}.polluted, undefined);
  assert.equal(parseScene("{broken json"), null);
  assert.equal(parseScene(" ".repeat(MAX_SCENE_BYTES + 1)), null);
  assert.deepEqual(source, editedScene(), "invalid validation never mutates caller state");
});

test("all object parameters and resource limits are checked before accepting imported data", () => {
  const source = editedScene(), object = source.planted[0];
  for (const patch of [{ x: -1 }, { x: 1601 }, { y: 1601 }, { y: Infinity }, { scale: .39 }, { scale: 2.41 },
    { variant: -1 }, { variant: 24 }, { variant: 1.5 }, { rotation: -181 }, { rotation: 181 }, { kind: "house" }, { __proto__: { surprise: true } }]) {
    const candidate = { ...object, ...patch };
    if (Object.getPrototypeOf(patch) !== Object.prototype) Object.setPrototypeOf(candidate, Object.getPrototypeOf(patch));
    assert.equal(validateScene({ ...source, planted: [candidate] }), null, JSON.stringify(patch));
  }
  assert.equal(validateScene({ ...source, planted: Array.from({ length: 5001 }, (_, i) => ({ ...object, id: `planted:${i}` })) }), null);
  const valid = validateScene({ ...source, planted: [{ ...object, scale: .4, variant: 0, rotation: -180 }, { ...object, id: "planted:18", scale: 2.4, variant: 23, rotation: 180 }] });
  assert.ok(valid);
});

test("scene history commits a drag as one command, restores regeneration and forks redo independently", () => {
  const original = editedScene(), history = createSceneHistory(original);
  const preview = history.getScene();
  preview.modified[0].x += 10; preview.modified[0].x += 10; preview.modified[0].x += 10;
  assert.deepEqual(history.getScene(), original, "uncommitted drag preview cannot mutate the saved scene");
  assert.equal(history.canUndo, false);
  assert.equal(history.commit(preview), true);
  assert.equal(history.canUndo, true);
  assert.deepEqual(history.undo(), original, "one undo reverses the whole drag");
  assert.equal(history.canUndo, false); assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(), preview);
  const regenerated = { ...initialScene(), seed: original.seed + 137, width: 2400 };
  history.commit(regenerated);
  assert.deepEqual(history.undo(), preview, "regeneration undo restores removed, planted and moved objects");
  const fork = history.getScene(); fork.width = 3200; history.commit(fork);
  assert.equal(history.canRedo, false, "new command after undo drops the abandoned future");
  assert.equal(history.commit(cloneScene(fork)), false, "no-op commands do not consume undo steps");
  const copy = history.getScene(); copy.planted[0].x = 9;
  assert.notEqual(history.getScene().planted[0].x, 9, "history snapshots never leak mutable references");
});

test("bounded history retains recent commands and cannot change an earlier returned snapshot", () => {
  const history = createSceneHistory(initialScene(), 2);
  for (const seed of [1, 2, 3]) history.commit({ ...initialScene(), seed });
  const firstUndo = history.undo(); assert.equal(firstUndo.seed, 2); firstUndo.seed = 99;
  assert.equal(history.undo().seed, 1); assert.equal(history.undo(), null);
  assert.equal(history.redo().seed, 2); assert.equal(history.redo().seed, 3); assert.equal(history.redo(), null);
});

test("storage restoration is isolated, survives reload and handles denial, corruption and quota errors", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const source = editedScene();
  assert.deepEqual(readStoredScene(storage), { scene: initialScene(), available: true, invalid: false });
  assert.equal(writeStoredScene(storage, source), true);
  assert.deepEqual([...values.keys()], [SCENE_STORAGE_KEY]);
  assert.deepEqual(readStoredScene(storage), { scene: source, available: true, invalid: false });
  values.set(SCENE_STORAGE_KEY, "broken");
  assert.deepEqual(readStoredScene(storage), { scene: initialScene(), available: true, invalid: true });
  const denied = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } };
  assert.equal(readStoredScene(denied).available, false);
  assert.equal(writeStoredScene(denied, source), false);
  assert.equal(readStoredScene(null).available, false);
  assert.equal(writeStoredScene(null, source), false);
});

/** Input events and storage are real controller boundaries; drawing is a no-op here. */
function controllerHarness(initialJson = null) {
  const previousGlobals = new Map();
  const install = (key, value) => { previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  const frames = new Map(), handlers = new Map(), captured = new Set();
  let frameId = 0, writes = 0, lastStatus;
  const values = new Map(initialJson === null ? [] : [[SCENE_STORAGE_KEY, initialJson]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes++; values.set(key, value); } };
  const noop = () => {};
  const ctx = new Proxy({}, { get: (target, key) => target[key] ?? (String(key).includes("Gradient") ? () => ({ addColorStop: noop }) : noop) });
  const canvas = { dataset: {}, width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    addEventListener: (type, handler) => handlers.set(type, handler), removeEventListener: type => handlers.delete(type), focus: noop,
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id) };
  install("window", { devicePixelRatio: 1, localStorage: storage });
  install("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
  install("requestAnimationFrame", callback => { const id = ++frameId; frames.set(id, callback); return id; });
  install("cancelAnimationFrame", id => frames.delete(id));
  install("ResizeObserver", class { observe() {} disconnect() {} });
  const controller = createForestController(canvas, status => { lastStatus = status; });
  return {
    controller,
    scene: () => JSON.parse(controller.getSceneJson()),
    get writes() { return writes; },
    get status() { return lastStatus; },
    flush() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
    pointer(type, x, y, pointerId = 1) { handlers.get(type)?.({ type, target: canvas, pointerId, button: 0, clientX: x, clientY: y }); },
    screen(x, y) { return { x: 500 + (x - 800) * .5875, y: 500 + (y - 800) * .5875 }; },
    key(key, modifiers = {}) { handlers.get("keydown")?.({ key, target: canvas, preventDefault: noop, ...modifiers }); },
    dispose() {
      controller.dispose();
      for (const [key, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    },
  };
}

test("controller edits imported planted overrides and allocates safe IDs even after huge numeric imports", () => {
  const scene = initialScene();
  const hugeId = "planted:999999999999999999999999999999999999";
  scene.planted.push({ id: hugeId, kind: "rock", x: 700, y: 700, scale: 1, rotation: 0, variant: 0 });
  scene.modified.push({ ...scene.planted[0], x: 800, rotation: 15 });
  const harness = controllerHarness();
  try {
    assert.equal(harness.controller.importScene(serializeScene(scene)), true);
    assert.equal(harness.controller.selectById(hugeId), true);
    harness.controller.updateSelected({ x: 900 });
    assert.equal(harness.scene().planted[0].x, 900);
    assert.equal(harness.scene().modified.length, 0, "old imported override cannot mask new planted edits");
    harness.controller.duplicateSelected();
    const copies = harness.scene().planted;
    assert.equal(copies.length, 2); assert.notEqual(copies[0].id, copies[1].id);
    assert.match(copies[1].id, /^planted:\d+$/);
    assert.ok(Number.isSafeInteger(Number(copies[1].id.split(":")[1])));
    const stable = harness.controller.getSceneJson();
    assert.equal(harness.controller.importScene('{"version":2}'), false);
    assert.equal(harness.controller.getSceneJson(), stable, "rejected import cannot replace or partially modify the scene");
    assert.equal(harness.controller.importScene("{broken"), false);
    assert.equal(harness.controller.getSceneJson(), stable);
  } finally { harness.dispose(); }
});

test("controller drag commits once, cancellation and pinch roll back previews, and keyboard undo restores it", () => {
  const harness = controllerHarness();
  try {
    const start = harness.screen(780, 350);
    harness.pointer("pointerdown", start.x, start.y);
    harness.pointer("pointermove", start.x + 30, start.y + 20);
    harness.pointer("pointermove", start.x + 60, start.y + 40);
    assert.equal(harness.writes, 0, "drag previews never write localStorage");
    harness.flush(); assert.ok(harness.status.selected.x > 780);
    harness.pointer("pointercancel", start.x + 60, start.y + 40);
    harness.flush(); assert.equal(harness.status.selected.x, 780); assert.equal(harness.status.canUndo, false);
    harness.pointer("pointerdown", start.x, start.y);
    harness.pointer("pointermove", start.x + 30, start.y + 20);
    harness.pointer("pointerdown", start.x + 80, start.y + 50, 2);
    harness.flush(); assert.equal(harness.status.selected.x, 780, "starting a pinch discards the current object preview");
    harness.pointer("pointerup", start.x + 80, start.y + 50, 2);
    harness.pointer("pointerup", start.x + 30, start.y + 20);
    assert.equal(harness.writes, 0); assert.equal(harness.scene().modified.length, 0);
    harness.pointer("pointerdown", start.x, start.y);
    harness.pointer("pointermove", start.x + 20, start.y);
    harness.pointer("pointermove", start.x + 40, start.y);
    harness.pointer("pointerup", start.x + 40, start.y);
    assert.equal(harness.writes, 1, "a whole drag is saved once");
    assert.equal(harness.scene().modified.length, 1);
    assert.ok(Math.abs(harness.scene().modified[0].x - (780 + 40 / .5875)) < 1e-9);
    harness.key("z", { ctrlKey: true }); assert.equal(harness.scene().modified.length, 0);
    harness.key("z", { metaKey: true, shiftKey: true }); assert.equal(harness.scene().modified.length, 1);
    harness.key("ArrowLeft", { shiftKey: true });
    assert.ok(Math.abs(harness.scene().modified[0].x - (780 + 40 / .5875 - 10)) < 1e-9);
    harness.key("Delete"); assert.ok(harness.scene().removed.includes("prop:ruins"));
    harness.controller.undo(); assert.ok(!harness.scene().removed.includes("prop:ruins"));
  } finally { harness.dispose(); }
});

test("corrupt restored data is shown as unavailable until a successful edit saves a valid scene", () => {
  const harness = controllerHarness("corrupt");
  try {
    harness.flush(); assert.equal(harness.status.storage, "unavailable");
    harness.controller.selectById("prop:bridge"); harness.controller.updateSelected({ rotation: 30 });
    harness.flush(); assert.equal(harness.status.storage, "saved"); assert.equal(harness.writes, 1);
    const edited = harness.scene();
    harness.controller.regenerate(); assert.equal(harness.scene().modified.length, 0);
    harness.controller.undo(); assert.deepEqual(harness.scene(), edited);
    harness.controller.resetEdits(); assert.equal(harness.scene().modified.length, 0);
    harness.controller.undo(); assert.deepEqual(harness.scene(), edited);
  } finally { harness.dispose(); }
});
