import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { initialScene, cloneScene, validateScene, parseScene, serializeScene, createSceneHistory, readStoredScene, writeStoredScene, SCENE_STORAGE_KEY, MAX_SCENE_BYTES } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/editor-scene.ts");
const { forestObjects, initialProps, objectCorners, WORLD_HEIGHT } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/objects.ts");
const { createForestPainter } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/renderer.ts");
const { createForestController } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/controller.ts");
const { readPngFile, imageObjectSize } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/image-assets.ts");

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
    { ...source, version: 3 }, { ...source, seed: NaN }, { ...source, seed: 2.5 },
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
  for (const patch of [{ x: -1 }, { x: 1601 }, { y: 1601 }, { y: Infinity }, { scale: .09 }, { scale: 8.01 },
    { variant: -1 }, { variant: 24 }, { variant: 1.5 }, { rotation: -181 }, { rotation: 181 }, { kind: "house" }, { __proto__: { surprise: true } }]) {
    const candidate = { ...object, ...patch };
    if (Object.getPrototypeOf(patch) !== Object.prototype) Object.setPrototypeOf(candidate, Object.getPrototypeOf(patch));
    assert.equal(validateScene({ ...source, planted: [candidate] }), null, JSON.stringify(patch));
  }
  assert.equal(validateScene({ ...source, planted: Array.from({ length: 5001 }, (_, i) => ({ ...object, id: `planted:${i}` })) }), null);
  const valid = validateScene({ ...source, planted: [{ ...object, scale: .1, variant: 0, rotation: -180 }, { ...object, id: "planted:18", scale: 8, variant: 23, rotation: 180 }] });
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
function controllerHarness(initialJson = null, focusBody = false, settings = {}) {
  const previousGlobals = new Map();
  const install = (key, value) => { previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  const frames = new Map(), handlers = new Map(), editorHandlers = new Map(), windowHandlers = new Map(), captured = new Set();
  let frameId = 0, writes = 0, focuses = 0, pngRequests = 0, harnessDisposed = false, lastStatus;
  const draws = [], translations = [], downloads = [];
  const values = new Map(initialJson === null ? [] : [[SCENE_STORAGE_KEY, initialJson]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes++; values.set(key, value); } };
  const noop = () => {};
  const ctx = new Proxy({}, { get: (target, key) => target[key] ?? (key === "drawImage" ? (...args) => draws.push(args) : key === "translate" ? (...args) => translations.push(args)
    : String(key).includes("Gradient") ? () => ({ addColorStop: noop }) : noop) });
  const editor = { contains: target => target === canvas || target?.insideEditor === true,
    addEventListener: (type, handler) => editorHandlers.set(type, handler), removeEventListener: type => editorHandlers.delete(type), focus: () => { focuses++; } };
  const canvas = { dataset: {}, style: {}, width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    addEventListener: (type, handler) => handlers.set(type, handler), removeEventListener: type => handlers.delete(type), focus: noop,
    closest: selector => selector === "[data-forest-editor]" ? editor : null,
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id) };
  install("window", { devicePixelRatio: 1, localStorage: storage,
    addEventListener: (type, handler) => windowHandlers.set(type, handler), removeEventListener: type => windowHandlers.delete(type), setTimeout: callback => { callback(); return 0; } });
  const body = {};
  install("document", { body, activeElement: focusBody ? body : {}, createElement: tag => tag === "a" ? { click() { downloads.push(this.download); } }
    : { width: 0, height: 0, getContext: () => ctx, toBlob: callback => callback(new Blob(["PNG"], { type: "image/png" })) } });
  install("requestAnimationFrame", callback => { const id = ++frameId; frames.set(id, callback); return id; });
  install("cancelAnimationFrame", id => frames.delete(id));
  install("ResizeObserver", class { observe() {} disconnect() {} });
  const controller = createForestController(canvas, status => { lastStatus = status; }, {
    loadImage: async dataUrl => ({ width: 2, height: 1, dataUrl }), ...settings,
    requestPngImport: () => { pngRequests++; settings.requestPngImport?.(); },
  });
  return {
    controller,
    scene: () => JSON.parse(controller.getSceneJson()),
    get writes() { return writes; },
    get focuses() { return focuses; },
    get pngRequests() { return pngRequests; },
    get draws() { return draws; },
    get translations() { return translations; },
    get downloads() { return downloads; },
    get inlineCursor() { return canvas.style.cursor; },
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
      if (harnessDisposed) return; harnessDisposed = true;
      controller.dispose();
      for (const [key, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    },
  };
}

test("controller edits imported planted overrides and allocates safe IDs even after huge numeric imports", async () => {
  const scene = initialScene();
  const hugeId = "planted:999999999999999999999999999999999999";
  scene.planted.push({ id: hugeId, kind: "rock", x: 700, y: 700, scale: 1, rotation: 0, variant: 0 });
  scene.modified.push({ ...scene.planted[0], x: 800, rotation: 15 });
  const harness = controllerHarness();
  try {
    assert.equal(await harness.controller.importScene(serializeScene(scene)), true);
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
    assert.equal(await harness.controller.importScene('{"version":2}'), false);
    assert.equal(harness.controller.getSceneJson(), stable, "rejected import cannot replace or partially modify the scene");
    assert.equal(await harness.controller.importScene("{broken"), false);
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

test("edge pan continues with a stationary pointer, preserves grab offset and zoom scale, and remains one undo command", async () => {
  const harness = controllerHarness();
  try {
    const fixture = initialScene();
    fixture.removed = forestObjects(fixture.seed, { x: 0, y: 0, width: fixture.width, height: WORLD_HEIGHT }).map(object => object.id);
    fixture.modified = [{ ...initialProps().find(object => object.kind === "ruins"), x: 750, y: 800 }];
    await harness.controller.importScene(serializeScene(fixture)); harness.controller.selectById("prop:ruins");
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


function pngFile(name = "tree.png", width = 2, height = 1, rgba = [20, 120, 40, 180]) {
  const chunk = (type, data) => {
    const label = Buffer.from(type), result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length); label.copy(result, 4); data.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([label, data])) {
      crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) Buffer.from(rgba).copy(pixels, y * (1 + width * 4) + 1 + x * 4);
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  return new File([bytes], name, { type: "image/png" });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); };
function pngScene(asset, overrides = {}) {
  const scene = initialScene();
  scene.removed = [...forestObjects(scene.seed, { x: 0, y: 0, width: scene.width, height: WORLD_HEIGHT }), ...initialProps()].map(object => object.id);
  scene.assets = [asset]; scene.planted = [{ id: "planted:png", kind: "image", assetId: asset.id, ...imageObjectSize(asset), x: 800, y: 900, scale: 1, rotation: 35, variant: 0, ...overrides }];
  return scene;
}

test("PNG file import preserves original bytes, exposes an image brush and places its visual center in the camera", async () => {
  const file = pngFile("leaf.png"), asset = await readPngFile(file), harness = controllerHarness();
  let saved;
  try {
    harness.key("7", { code: "Digit7", target: harness.button }); harness.key("7", { code: "Numpad7", target: harness.button });
    harness.key("7", { code: "Digit7", repeat: true }); assert.equal(harness.pngRequests, 2);
    assert.equal(harness.scene().planted.length, 0, "the file-picker hotkey never plants a procedural house");
    assert.equal(await harness.controller.importPng(file), true); harness.flush();
    const image = harness.scene().planted[0];
    assert.equal(image.kind, "image"); assert.equal(image.x, 800); assert.equal(image.y - image.imageHeight / 2, 800);
    assert.equal(image.assetId, asset.id); assert.equal(image.variant, 0); assert.equal(harness.status.mode, "select");
    assert.deepEqual(harness.status.assets, [{ id: asset.id, name: "leaf.png" }]); assert.equal(harness.status.brushAssetId, asset.id);
    const bytes = Buffer.from(await file.arrayBuffer()); assert.equal(harness.scene().assets[0].dataUrl, `data:image/png;base64,${bytes.toString("base64")}`);
    assert.equal(harness.controller.setImageBrush(asset.id), true); harness.key("Enter"); assert.equal(harness.scene().planted.length, 2);
    assert.equal(harness.scene().assets.length, 1, "copies share their original asset bytes");
    harness.controller.undo(); assert.equal(harness.scene().planted.length, 1);
    harness.controller.resetEdits(); assert.equal(harness.scene().planted.length, 0); assert.deepEqual(harness.scene().assets, [asset], "reset preserves the reusable asset library");
    harness.controller.undo(); harness.controller.regenerate(); assert.deepEqual(harness.scene().assets, [asset]); harness.controller.undo();
    saved = harness.controller.getSceneJson(); assert.deepEqual(parseScene(saved), harness.scene());
  } finally { harness.dispose(); }
  const restored = controllerHarness(saved);
  try { await microtasks(); restored.flush(); assert.deepEqual(restored.scene(), JSON.parse(saved)); assert.equal(restored.status.assets[0].name, "leaf.png"); }
  finally { restored.dispose(); }
});

test("PNG additions await decoding, preserve newer edits, and undo removes the first asset as one command", async () => {
  const asset = await readPngFile(pngFile()), decode = deferred();
  const harness = controllerHarness(null, false, { loadImage: () => decode.promise });
  try {
    const pending = harness.controller.addPngAsset(asset); await microtasks();
    assert.equal(harness.scene().assets.length, 0); assert.equal(harness.scene().planted.length, 0); assert.equal(harness.writes, 0);
    harness.controller.selectById("prop:bridge"); harness.controller.updateSelected({ rotation: 25 });
    decode.resolve({ width: asset.width, height: asset.height }); assert.equal(await pending, true);
    assert.equal(harness.scene().modified.find(object => object.id === "prop:bridge").rotation, 25, "decoding cannot overwrite newer committed edits");
    assert.equal(harness.scene().assets.length, 1); assert.equal(harness.scene().planted.length, 1);
    harness.controller.undo(); assert.equal(harness.scene().assets.length, 0); assert.equal(harness.scene().planted.length, 0);
    assert.equal(harness.scene().modified[0].rotation, 25); harness.controller.redo(); assert.equal(harness.scene().assets.length, 1);
  } finally { harness.dispose(); }
});

test("PNG rejection and failed decode leave the current scene intact and explicit retry can succeed", async () => {
  const asset = await readPngFile(pngFile()), decode = deferred(); let calls = 0;
  const harness = controllerHarness(null, false, { loadImage: () => { calls++; return calls === 1 ? decode.promise : Promise.resolve({}); } });
  try {
    const before = harness.controller.getSceneJson();
    assert.equal(await harness.controller.importPng(new File(["not PNG"], "bad.png", { type: "image/png" })), false);
    assert.equal(await harness.controller.addPngAsset({ ...asset, dataUrl: "https://example.com/image.png" }), false);
    assert.equal(calls, 0); assert.equal(harness.controller.getSceneJson(), before);
    const pending = harness.controller.addPngAsset(asset); await microtasks(); decode.reject(new Error("decoder rejected pixels"));
    assert.equal(await pending, false); assert.equal(harness.controller.getSceneJson(), before); assert.equal(harness.writes, 0);
    assert.equal(await harness.controller.addPngAsset(asset), true); assert.equal(calls, 2); assert.equal(harness.scene().assets.length, 1);
  } finally { harness.dispose(); }
});

test("staged JSON import cannot replace newer edits or commit after the controller closes", async () => {
  const asset = await readPngFile(pngFile()), decode = deferred(), incoming = pngScene(asset);
  const harness = controllerHarness(null, false, { loadImage: () => decode.promise });
  try {
    const pending = harness.controller.importScene(serializeScene(incoming)); await microtasks();
    harness.controller.selectById("prop:bridge"); harness.controller.updateSelected({ x: 700 });
    const changed = harness.controller.getSceneJson(); decode.resolve({}); assert.equal(await pending, false);
    assert.equal(harness.controller.getSceneJson(), changed); assert.equal(harness.scene().assets.length, 0);
  } finally { harness.dispose(); }
  const later = deferred(), closed = controllerHarness(null, false, { loadImage: () => later.promise });
  try {
    const pending = closed.controller.importScene(serializeScene(incoming)); await microtasks(); closed.dispose(); later.resolve({});
    assert.equal(await pending, false);
  } finally { closed.dispose(); }
});

test("background decode errors from an abandoned scene cannot replace a newer scene's message", async () => {
  const asset = await readPngFile(pngFile()), decode = deferred();
  const harness = controllerHarness(serializeScene(pngScene(asset)), false, { loadImage: () => decode.promise });
  try {
    await microtasks(); assert.equal(await harness.controller.importScene(serializeScene(initialScene())), true); harness.flush();
    const message = harness.status.message; decode.reject(new Error("old scene decode failed")); await microtasks(); await microtasks(); harness.flush();
    assert.equal(harness.status.message, message); assert.equal(harness.scene().assets.length, 0);
  } finally { harness.dispose(); }
});

test("PNG export waits for decoding and paints its committed snapshot even if the user edits meanwhile", async () => {
  const asset = await readPngFile(pngFile()), decode = deferred(), native = { originalPng: true };
  const incoming = pngScene(asset, { rotation: 0 });
  const harness = controllerHarness(serializeScene(incoming), false, { loadImage: () => decode.promise });
  try {
    const pending = harness.controller.exportPng(); await microtasks(); assert.equal(harness.downloads.length, 0);
    harness.controller.selectById("planted:png"); harness.controller.updateSelected({ x: 1000 });
    decode.resolve(native); await pending;
    assert.equal(harness.downloads.length, 1); assert.ok(harness.draws.some(call => call[0] === native));
    assert.ok(harness.translations.some(([x, y]) => x === 800 && y === 900), "export uses the snapshot's anchor instead of a later edit");
    assert.equal(harness.scene().planted[0].x, 1000, "export cannot restore stale snapshot data into the live scene");
  } finally { harness.dispose(); }
});

function closePoint(actual, expected, message) {
  assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-7, message);
}

test("all rotated PNG corners resize uniformly at both zooms and commit exactly one undo entry", async () => {
  const asset = await readPngFile(pngFile()), harness = controllerHarness();
  try {
    for (const factor of [1, 2]) for (const corner of [0, 1, 2, 3]) {
      const fixture = pngScene(asset, { x: 750, y: 850 }); await harness.controller.importScene(serializeScene(fixture));
      harness.controller.selectById("planted:png"); harness.controller.zoom(factor); harness.flush(1000);
      const object = harness.scene().planted[0], zoom = harness.status.zoom, corners = objectCorners(object), fixed = corners[(corner + 2) % 4], handle = corners[corner];
      const start = harness.screen(handle.x, handle.y, zoom), grab = { x: 3 / zoom, y: 2 / zoom };
      const target = { x: fixed.x + (handle.x - fixed.x) * 1.5 + grab.x, y: fixed.y + (handle.y - fixed.y) * 1.5 + grab.y };
      const end = harness.screen(target.x, target.y, zoom), before = harness.controller.getSceneJson(), writes = harness.writes;
      harness.pointer("pointermove", start.x + 3, start.y + 2); assert.equal(harness.cursor, "resize"); assert.match(harness.inlineCursor, /resize$/);
      harness.pointer("pointerdown", start.x + 3, start.y + 2);
      harness.pointer("pointermove", (start.x + 3 + end.x) / 2, (start.y + 2 + end.y) / 2); harness.flush(1016);
      harness.pointer("pointermove", end.x, end.y); harness.flush(1032);
      assert.ok(Math.abs(harness.status.selected.scale - 1.5) < 1e-8, `corner ${corner}, zoom factor ${factor}, actual scale ${harness.status.selected.scale}, selected ${harness.status.selected.id}`); assert.equal(harness.writes, writes);
      closePoint(objectCorners(harness.status.selected)[(corner + 2) % 4], fixed, "the opposite corner stays fixed in world coordinates");
      assert.equal(harness.status.selected.imageWidth / harness.status.selected.imageHeight, 2);
      harness.pointer("pointerup", end.x, end.y); assert.equal(harness.writes, writes + 1);
      harness.controller.undo(); assert.equal(harness.controller.getSceneJson(), before);
      harness.controller.redo(); assert.ok(Math.abs(harness.scene().planted[0].scale - 1.5) < 1e-8);
    }
  } finally { harness.dispose(); }
});

test("corner resize is canceled by Escape, blur, pointercancel or a second finger, and wins over erase", async () => {
  const asset = await readPngFile(pngFile()), harness = controllerHarness();
  try {
    for (const stop of ["Escape", "blur", "pointercancel", "pinch"]) {
      await harness.controller.importScene(serializeScene(pngScene(asset, { rotation: 0 })));
      harness.controller.selectById("planted:png"); harness.controller.setMode("erase"); harness.flush();
      const object = harness.scene().planted[0], handle = objectCorners(object)[0], start = harness.screen(handle.x, handle.y);
      const before = harness.controller.getSceneJson(), writes = harness.writes;
      harness.pointer("pointerdown", start.x, start.y); harness.pointer("pointermove", start.x - 40, start.y - 20); harness.flush();
      assert.equal(harness.status.mode, "select", "visible handles take priority over erase"); assert.ok(harness.status.selected.scale > 1);
      if (stop === "Escape") harness.key("Escape");
      else if (stop === "blur") harness.blur();
      else if (stop === "pointercancel") harness.pointer("pointercancel", start.x - 40, start.y - 20);
      else { harness.pointer("pointerdown", start.x + 80, start.y + 20, 2, 0, { pointerType: "touch" }); harness.pointer("pointerup", start.x + 80, start.y + 20, 2); }
      harness.pointer("pointerup", start.x - 40, start.y - 20); harness.flush();
      assert.equal(harness.controller.getSceneJson(), before); assert.equal(harness.writes, writes);
    }
  } finally { harness.dispose(); }
});

test("tiny selected PNG and shrub bodies still move while their exact corner handles resize", async () => {
  const asset = await readPngFile(pngFile()), harness = controllerHarness();
  try {
    for (const kind of ["image", "shrub"]) {
      const fixture = pngScene(asset, { scale: .1, rotation: 0 });
      if (kind === "shrub") { fixture.assets = []; fixture.planted = [{ id: "planted:tiny", kind, x: 800, y: 900, scale: .1, rotation: 0, variant: 0 }]; }
      const id = fixture.planted[0].id;
      await harness.controller.importScene(serializeScene(fixture)); harness.controller.selectById(id); harness.flush();
      const object = harness.scene().planted[0], corners = objectCorners(object);
      const middle = corners.reduce((point, corner) => ({ x: point.x + corner.x / 4, y: point.y + corner.y / 4 }), { x: 0, y: 0 });
      const start = harness.screen(middle.x, middle.y), writes = harness.writes;
      harness.pointer("pointermove", start.x, start.y); assert.notEqual(harness.cursor, "resize", "expanded handle hit areas leave the tiny object's center draggable");
      harness.pointer("pointerdown", start.x, start.y); harness.pointer("pointermove", start.x + 20, start.y); harness.flush();
      assert.equal(harness.status.selected.scale, .1); assert.ok(harness.status.selected.x > object.x, "dragging the center moves instead of resizing");
      harness.pointer("pointerup", start.x + 20, start.y); assert.equal(harness.writes, writes + 1);
      const moved = harness.controller.getSceneJson(), movedCorner = objectCorners(harness.scene().planted[0])[0], handle = harness.screen(movedCorner.x, movedCorner.y);
      harness.pointer("pointermove", handle.x, handle.y); assert.equal(harness.cursor, "resize");
      harness.pointer("pointerdown", handle.x, handle.y); harness.pointer("pointermove", handle.x - 20, handle.y - 10); harness.flush();
      assert.ok(harness.status.selected.scale > .1, "the exact corner remains usable even on a tiny object");
      harness.pointer("pointercancel", handle.x - 20, handle.y - 10); assert.equal(harness.controller.getSceneJson(), moved);
    }
  } finally { harness.dispose(); }
});

test("zooming at a grabbed resize handle preserves the current transform and its opposite corner", async () => {
  const asset = await readPngFile(pngFile()), harness = controllerHarness();
  try {
    await harness.controller.importScene(serializeScene(pngScene(asset, { rotation: 20 })));
    harness.controller.selectById("planted:png"); harness.flush();
    const original = harness.scene().planted[0], corners = objectCorners(original), start = harness.screen(corners[0].x, corners[0].y);
    const fixed = corners[2], before = harness.controller.getSceneJson(), writes = harness.writes;
    harness.pointer("pointerdown", start.x + 3, start.y + 2);
    const end = { x: start.x - 35, y: start.y - 20 };
    harness.pointer("pointermove", end.x, end.y); harness.flush(); const resized = { ...harness.status.selected };
    harness.controller.zoom(1.5, end); harness.flush();
    assert.ok(Math.abs(harness.status.selected.scale - resized.scale) < 1e-8);
    closePoint(harness.status.selected, resized, "zooming at the pointer does not move the resized anchor");
    closePoint(objectCorners(harness.status.selected)[2], fixed, "opposite corner remains fixed through camera zoom");
    harness.pointer("pointercancel", end.x, end.y); assert.equal(harness.controller.getSceneJson(), before); assert.equal(harness.writes, writes);
  } finally { harness.dispose(); }
});

test("a perpendicular corner gesture leaves no spurious modification or undo entry", async () => {
  const asset = await readPngFile(pngFile()), harness = controllerHarness();
  try {
    await harness.controller.importScene(serializeScene(pngScene(asset, { rotation: 0 })));
    harness.controller.selectById("planted:png"); harness.flush();
    const object = harness.scene().planted[0], corners = objectCorners(object), handle = corners[0], fixed = corners[2];
    const dx = handle.x - fixed.x, dy = handle.y - fixed.y, magnitude = Math.hypot(dx, dy);
    const target = harness.screen(handle.x - dy / magnitude * 30, handle.y + dx / magnitude * 30), start = harness.screen(handle.x, handle.y);
    const before = harness.controller.getSceneJson(), writes = harness.writes;
    harness.pointer("pointerdown", start.x, start.y); harness.pointer("pointermove", target.x, target.y); harness.pointer("pointerup", target.x, target.y);
    assert.equal(harness.controller.getSceneJson(), before); assert.equal(harness.writes, writes);
  } finally { harness.dispose(); }
});
