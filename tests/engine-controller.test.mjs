import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEngineController } = await vite.ssrLoadModule("/apps/engine/src/editor/input/controller.ts");
const { createProjectDocument, parseProjectDocument, serializeProjectDocument } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/project-document.ts");
const { initialScene, serializeScene } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/editor-scene.ts");
const { readPngFile, imageObjectSize } = await vite.ssrLoadModule("/packages/engine/src/assets/image-assets.ts");
const { createEngineProfiler } = await vite.ssrLoadModule("/apps/engine/src/editor/diagnostics/engine-profiler.ts");

const empty = (options = {}) => createProjectDocument({ id: "project:independent", name: "Двор", presetId: "empty-v1", width: 1200, height: 2400, ...options });
const actor = (overrides = {}) => ({ id: "authored:crate", kind: "crate", x: 600, y: 2000, scale: 1, variant: 2, ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); };

/** Input, callback, canvas size and download boundaries remain observable; drawing itself is inert. */
function harness(document = empty(), settings = {}) {
  const globals = new Map(), frames = new Map(), handlers = new Map(), editorHandlers = new Map(), windowHandlers = new Map(), captures = new Set();
  const changes = [], surfaces = [], downloads = [], blobs = [];
  let nextFrame = 0, status, disposed = false, storageReads = 0;
  const install = (key, value) => { globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  const noop = () => {};
  const context = new Proxy({}, { get: (target, key) => target[key] ?? (String(key).includes("Gradient") ? () => ({ addColorStop: noop }) : noop) });
  const editor = { contains: target => target === canvas || target?.insideEditor, addEventListener: (type, handler) => editorHandlers.set(type, handler), removeEventListener: type => editorHandlers.delete(type), focus: noop };
  const canvas = { dataset: {}, style: {}, getContext: () => context, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    closest: selector => selector === "[data-forest-editor]" ? editor : null, focus: noop, addEventListener: (type, handler) => handlers.set(type, handler), removeEventListener: type => handlers.delete(type),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  const browserWindow = { devicePixelRatio: 1, addEventListener: (type, handler) => windowHandlers.set(type, handler), removeEventListener: type => windowHandlers.delete(type), setTimeout: callback => { callback(); return 0; } };
  Object.defineProperty(browserWindow, "localStorage", { get() { storageReads++; throw new Error("The project host owns persistence"); } });
  install("window", browserWindow);
  install("document", { body: {}, activeElement: {}, addEventListener: noop, removeEventListener: noop, createElement: tag => {
    if (tag === "a") return { click() { downloads.push(this.download); } };
    throw new Error("All drawing surfaces must use the injected canvas factory");
  } });
  install("requestAnimationFrame", callback => { const id = ++nextFrame; frames.set(id, callback); return id; });
  install("cancelAnimationFrame", id => frames.delete(id));
  install("ResizeObserver", class { observe() {} disconnect() {} });
  const OriginalURL = globalThis.URL;
  install("URL", class extends OriginalURL { static createObjectURL(blob) { blobs.push(blob); return "blob:engine-controller"; } static revokeObjectURL() {} });
  const controller = createEngineController(canvas, value => { status = value; }, {
    initialDocument: document, onDocumentChange: value => changes.push(value), loadImage: async dataUrl => ({ width: 2, height: 1, dataUrl }),
    createCanvas(width, height) { const surface = { width, height, getContext: () => context, toBlob: callback => callback(new Blob(["PNG"], { type: "image/png" })) }; surfaces.push(surface); return surface; }, ...settings,
  });
  return {
    controller, changes, surfaces, downloads, blobs,
    get status() { return status; }, get storageReads() { return storageReads; }, get pendingFrames() { return frames.size; },
    document: () => controller.getDocument(),
    flush() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
    screen(x, y) { const zoom = status?.zoom ?? Math.min(1000 / document.width, 1000 / document.height) * .94; const scene = controller.getDocument(); return { x: 500 + (x - scene.width / 2) * zoom, y: 500 + (y - scene.height / 2) * zoom }; },
    pointer(type, x, y, modifiers = {}) { handlers.get(type)?.({ type, target: canvas, pointerId: 1, button: 0, shiftKey: false, pointerType: "mouse", clientX: x, clientY: y, preventDefault: noop, ...modifiers }); },
    key(key, modifiers = {}) { let prevented = false; editorHandlers.get("keydown")?.({ key, target: canvas, preventDefault() { prevented = true; }, ...modifiers }); return prevented; },
    dispose() { if (disposed) return; disposed = true; controller.dispose(); for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } },
  };
}

function pngFile() {
  const chunk = (type, bytes) => {
    const body = Buffer.concat([Buffer.from(type), bytes]), result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); body.copy(result, 4);
    let crc = 0xffffffff; for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return new File([Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(9))), chunk("IEND", Buffer.alloc(0))])], "точные-байты.png", { type: "image/png" });
}

test("independent tall projects expose their own catalog and never access legacy browser storage", () => {
  const h = harness();
  try {
    h.flush(); assert.equal(h.storageReads, 0); assert.equal(h.status.height, 2400); assert.equal(h.status.projectName, "Двор");
    assert.deepEqual(Object.keys(h.status.catalog), ["crate", "beacon", "image"]); assert.equal(h.status.objectList.length, 0);
    assert.equal(h.changes.length, 0, "initial paint and focus do not save an unchanged project");
    h.key("1", { code: "Digit1" }); h.key("Enter"); h.flush();
    assert.equal(h.document().planted[0].kind, "crate"); assert.equal(h.document().planted[0].y, 1200);
    h.key("2", { code: "Digit2" }); h.key("Enter"); h.flush();
    assert.equal(h.document().planted[1].kind, "beacon"); assert.equal(h.document().planted[1].variant < 2, true);
    assert.equal(h.changes.length, 2); assert.ok(parseProjectDocument(h.controller.getSceneJson()));
    h.controller.undo(); h.controller.redo(); assert.equal(h.changes.length, 4); assert.equal(h.document().planted.length, 2);
  } finally { h.dispose(); }
});

test("saved authored baseline overrides generators and generic picking, transforms and delete are undoable", () => {
  const source = empty(); source.baseObjects = [actor()]; const h = harness(source);
  try {
    h.flush(); assert.equal(h.status.objectList[0].id, "authored:crate");
    const at = h.screen(600, 1980); h.pointer("pointerdown", at.x, at.y); h.pointer("pointerup", at.x, at.y); h.flush();
    assert.equal(h.status.selected?.id, "authored:crate", "catalog bounds support a kind never known by the forest editor");
    h.controller.updateSelected({ y: 2300, variant: 1 }); assert.equal(h.document().modified[0].y, 2300);
    h.controller.updateSelected({ variant: 3 }); assert.equal(h.document().modified[0].variant, 1, "crate variants are constrained by its own catalog");
    h.key("ArrowDown", { shiftKey: true }); assert.equal(h.document().modified[0].y, 2310);
    h.key("Delete"); assert.deepEqual(h.document().removed, ["authored:crate"]);
    h.key("я", { code: "KeyZ", ctrlKey: true }); assert.equal(h.document().removed.length, 0);
    assert.equal(h.document().baseObjects[0].y, 2000, "commands leave the original project baseline intact");
    assert.ok(parseProjectDocument(h.controller.getSceneJson()));
  } finally { h.dispose(); }
});

test("one generic drag commits one snapshot and cancellation leaves history and callbacks unchanged", () => {
  const source = empty(); source.baseObjects = [actor()]; const h = harness(source);
  try {
    h.flush(); const at = h.screen(600, 1980);
    h.pointer("pointerdown", at.x, at.y); h.pointer("pointermove", at.x + 25, at.y + 30); h.flush();
    assert.equal(h.changes.length, 0); assert.ok(h.status.selected.y > 2000);
    h.pointer("pointercancel", at.x + 25, at.y + 30); h.flush(); assert.equal(h.document().modified.length, 0); assert.equal(h.status.canUndo, false);
    h.pointer("pointerdown", at.x, at.y); h.pointer("pointermove", at.x + 25, at.y + 30); h.pointer("pointerup", at.x + 25, at.y + 30); h.flush();
    assert.equal(h.changes.length, 1); assert.equal(h.document().modified.length, 1);
    h.controller.undo(); assert.equal(h.document().modified.length, 0); assert.equal(h.changes.length, 2);
  } finally { h.dispose(); }
});

test("generic folders inherit locks and default membership through transfer, area selection and Undo", () => {
  const source = empty(); source.baseObjects = [actor(), actor({ id: "authored:beacon", kind: "beacon", variant: 0, x: 800 })]; const h = harness(source);
  try {
    const folder = h.controller.addFolder(); h.controller.moveObjectToFolder("authored:crate", folder); h.controller.selectFolder(folder); h.controller.translateSelectedFolder(0, 250);
    assert.equal(h.document().modified.find(object => object.id === "authored:crate").y, 2250);
    h.controller.setFolderLocked(folder, true); const locked = h.controller.getSceneJson(); h.controller.translateSelectedFolder(30, 30); assert.equal(h.controller.getSceneJson(), locked);
    h.controller.setFolderLocked(folder, false); h.controller.moveObjectToFolder("authored:crate", undefined);
    const area = h.controller.createFolderFromArea({ x: 500, y: 1900, width: 400, height: 500 }); assert.ok(area);
    assert.equal(h.document().modified.filter(object => object.folderId === area).length, 2);
    h.controller.undo(); assert.ok(!h.document().folders.some(item => item.id === area)); assert.ok(parseProjectDocument(h.controller.getSceneJson()));
  } finally { h.dispose(); }
});

test("deleting authored folders and layers repairs baseline references, including removed actors, without relocating them", () => {
  const source = empty();
  source.layers.push({ id: "layer:authored", name: "Авторский слой", visible: true, locked: false });
  source.folders.push({ id: "folder:authored", name: "Авторская папка", parentId: null, visible: true, locked: false });
  source.baseObjects = [actor({ layerId: "layer:authored", folderId: "folder:authored" }), actor({ id: "authored:removed", x: 700, layerId: "layer:authored", folderId: "folder:authored" })];
  const h = harness(source);
  try {
    h.controller.selectById("authored:removed"); h.controller.deleteSelected();
    h.controller.deleteLayer("layer:authored"); assert.ok(parseProjectDocument(h.controller.getSceneJson()));
    h.controller.deleteFolder("folder:authored"); assert.ok(parseProjectDocument(h.controller.getSceneJson()));
    for (const object of h.document().baseObjects) { assert.equal(object.layerId, "world"); assert.equal(object.folderId, null); assert.equal(object.y, 2000); }
    h.controller.resetEdits(); assert.equal(h.document().removed.length, 0); assert.ok(parseProjectDocument(h.controller.getSceneJson()));
    h.controller.undo(); h.controller.undo(); h.controller.undo();
    assert.deepEqual(h.document().baseObjects, source.baseObjects); assert.ok(parseProjectDocument(h.controller.getSceneJson()));
  } finally { h.dispose(); }
});

test("terrain and point lights respect document height beyond the former 1600-unit limit", () => {
  const h = harness();
  try {
    h.flush(); h.controller.setMode("terrain"); h.controller.setTerrainBrush("water"); const at = h.screen(600, 2100);
    h.pointer("pointerdown", at.x, at.y); h.pointer("pointerup", at.x, at.y);
    assert.equal(h.document().terrain.cells["37:131"], "water"); h.controller.undo(); assert.deepEqual(h.document().terrain.cells, {});
    const light = h.controller.addPointLight(); assert.ok(light); assert.equal(h.controller.updatePointLight(light, { y: 2300 }), true);
    assert.equal(h.controller.updatePointLight(light, { y: 2401 }), false); assert.equal(h.document().lighting.points[0].y, 2300);
    assert.ok(parseProjectDocument(h.controller.getSceneJson()));
  } finally { h.dispose(); }
});

test("project rename is reversible, cleans names and returned/callback documents cannot mutate editor state", () => {
  const h = harness();
  try {
    assert.equal(h.controller.renameProject("  Дом\u0000 🌿  "), true); h.flush(); assert.equal(h.status.projectName, "Дом 🌿");
    assert.equal(h.controller.renameProject("   "), false); assert.equal(h.changes.length, 1);
    h.changes[0].name = "external mutation"; h.controller.getDocument().lighting.ambient = .01;
    assert.equal(h.document().name, "Дом 🌿"); assert.equal(h.document().lighting.ambient, 1);
    h.controller.undo(); h.flush(); assert.equal(h.status.projectName, "Двор"); h.controller.redo(); assert.equal(h.document().name, "Дом 🌿");
    h.controller.exportScene(); assert.equal(h.downloads.at(-1), "Дом 🌿.json");
  } finally { h.dispose(); }
});

test("v6 import switches catalogs and sizes atomically, and undo returns the prior saved baseline", async () => {
  const h = harness();
  try {
    const forest = createProjectDocument({ id: "project:forest", name: "Лес", presetId: "forest-v5" });
    assert.equal(await h.controller.importScene(serializeProjectDocument(forest)), true); h.flush();
    assert.equal(h.status.height, 1600); assert.ok(h.status.catalog.tree); assert.ok(h.status.objectList.some(object => object.id === "prop:ruins"));
    h.controller.undo(); h.flush(); assert.equal(h.status.height, 2400); assert.equal(h.status.objectList.length, 0); assert.ok(h.status.catalog.crate);
    h.controller.redo(); h.flush(); assert.equal(h.status.projectId, forest.id); assert.ok(h.status.catalog.tree);
    const before = h.controller.getSceneJson(); const invalid = { ...forest, presetVersion: 2 };
    assert.equal(await h.controller.importScene(JSON.stringify(invalid)), false); assert.equal(h.controller.getSceneJson(), before);
  } finally { h.dispose(); }
});

test("legacy v5 JSON imports into independent projects with a preserved frozen forest snapshot", async () => {
  const h = harness();
  try {
    const legacy = initialScene(); legacy.planted.push({ id: "planted:old-rock", kind: "rock", x: 900, y: 600, scale: 1, variant: 4, rotation: 0 });
    assert.equal(await h.controller.importScene(serializeScene(legacy)), true); const current = h.document();
    assert.equal(current.version, 6); assert.equal(current.presetId, "forest-v5"); assert.equal(current.height, 1600);
    assert.deepEqual(current.planted, legacy.planted); assert.ok(current.baseObjects.some(object => object.id === "prop:bridge"));
    h.controller.resetEdits(); h.controller.undo(); assert.deepEqual(h.document().planted, legacy.planted);
  } finally { h.dispose(); }
});

test("expansion preserves authored baseline positions and regeneration/reset remain separate undo commands", () => {
  const source = createProjectDocument({ id: "project:edited-baseline", name: "Свой лес", presetId: "forest-v5" });
  source.baseObjects.find(object => object.id === "prop:ruins").x = 550;
  const h = harness(source);
  try {
    h.controller.selectById("prop:ruins"); h.controller.updateSelected({ x: 600 });
    const originalBaseline = h.document().baseObjects;
    assert.equal(h.controller.expand(), true); assert.equal(h.document().width, 2400); assert.equal(h.document().height, 1600);
    for (const original of originalBaseline) assert.deepEqual(h.document().baseObjects.find(object => object.id === original.id), original);
    assert.equal(h.document().modified.find(object => object.id === "prop:ruins").x, 600);
    h.controller.resetEdits(); assert.equal(h.document().baseObjects.find(object => object.id === "prop:ruins").x, 550);
    h.controller.undo(); assert.equal(h.document().modified.find(object => object.id === "prop:ruins").x, 600);
    const expanded = h.controller.getSceneJson(), seed = h.document().seed;
    assert.equal(h.controller.regenerate(), true); assert.notEqual(h.document().seed, seed); assert.equal(h.document().modified.length, 0);
    assert.equal(h.document().baseObjects.find(object => object.id === "prop:ruins").x, 780);
    h.controller.undo(); assert.equal(h.controller.getSceneJson(), expanded); assert.ok(parseProjectDocument(expanded));
    h.controller.undo(); assert.equal(h.document().width, 1600);
  } finally { h.dispose(); }
});

test("scene dimension and pixel ceilings reject expansion without changing callbacks or history", () => {
  for (const size of [{ width: 8192, height: 64 }, { width: 7800, height: 8192 }]) {
    const h = harness(empty(size));
    try {
      const before = h.controller.getSceneJson(); assert.equal(h.controller.expand(), false);
      assert.equal(h.controller.getSceneJson(), before); assert.equal(h.changes.length, 0); h.flush(); assert.equal(h.status.canUndo, false);
    } finally { h.dispose(); }
  }
});

test("PNG import and portable export preserve source bytes and use exact project dimensions", async () => {
  const h = harness();
  try {
    const file = pngFile(); assert.equal(await h.controller.importPng(file), true); h.flush();
    const data = h.document(); assert.deepEqual(Buffer.from(data.assets[0].dataUrl.split(",")[1], "base64"), Buffer.from(await file.arrayBuffer()));
    assert.equal(data.planted[0].y - data.planted[0].imageHeight / 2, 1200);
    h.controller.exportScene(); const portable = JSON.parse(await h.blobs.at(-1).text()); assert.deepEqual(portable.assets, data.assets);
    await h.controller.exportPng(); assert.ok(h.surfaces.some(surface => surface.width === 1200 && surface.height === 2400));
    assert.equal(h.downloads.at(-1), "Двор.png"); assert.equal(h.storageReads, 0);
  } finally { h.dispose(); }
});

test("stale PNG decoding after a different project import cannot insert into its catalog or report a change", async () => {
  const gate = deferred(), asset = await readPngFile(pngFile()), h = harness(empty(), { loadImage: () => gate.promise });
  try {
    const pending = h.controller.addPngAsset(asset); await microtasks(); const next = empty({ id: "project:next", width: 800, height: 600 });
    assert.equal(await h.controller.importScene(serializeProjectDocument(next)), true); const before = h.controller.getSceneJson(), changes = h.changes.length;
    gate.resolve({ width: 2, height: 1 }); assert.equal(await pending, false); assert.equal(h.controller.getSceneJson(), before); assert.equal(h.changes.length, changes);
  } finally { h.dispose(); }
});

test("pending scene decoding cannot replace a newer edit or commit after disposal", async () => {
  const asset = await readPngFile(pngFile()), source = empty(); source.assets = [asset]; source.planted = [actor({ id: "planted:png", kind: "image", variant: 0, assetId: asset.id, ...imageObjectSize(asset) })];
  for (const action of ["edit", "dispose"]) {
    const gate = deferred(), h = harness(empty(), { loadImage: () => gate.promise });
    try {
      const pending = h.controller.importScene(serializeProjectDocument(source)); await microtasks();
      if (action === "edit") h.controller.renameProject("Новее импорта"); else h.controller.dispose();
      gate.resolve({ width: 2, height: 1 }); assert.equal(await pending, false);
      assert.equal(h.changes.length, action === "edit" ? 1 : 0); assert.equal(h.document().planted.length, 0);
    } finally { h.dispose(); }
  }
});

test("diagnostics are opt-in and normal rename/Undo preserves prepared PNG sources and idle frames", async () => {
  let ticks = 0, decodes = 0; const profiler = createEngineProfiler({ clock: () => ++ticks }); const asset = await readPngFile(pngFile());
  const source = empty(); source.assets = [asset]; source.baseObjects = [actor()]; const h = harness(source, { profiler, loadImage: async () => { decodes++; return { width: 2, height: 1 }; } });
  try {
    await microtasks(); h.flush(); assert.equal(ticks, 0); assert.equal(h.controller.getDiagnostics().profile.enabled, false);
    h.controller.setDiagnosticsEnabled(true); h.flush(); h.controller.renameProject("С замером"); h.flush(); h.controller.undo(); await microtasks(); h.flush();
    const diagnostics = h.controller.getDiagnostics(); assert.ok(diagnostics.profile.timings.paint.count > 0); assert.equal(diagnostics.profile.timings.commit.count, 1); assert.equal(diagnostics.profile.timings.undo.count, 1);
    assert.equal(decodes, 1, "history clones do not discard a semantically unchanged baseline's prepared source cache");
    assert.equal(diagnostics.rendering.memory.actualMemoryMeasured, false); assert.equal(diagnostics.rendering.memory.decodedImageCount, 1);
    assert.equal(h.pendingFrames, 0, "diagnostics alone never create a permanent animation loop");
  } finally { h.dispose(); }
});
