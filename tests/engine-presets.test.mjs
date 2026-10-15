import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, cacheDir: "node_modules/.vite-engine-presets", configFile: false, appType: "custom", logLevel: "silent",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EDITOR_PRESETS, getEditorPreset, getEditorCatalog, editorFolderForKind, snapshotEditorPreset, createDocumentRuntimePreset } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/editor-presets.ts");
const { createEditorCatalogTools } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/editor-catalog-tools.ts");
const forest = await vite.ssrLoadModule("/apps/engine/examples/forest/scene/objects.ts");
const forestFolders = await vite.ssrLoadModule("/apps/engine/examples/forest/scene/folders.ts");
const forestTransform = await vite.ssrLoadModule("/apps/engine/examples/forest/input/transform.ts");
const { initialTerrain } = await vite.ssrLoadModule("/packages/engine/src/terrain/terrain-data.ts");
const { createScenePainter } = await vite.ssrLoadModule("/packages/engine/src/rendering/renderer.ts");
const { EMPTY_TERRAIN_DEFINITION } = await vite.ssrLoadModule("/packages/engine/src/terrain/layout.ts");
const { SOLID_TERRAIN_PAINTER } = await vite.ssrLoadModule("/packages/engine/src/terrain/terrain.ts");
const object = (kind, extra = {}) => ({ id: `test:${kind}`, kind, x: 200, y: 250, scale: 1, variant: 0, ...extra });
const factory = (width, height) => ({ width, height, getContext: () => context() });
function context() { return new Proxy({}, { get: (_, key) => key === "createRadialGradient" || key === "createLinearGradient" ? () => ({ addColorStop() {} }) : () => {}, set: () => true }); }

test("registry versions resolve exactly and catalog metadata supplies the entire palette and variant inspector", () => {
  assert.deepEqual(EDITOR_PRESETS.map(preset => [preset.id, preset.version]), [["forest-v5", 1], ["empty-v1", 1]]);
  assert.equal(getEditorPreset("forest-v5", 2), undefined); assert.equal(getEditorPreset("missing"), undefined);
  assert.throws(() => getEditorCatalog({ presetId: "empty-v1", presetVersion: 9 }), /шаблон/);
  for (const preset of EDITOR_PRESETS) {
    const catalog = getEditorCatalog(preset);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(preset.runtime.catalog).sort());
    for (const definition of Object.values(catalog)) {
      assert.ok(definition.name); assert.ok(definition.variants >= 1); assert.ok(definition.defaultScale > 0);
      assert.equal(editorFolderForKind(preset, definition.kind), preset.runtime.catalog[definition.kind].folderId);
      assert.equal(Object.isFrozen(definition.tags), true);
    }
  }
  assert.equal(getEditorCatalog("forest-v5").image.variants, 24, "all legacy image variants remain importable even though the inspector hides that field");
  assert.equal(getEditorCatalog("forest-v5").image.variantEditable, false);
});

test("forest snapshots preserve the exact legacy baseline and remain independent of later edits", () => {
  const preset = getEditorPreset("forest-v5"), size = preset.defaultSize;
  const expected = [...forest.forestObjects(preset.defaultSeed, { x: 0, y: 0, ...size }), ...forest.initialProps()];
  const first = snapshotEditorPreset(preset), second = snapshotEditorPreset(preset);
  assert.deepEqual(first, expected); assert.deepEqual(second, expected);
  first[0].x += 100;
  assert.notEqual(first[0].x, second[0].x);
  assert.deepEqual(preset.folders, forestFolders.DEFAULT_FOLDERS);
  assert.deepEqual(snapshotEditorPreset(preset, { width: 320, height: 240 }, 11), [...forest.forestObjects(11, { x: 0, y: 0, width: 320, height: 240 }), ...forest.initialProps()]);
});

test("empty example imports only core modules and does not regenerate a forest or authored props", async () => {
  const source = await readFile(new URL("../apps/engine/examples/empty/empty-preset.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
  assert.ok(imports.every(path => path.startsWith("@/packages/engine/src/")));
  assert.deepEqual(snapshotEditorPreset("empty-v1", { width: 311, height: 231 }), []);
  assert.deepEqual(Object.keys(getEditorCatalog("empty-v1")), ["crate", "beacon", "image"]);
  assert.equal(getEditorCatalog("empty-v1").crate.variants, 3);
  assert.equal(getEditorCatalog("empty-v1").beacon.variants, 2);
});

test("catalog-bound geometry, picking, depth and resize retain every forest object's original behavior", () => {
  const preset = getEditorPreset("forest-v5"), tools = createEditorCatalogTools(preset, preset.defaultSize);
  for (const kind of Object.keys(getEditorCatalog(preset))) {
    const item = object(kind, { rotation: 17, scale: 1.2, imageWidth: 80, imageHeight: 60 });
    assert.deepEqual(tools.objectBounds(item), forest.objectBounds(item));
    assert.deepEqual(tools.objectCorners(item), forest.objectCorners(item));
    assert.equal(tools.objectAngle(item), forest.objectAngle(item));
    assert.equal(tools.objectDepth(item), forest.objectDepth(item));
    assert.equal(tools.getObjectShadowHeight(item), forest.getObjectShadowHeight(item));
    assert.equal(tools.objectFolderId(item), forestFolders.objectFolderId(item));
    for (const [x, y] of [[200, 200], [180, 240], [220, 210], [0, 0]]) assert.equal(tools.pickObject([item], x, y)?.id, forest.pickObject([item], x, y)?.id);
    const corner = tools.objectCorners(item)[2], next = { x: corner.x + 3, y: corner.y + 5 };
    assert.deepEqual(tools.resizedObject(tools.beginResize(item, 2, corner), next), forestTransform.resizedObject(forestTransform.beginResize(item, 2, corner), next, 1600, 1600));
  }
  const objects = [object("ruins"), object("jetty"), object("bridge")];
  assert.deepEqual([...objects].sort(tools.compareObjects).map(item => item.kind), [...objects].sort(forest.compareObjects).map(item => item.kind));
});

test("visibility and lock inheritance use preset folders rather than controller kind switches", () => {
  const tools = createEditorCatalogTools("empty-v1", { width: 311, height: 231 }), item = object("beacon", { x: 100, y: 150 });
  const preset = getEditorPreset("empty-v1"), hidden = preset.folders.map(folder => ({ ...folder, visible: folder.id !== "signals" }));
  assert.equal(tools.objectFolderId(item), "signals"); assert.equal(tools.isObjectVisible(item, preset.layers, hidden), false);
  assert.equal(tools.pickObject([item], 100, 100, preset.layers, hidden), undefined);
  const locked = preset.folders.map(folder => ({ ...folder, locked: folder.id === "signals" }));
  assert.equal(tools.isObjectVisible(item, preset.layers, locked), true); assert.equal(tools.isObjectLocked(item, preset.layers, locked), true);
  assert.equal(tools.pickObject([item], 100, 100, preset.layers, locked), undefined);
  assert.equal(tools.isVegetation(item), false);
});

test("placement preserves forest vegetation rules while project height and new kinds are independent", () => {
  const tools = createEditorCatalogTools("forest-v5", { width: 1600, height: 1600 });
  for (let x = 0; x <= 1600; x += 200) for (let y = 0; y <= 1600; y += 200) {
    assert.equal(tools.canPlace("tree", x, y), forest.canPlant(x, y, 1600));
    assert.equal(tools.canPlace("shrub", x, y), forest.canPlant(x, y, 1600));
    assert.equal(tools.canPlace("rock", x, y), true, "legacy rocks are not restricted to plantable grass");
  }
  assert.equal(tools.isVegetation("tree"), true); assert.equal(tools.anchorMargin(object("tree"), true), 320);
  assert.equal(tools.anchorMargin(object("tree"), false), 0); assert.equal(tools.anchorMargin(object("ruins"), true), 0);
  const tall = createEditorCatalogTools("forest-v5", { width: 1600, height: 2400 });
  assert.equal(tall.canPlace("tree", 50, 1700), true, "the old 1600 height does not constrain a new document");
  const empty = createEditorCatalogTools("empty-v1", { width: 311, height: 231, secretDocumentField: ["ignored"] });
  assert.deepEqual(empty.dimensions, { width: 311, height: 231 });
  assert.equal(empty.canPlace("crate", 300, 220), true); assert.equal(empty.canPlace("crate", 300, 232), false);
  assert.equal(empty.canPlace("beacon", -1, 220), false); assert.equal(empty.canPlace("tree", 100, 100), false);
  assert.equal(empty.canPlace("toString", 100, 100), false); assert.equal(empty.canPlace("crate", NaN, 100), false);
  assert.throws(() => createEditorCatalogTools("empty-v1", { width: 0, height: 231 }), /размер/);
});

test("a frozen document runtime renders saved baseline objects even if the source generator changes", () => {
  let calls = 0;
  const saved = [object("crate", { x: 75, y: 80, stackOrder: [10, 20] })];
  const empty = getEditorPreset("empty-v1");
  const custom = { ...empty, id: "test-generator", runtime: { ...empty.runtime, generateObjects() { calls++; return [object("beacon")]; } } };
  const runtime = createDocumentRuntimePreset(custom, saved, { width: 311, height: 231 });
  saved[0].x = 999; saved[0].stackOrder[0] = 999;
  assert.equal(runtime.generateObjects, undefined); assert.equal(calls, 0);
  const items = runtime.initialObjects(); assert.equal(items[0].x, 75); assert.deepEqual(items[0].stackOrder, [10, 20]);
  items.pop(); assert.equal(runtime.initialObjects().length, 1);
  assert.throws(() => { runtime.initialObjects()[0].x = 1; }, TypeError);
  const painter = createScenePainter(factory, runtime);
  const options = { seed: 7, width: 311, height: 231, planted: [], removed: new Set(), layers: empty.layers, folders: empty.folders };
  assert.deepEqual(painter.objects(options).map(item => item.id), ["test:crate"]); assert.equal(calls, 0);
  painter.dispose();
});

test("runtime terrain extent supports larger rectangular projects and preserves legacy forest extent by default", () => {
  assert.deepEqual(createDocumentRuntimePreset("forest-v5", [], { width: 1600, height: 1600 }).terrainBounds, { width: 3200, height: 1600 });
  const runtime = createDocumentRuntimePreset("forest-v5", [], { width: 3400, height: 2400 });
  assert.deepEqual(runtime.terrainBounds, { width: 3400, height: 2400 });
  const painter = createScenePainter(factory, runtime);
  const options = { seed: 0, width: 3400, height: 2400, planted: [], removed: new Set() };
  assert.doesNotThrow(() => painter.paint(context(), { x: 0, y: 0, width: 0, height: 0 }, options)); painter.dispose();
  assert.deepEqual(createDocumentRuntimePreset("forest-v5", [], { width: 8000, height: 32 }).terrainBounds, { width: 8000, height: 1600 });
});

test("another registered shape needs only catalog metadata and runtime art, without forest geometry", () => {
  const empty = getEditorPreset("empty-v1");
  const runtime = { ...empty.runtime, catalog: { sign: { bounds: { x: -30, y: -15, width: 60, height: 15 }, shadowHeight: 12, folderId: "props" } }, terrain: EMPTY_TERRAIN_DEFINITION, terrainPainter: SOLID_TERRAIN_PAINTER };
  const preset = { ...empty, id: "independent-sign", runtime, catalog: { sign: { kind: "sign", name: "Знак", variants: 5, variantEditable: true, defaultScale: .5, tags: [], placement: "any" } } };
  const tools = createEditorCatalogTools(preset, { width: 320, height: 400 }), item = object("sign", { x: 100, y: 300 });
  assert.deepEqual(tools.objectBounds(item), { x: 70, y: 285, width: 60, height: 15 });
  assert.equal(tools.pickObject([item], 125, 295)?.id, item.id);
  assert.equal(tools.objectFolderId(item), "props", "catalog geometry remains authoritative when metadata omits a folder hint");
  assert.equal(tools.getObjectShadowHeight(item), 12); assert.equal(tools.canPlace("sign", 300, 350), true);
  const terrain = initialTerrain(); terrain.cells["18:21"] = "water";
  assert.equal(tools.canPlace("sign", 300, 350, terrain), true, "metadata explicitly selects unrestricted placement");
});
