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
function controllerHarness(initialJson = null, focusBody = false) {
  const previousGlobals = new Map();
  const install = (key, value) => { previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  const frames = new Map(), handlers = new Map(), editorHandlers = new Map(), windowHandlers = new Map(), captured = new Set();
  let frameId = 0, writes = 0, focuses = 0, lastStatus;
  const values = new Map(initialJson === null ? [] : [[SCENE_STORAGE_KEY, initialJson]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes++; values.set(key, value); } };
  const noop = () => {};
  const ctx = new Proxy({}, { get: (target, key) => target[key] ?? (String(key).includes("Gradient") ? () => ({ addColorStop: noop }) : noop) });
  const editor = { contains: target => target === canvas || target?.insideEditor === true,
    addEventListener: (type, handler) => editorHandlers.set(type, handler), removeEventListener: type => editorHandlers.delete(type), focus: () => { focuses++; } };
  const canvas = { dataset: {}, width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    addEventListener: (type, handler) => handlers.set(type, handler), removeEventListener: type => handlers.delete(type), focus: noop,
    closest: selector => selector === "[data-forest-editor]" ? editor : null,
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id) };
  install("window", { devicePixelRatio: 1, localStorage: storage,
    addEventListener: (type, handler) => windowHandlers.set(type, handler), removeEventListener: type => windowHandlers.delete(type) });
  const body = {};
  install("document", { body, activeElement: focusBody ? body : {}, createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
  install("requestAnimationFrame", callback => { const id = ++frameId; frames.set(id, callback); return id; });
  install("cancelAnimationFrame", id => frames.delete(id));
  install("ResizeObserver", class { observe() {} disconnect() {} });
  const controller = createForestController(canvas, status => { lastStatus = status; });
  return {
    controller,
    scene: () => JSON.parse(controller.getSceneJson()),
    get writes() { return writes; },
    get focuses() { return focuses; },
    get status() { return lastStatus; },
    get cursor() { return canvas.dataset.tool; },
    get pendingFrames() { return frames.size; },
    button: { insideEditor: true, closest: () => null },
    input: { insideEditor: true, closest: selector => selector.includes("input") ? {} : null },
    contenteditable: { insideEditor: true, closest: () => null, isContentEditable: true },
    outside: { insideEditor: false, closest: () => null },
    flush(now) { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(now); },
    pointer(type, x, y, pointerId = 1, button = 0, modifiers = {}) { handlers.get(type)?.({ type, target: canvas, pointerId, button, shiftKey: false, clientX: x, clientY: y, preventDefault: noop, ...modifiers }); },
    screen(x, y, zoom = .5875) { return { x: 500 + (x - 800) * zoom, y: 500 + (y - 800) * zoom }; },
    key(key, modifiers = {}) {
      let prevented = false;
      editorHandlers.get("keydown")?.({ key, target: canvas, preventDefault: () => { prevented = true; }, ...modifiers }); return prevented;
    },
    keyup(key, modifiers = {}) { windowHandlers.get("keyup")?.({ key, target: canvas, preventDefault: noop, ...modifiers }); },
    blur() { windowHandlers.get("blur")?.(); },
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

test("physical tool and brush hotkeys work with Russian keys and toolbar focus", () => {
  const harness = controllerHarness();
  try {
    for (const [code, key, mode] of [["KeyH", "р", "pan"], ["KeyV", "м", "select"], ["KeyB", "и", "plant"], ["KeyE", "у", "erase"]]) {
      assert.equal(harness.key(key, { code, target: harness.button }), true);
      harness.flush(); assert.equal(harness.status.mode, mode); assert.equal(harness.cursor, mode);
    }
    for (const [i, brush] of ["tree", "shrub", "rock", "ruins", "bridge", "jetty"].entries()) {
      harness.key(String(i + 1), { code: `Digit${i + 1}`, target: harness.button }); harness.flush();
      assert.equal(harness.status.brush, brush); assert.equal(harness.status.mode, "plant");
    }
    harness.controller.selectById("prop:bridge");
    harness.key("в", { code: "KeyD", ctrlKey: true, target: harness.button }); assert.equal(harness.scene().planted.length, 1);
    harness.key("в", { code: "KeyD", ctrlKey: true, repeat: true, target: harness.button }); assert.equal(harness.scene().planted.length, 1, "held duplicate hotkey never creates repeated objects");
    harness.key("я", { code: "KeyZ", metaKey: true, target: harness.button }); assert.equal(harness.scene().planted.length, 0);
    harness.key("я", { code: "KeyZ", metaKey: true, shiftKey: true, target: harness.button }); assert.equal(harness.scene().planted.length, 1);
    harness.key("я", { code: "KeyZ", ctrlKey: true }); harness.key("н", { code: "KeyY", ctrlKey: true }); assert.equal(harness.scene().planted.length, 1);
    assert.equal(harness.key("p", { code: "KeyP", ctrlKey: true, target: harness.button }), false, "unrelated browser shortcuts keep their native behavior");
  } finally { harness.dispose(); }
});

test("editor shortcuts leave inputs, editable text and outside focus alone, and Enter on buttons never paints", () => {
  const harness = controllerHarness();
  try {
    harness.controller.selectById("prop:bridge"); harness.controller.updateSelected({ rotation: 10 });
    const saved = harness.controller.getSceneJson();
    for (const target of [harness.input, harness.contenteditable, harness.outside]) {
      for (const event of [{ key: "р", code: "KeyH" }, { key: " ", code: "Space" }, { key: "я", code: "KeyZ", ctrlKey: true }, { key: "Delete" }]) {
        assert.equal(harness.key(event.key, { ...event, target }), false);
      }
    }
    harness.flush(); assert.equal(harness.status.mode, "select"); assert.equal(harness.status.temporaryPan, false);
    assert.equal(harness.controller.getSceneJson(), saved);
    harness.key("3", { code: "Digit3", target: harness.button });
    assert.equal(harness.key("Enter", { target: harness.button }), false);
    assert.equal(harness.scene().planted.length, 0, "keyboard activation of a toolbar button is not a paint command");
    harness.key("Enter"); assert.equal(harness.scene().planted.length, 1, "canvas Enter remains an explicit paint command");
  } finally { harness.dispose(); }
});

test("Space and middle-mouse pan latch through keyup without modifying the selected object or erase/plant tools", () => {
  const harness = controllerHarness();
  try {
    harness.controller.selectById("prop:ruins"); harness.controller.setMode("erase");
    const start = harness.screen(780, 350), saved = harness.controller.getSceneJson();
    harness.key(" ", { code: "Space", target: harness.button }); harness.flush();
    assert.equal(harness.status.mode, "erase"); assert.equal(harness.status.temporaryPan, true); assert.equal(harness.cursor, "pan");
    harness.pointer("pointerdown", start.x, start.y);
    harness.keyup(" ", { code: "Space" }); harness.pointer("pointermove", start.x + 40, start.y + 30); harness.flush();
    assert.equal(harness.status.temporaryPan, true, "releasing Space does not convert an ongoing pan to erase or object drag");
    harness.pointer("pointerup", start.x + 40, start.y + 30); harness.flush();
    assert.equal(harness.status.mode, "erase"); assert.equal(harness.status.temporaryPan, false); assert.equal(harness.cursor, "erase");
    assert.equal(harness.controller.getSceneJson(), saved); assert.equal(harness.writes, 0);
    harness.controller.setMode("plant"); harness.pointer("pointerdown", 600, 500, 2, 1);
    harness.pointer("pointermove", 650, 510, 2, 1); harness.flush(); assert.equal(harness.status.temporaryPan, true);
    harness.pointer("pointerup", 650, 510, 2, 1); harness.flush();
    assert.equal(harness.status.mode, "plant"); assert.equal(harness.status.temporaryPan, false);
    assert.equal(harness.controller.getSceneJson(), saved); assert.equal(harness.writes, 0);
    harness.controller.setMode("select"); harness.controller.fit();
    harness.pointer("pointerdown", start.x, start.y); harness.pointer("pointermove", start.x + 30, start.y + 10);
    harness.key(" ", { code: "Space" }); harness.flush(); assert.equal(harness.status.selected.x, 780, "Space during a drag rolls back its preview before panning");
    harness.blur(); harness.flush(); assert.equal(harness.status.temporaryPan, false); assert.equal(harness.cursor, "select");
    harness.pointer("pointerup", start.x + 30, start.y + 10); assert.equal(harness.controller.getSceneJson(), saved); assert.equal(harness.writes, 0);
  } finally { harness.dispose(); }
});

test("edge pan continues with a stationary pointer, preserves grab offset and zoom scale, and remains one undo command", () => {
  const harness = controllerHarness();
  try {
    const fixture = initialScene();
    fixture.removed = forestObjects(fixture.seed, { x: 0, y: 0, width: fixture.width, height: WORLD_HEIGHT }).map(object => object.id);
    fixture.modified = [{ ...initialProps().find(object => object.kind === "ruins"), x: 750, y: 800 }];
    harness.controller.importScene(serializeScene(fixture)); harness.controller.selectById("prop:ruins");
    const before = harness.scene(), writes = harness.writes;
    harness.controller.zoom(2); harness.flush(900);
    const zoom = harness.status.zoom, start = harness.screen(750, 750, zoom);
    harness.pointer("pointerdown", start.x, start.y); harness.pointer("pointermove", start.x + 2, start.y);
    harness.flush(950); assert.equal(harness.status.selected.x, 750, "small motion cannot jump the anchor to the pointer");
    harness.pointer("pointermove", 950, 460); harness.flush(1000);
    const first = { ...harness.status.selected }; assert.equal(harness.pendingFrames, 1, "autopan schedules itself while the pointer is stationary");
    harness.flush(1016); const second = { ...harness.status.selected };
    const expectedAdvance = (480 * (950 - 928) / 72) * .016 / zoom;
    assert.ok(Math.abs(second.x - first.x - expectedAdvance) < 1e-8, "camera edge speed is measured in screen pixels and adjusted for zoom");
    assert.ok(Math.abs(second.y - (800 + (460 - start.y) / zoom)) < 1e-8, "the initial off-center grab offset is preserved");
    assert.equal(harness.writes, writes, "autopan never saves a partial drag");
    harness.flush(2016);
    assert.ok(harness.status.selected.x - second.x < 10, "long frame gaps are capped instead of causing a large jump");
    harness.pointer("pointerup", 950, 460); harness.flush(2032);
    assert.equal(harness.writes, writes + 1); assert.equal(harness.pendingFrames, 0);
    harness.controller.undo(); assert.deepEqual(harness.scene(), before, "one undo restores the whole drag including autopan");
    harness.controller.fit(); harness.controller.zoom(2); harness.flush(2100);
    harness.pointer("pointerdown", start.x, start.y); harness.pointer("pointermove", 700, 460); harness.flush(2116);
    const beforeZoom = { ...harness.status.selected };
    harness.controller.zoom(1.3, { x: 700, y: 460 }); harness.flush(2132);
    assert.ok(Math.abs(harness.status.selected.x - beforeZoom.x) < 1e-8);
    assert.ok(Math.abs(harness.status.selected.y - beforeZoom.y) < 1e-8, "zoom at the grabbed point does not change the object's coordinates");
    harness.key("Escape"); harness.flush(2148); assert.deepEqual(harness.scene(), before); assert.equal(harness.pendingFrames, 0);
  } finally { harness.dispose(); }
});

test("window blur rolls back an object drag and ignores late pointerup instead of committing it", () => {
  const harness = controllerHarness();
  try {
    const start = harness.screen(780, 350), before = harness.controller.getSceneJson();
    harness.pointer("pointerdown", start.x, start.y); harness.pointer("pointermove", start.x + 50, start.y + 30);
    harness.flush(); assert.ok(harness.status.selected.x > 780);
    harness.blur(); harness.flush(); assert.equal(harness.status.selected.x, 780);
    harness.pointer("pointerup", start.x + 50, start.y + 30); harness.flush();
    assert.equal(harness.controller.getSceneJson(), before); assert.equal(harness.writes, 0); assert.equal(harness.pendingFrames, 0);
    harness.pointer("pointerdown", start.x, start.y); harness.pointer("pointermove", start.x + 20, start.y); harness.pointer("pointerup", start.x + 20, start.y);
    assert.equal(harness.writes, 1, "the next gesture works after blur cleanup");
  } finally { harness.dispose(); }
});

test("Shift drag locks its initial dominant axis and releasing Shift restores free movement", () => {
  const harness = controllerHarness();
  try {
    const start = harness.screen(780, 350);
    harness.pointer("pointerdown", start.x, start.y, 1, 0, { shiftKey: true });
    harness.pointer("pointermove", start.x + 40, start.y + 10, 1, 0, { shiftKey: true }); harness.flush();
    assert.equal(harness.status.selected.id, "prop:ruins"); assert.equal(harness.status.selected.y, 420);
    harness.pointer("pointermove", start.x + 5, start.y + 60, 1, 0, { shiftKey: true }); harness.flush();
    assert.equal(harness.status.selected.y, 420, "the chosen axis does not change when the pointer crosses a diagonal");
    harness.keyup("Shift", { code: "ShiftLeft" }); harness.flush();
    assert.ok(Math.abs(harness.status.selected.y - (420 + 60 / .5875)) < 1e-8);
    harness.pointer("pointerup", start.x + 5, start.y + 60); harness.controller.undo(); harness.controller.fit(); harness.flush();
    harness.pointer("pointerdown", start.x, start.y, 1, 0, { shiftKey: true });
    harness.pointer("pointermove", start.x + 10, start.y + 40, 1, 0, { shiftKey: true }); harness.flush();
    assert.equal(harness.status.selected.x, 780);
    harness.pointer("pointermove", start.x + 50, start.y + 60, 1, 0, { shiftKey: true }); harness.flush();
    assert.equal(harness.status.selected.x, 780); harness.pointer("pointercancel", start.x + 50, start.y + 60);
  } finally { harness.dispose(); }
});

test("vegetation palette and plant hotkeys unhide their layer, and viewport layer state is reported", () => {
  const harness = controllerHarness();
  try {
    harness.controller.setLayer("trees", false); harness.controller.setLayer("grid", true); harness.flush();
    assert.equal(harness.status.trees, false); assert.equal(harness.status.grid, true);
    harness.controller.setBrush("rock"); harness.flush(); assert.equal(harness.status.trees, false);
    harness.key("1", { code: "Digit1" }); harness.flush(); assert.equal(harness.status.trees, true); assert.equal(harness.status.brush, "tree");
    harness.controller.setLayer("trees", false); harness.controller.setBrush("shrub"); harness.flush(); assert.equal(harness.status.trees, true);
    harness.controller.setLayer("trees", false); harness.key("и", { code: "KeyB" }); harness.flush();
    assert.equal(harness.status.mode, "plant"); assert.equal(harness.status.trees, true);
  } finally { harness.dispose(); }
});

test("the editor receives initial hotkey focus only while the document body still owns focus", () => {
  const automatic = controllerHarness(null, true);
  try { assert.equal(automatic.focuses, 1); } finally { automatic.dispose(); }
  const preserved = controllerHarness(null, false);
  try { assert.equal(preserved.focuses, 0, "existing input or link focus is preserved"); } finally { preserved.dispose(); }
});
