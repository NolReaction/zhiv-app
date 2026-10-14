import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const core = await vite.ssrLoadModule("/packages/engine/src/scene/document.ts");
const project = await vite.ssrLoadModule("/apps/engine/src/editor/scene/project-document.ts");
const { initialScene, parseScene, serializeScene } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/editor-scene.ts");
const { snapshotEditorPreset, createDocumentRuntimePreset } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/editor-presets.ts");
const { createScenePainter } = await vite.ssrLoadModule("/packages/engine/src/rendering/renderer.ts");
const { readPngFile } = await vite.ssrLoadModule("/packages/engine/src/assets/image-assets.ts");

function empty() { return project.createProjectDocument({ id: "project:test", name: "Лаборатория", presetId: "empty-v1", seed: 14, width: 317, height: 2301 }); }
function object(id = "placed:crate") { return { id, kind: "crate", x: 100, y: 2200, scale: 1, variant: 2, rotation: 0 }; }
function document() {
  const result = empty();
  result.baseObjects = [{ ...object("authored:crate"), x: 150 }];
  result.planted = [object()]; result.modified = [{ ...result.baseObjects[0], x: 170 }];
  result.terrain.cells = { "0:0": "sand", "18:140": "water" };
  result.lighting.points = [{ id: "point:one", name: "Лампа", x: 100, y: 2200, radius: 80, intensity: .7, color: "#aabbcc", enabled: true }];
  return result;
}
function pngFile() {
  const chunk = (type, data) => {
    const label = Buffer.from(type), bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length); label.copy(bytes, 4); data.copy(bytes, 8);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([label, data])) {
      crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return new File([Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 20, 120, 40, 180, 80, 50, 20, 255]))), chunk("IEND", Buffer.alloc(0))])], "original.png", { type: "image/png" });
}

test("a universal document supports custom kinds, dimensions and authored baseline without forest dependencies", () => {
  const value = document();
  value.presetId = "custom:astronomy";
  for (const entry of [...value.baseObjects, ...value.planted, ...value.modified]) entry.kind = "telescope";
  const restored = core.validateSceneDocument(value);
  assert.deepEqual(restored, value);
  assert.notEqual(restored.baseObjects, value.baseObjects);
  assert.equal(core.validateSceneDocument(value, { catalog: { crate: {} } }), null, "supplied content catalog must resolve every kind");
  assert.equal(project.validateProjectDocument(value), null, "the editor rejects an unavailable preset instead of regenerating it");
  restored.baseObjects[0].x = 9;
  assert.equal(value.baseObjects[0].x, 150, "validated input never leaks mutable object references");
});

test("new projects select independent presets with editable names and arbitrary bounded dimensions", () => {
  const value = empty();
  assert.equal(value.version, 6); assert.equal(value.height, 2301); assert.equal(value.width, 317);
  assert.deepEqual(value.baseObjects, []); assert.equal(value.presetId, "empty-v1");
  assert.deepEqual(project.parseProjectDocument(project.serializeProjectDocument(document())), document());
  assert.equal(project.createProjectDocument({ presetId: "empty-v1", name: "  Первый  ", width: 1, height: 1 }).name, "Первый");
  const a = project.createProjectDocument(), b = project.createProjectDocument();
  assert.notEqual(a.id, b.id); assert.equal(a.presetId, "forest-v5");
  assert.deepEqual(a.baseObjects, snapshotEditorPreset("forest-v5", { width: 1600, height: 1600 }, a.seed));
  for (const options of [{ presetId: "missing" }, { presetVersion: 2 }, { name: "  " }, { name: "bad\nname" }, { id: "constructor" },
    { width: 0 }, { height: 8193 }, { width: 8192, height: 8192 }, { width: 1.5 }, { seed: -1 }, { seed: 1.5 }]) {
    assert.throws(() => project.createProjectDocument(options));
  }
});

test("metadata, unsafe keys and invalid dimensions reject entire projects", () => {
  const source = document();
  for (const patch of [{ version: 5 }, { id: "" }, { id: "__proto__" }, { id: "<script>" }, { id: "a".repeat(129) },
    { name: "" }, { name: " space " }, { name: "a".repeat(101) }, { name: "bad\u0000name" }, { presetId: "prototype" },
    { presetVersion: 0 }, { presetVersion: 1.1 }, { seed: NaN }, { width: Infinity }, { height: 0 }, { height: 1.5 },
    { width: 8192, height: 8192 }, { surprise: true }]) assert.equal(core.validateSceneDocument({ ...source, ...patch }), null, JSON.stringify(patch));
  const candidate = { ...source }; candidate[Symbol("unsafe")] = true;
  assert.equal(core.validateSceneDocument(candidate), null);
  assert.equal(project.parseProjectDocument("{broken"), null);
  assert.equal(project.parseProjectDocument('{"version":6,"__proto__":{"polluted":true}}'), null);
  assert.equal({}.polluted, undefined);
  assert.equal(project.parseProjectDocument(" ".repeat(core.MAX_PROJECT_DOCUMENT_BYTES + 1)), null);
  assert.equal(project.validateProjectDocument({ ...source, presetId: "unknown-v1" }), null);
  assert.equal(project.validateProjectDocument({ ...source, presetVersion: 2 }), null);
});

test("duplicate and unresolved object references, removed edits and kind changes fail closed", () => {
  const source = document(), baseline = source.baseObjects[0], placed = source.planted[0];
  const patches = [
    { baseObjects: [baseline, baseline] }, { planted: [placed, placed] }, { planted: [{ ...placed, id: baseline.id }] },
    { removed: ["missing"] }, { removed: [baseline.id, baseline.id] }, { removed: [baseline.id] },
    { modified: [source.modified[0], source.modified[0]] }, { modified: [{ ...baseline, id: "missing" }] },
    { modified: [{ ...baseline, kind: "beacon" }] }, { planted: [{ ...placed, kind: "missing" }] }, { planted: [{ ...placed, variant: 3 }] },
  ];
  for (const patch of patches) assert.equal(project.validateProjectDocument({ ...source, ...patch }), null);
  assert.deepEqual(project.validateProjectDocument({ ...source, modified: [{ ...placed, x: 200 }] }).modified, [{ ...placed, x: 200 }], "placed IDs may also be moved");
  assert.equal(core.validateSceneDocument({ ...source, planted: Array.from({ length: core.MAX_PLANTED_OBJECTS + 1 }, (_, index) => object(`placed:${index}`)) }), null);
  assert.equal(core.validateSceneDocument({ ...source, baseObjects: Array.from({ length: core.MAX_BASE_OBJECTS + 1 }, (_, index) => object(`base:${index}`)) }), null);
});

test("object bounds, metadata and bounded baseline overscan are independently validated", () => {
  const source = document(), placed = source.planted[0];
  for (const patch of [{ x: -1 }, { x: 318 }, { y: 2302 }, { scale: .09 }, { scale: 8.1 }, { rotation: 181 }, { variant: .5 },
    { name: " untrimmed " }, { name: "bad\nname" }, { layerId: "missing" }, { folderId: "missing" }, { hidden: 1 }, { locked: null },
    { shadowHeight: 481 }, { stackOrder: [] }, { stackOrder: [Infinity] }, { extra: true }, { assetId: "image" }]) {
    assert.equal(project.validateProjectDocument({ ...source, planted: [{ ...placed, ...patch }] }), null, JSON.stringify(patch));
  }
  const baseline = { ...source.baseObjects[0], x: -170, y: 40 };
  const offMap = { ...source, baseObjects: [baseline], modified: [{ ...baseline, rotation: 20 }] };
  assert.ok(core.validateSceneDocument(offMap), "an authored off-map anchor can preserve metadata and transforms");
  assert.equal(core.validateSceneDocument(offMap, { baseObjectMargin: 0 }), null);
  assert.equal(core.validateSceneDocument({ ...offMap, modified: [{ ...baseline, x: -171 }] }), null, "moving farther outside requires an explicit edit margin");
  assert.ok(core.validateSceneDocument({ ...offMap, modified: [{ ...baseline, x: -171 }] }, { editMargin: 200 }));
  assert.equal(core.validateSceneDocument({ ...offMap, baseObjects: [{ ...baseline, x: -8193 }], modified: [] }), null);
  assert.equal(core.validateSceneDocument(source, { editMargin: Infinity }), null);
});

test("layer and folder references reject duplicates, missing ancestors and cycles", () => {
  const source = document(), folder = source.folders[0], layer = source.layers[0];
  const patches = [{ layers: [] }, { layers: source.layers.filter(entry => entry.id !== "world") }, { layers: [layer, layer] },
    { layers: [{ ...layer, visible: 1 }, ...source.layers.slice(1)] }, { folders: [folder, folder] },
    { folders: [{ ...folder, parentId: "missing" }] }, { folders: [{ ...folder, parentId: folder.id }] },
    { folders: [{ ...folder, id: "a", parentId: "b" }, { ...folder, id: "b", parentId: "a" }] },
    { folders: [{ ...folder, name: "" }] }];
  for (const patch of patches) assert.equal(core.validateSceneDocument({ ...source, ...patch }), null);
  source.folders.push({ id: "nested", name: "Вложенная", parentId: folder.id, visible: true, locked: false });
  source.planted[0].folderId = "nested"; source.planted[0].layerId = "foreground";
  assert.deepEqual(project.validateProjectDocument(source), source);
});

test("terrain materials and point lights respect custom project height and import limits", () => {
  const source = document();
  assert.ok(project.validateProjectDocument(source), "a valid light beyond legacy 1600 height is retained");
  for (const terrain of [{ baseTrails: true, cells: { "0:0": "lava" } }, { baseTrails: true, cells: { "20:0": "sand" } },
    { baseTrails: true, cells: { "0:144": "sand" } }, { baseTrails: true, cells: { "01:0": "sand" } },
    { baseTrails: true, cells: {}, appearance: { shoreStyle: "natural", shoreHeight: 25, blendWidth: 24, scatter: .5 } }]) {
    assert.equal(core.validateSceneDocument({ ...source, terrain }), null);
  }
  for (const patch of [{ x: 318 }, { y: 2302 }, { radius: 31 }, { intensity: 2.1 }, { color: "red" }, { name: "" }]) {
    assert.equal(core.validateSceneDocument({ ...source, lighting: { ...source.lighting, points: [{ ...source.lighting.points[0], ...patch }] } }), null);
  }
  assert.equal(core.validateSceneDocument({ ...source, lighting: { ...source.lighting, points: [source.lighting.points[0], source.lighting.points[0]] } }), null);
});

test("PNG bytes and metadata round trip without resizing and reject broken references or proportions", async () => {
  const file = pngFile(), asset = await readPngFile(file), source = document();
  source.assets = [asset]; source.planted = [{ ...object("placed:image"), kind: "image", variant: 0, assetId: asset.id, imageWidth: 320, imageHeight: 160 }];
  const restored = project.parseProjectDocument(project.serializeProjectDocument(source));
  assert.deepEqual(restored, source);
  assert.deepEqual(Buffer.from(restored.assets[0].dataUrl.split(",")[1], "base64"), Buffer.from(await file.arrayBuffer()));
  for (const patch of [{ assetId: "png:missing" }, { imageWidth: 0 }, { imageWidth: 321 }, { imageHeight: 4097 }]) {
    assert.equal(core.validateSceneDocument({ ...source, planted: [{ ...source.planted[0], ...patch }] }), null);
  }
  assert.equal(core.validateSceneDocument({ ...source, assets: [asset, asset] }), null);
  assert.equal(core.validateSceneDocument({ ...source, assets: [{ ...asset, width: 3 }] }), null);
  const unsafeAsset = { ...asset }; unsafeAsset[Symbol("unsafe")] = true;
  assert.equal(core.validateSceneDocument({ ...source, assets: [unsafeAsset] }), null);
});

test("every legacy scene version migrates through its original rules into a stable saved baseline", () => {
  for (const version of [1, 2, 3, 4, 5]) {
    const legacy = initialScene(); legacy.version = version;
    legacy.planted = [{ id: "planted:one", kind: "rock", x: 100, y: 100, scale: 1, variant: 3 }];
    if (version < 5) delete legacy.lighting;
    if (version < 4) { delete legacy.folders; delete legacy.terrain; }
    if (version < 3) delete legacy.layers;
    if (version < 2) delete legacy.assets;
    const json = JSON.stringify(legacy), validatedLegacy = parseScene(json), migrated = project.parseProjectDocument(json);
    assert.ok(migrated, `legacy v${version}`); assert.equal(migrated.version, 6); assert.equal(migrated.height, 1600);
    assert.equal(migrated.id, "project:legacy-forest"); assert.equal(migrated.presetVersion, 1);
    assert.deepEqual(migrated.baseObjects, snapshotEditorPreset("forest-v5", { width: legacy.width, height: 1600 }, legacy.seed));
    for (const key of ["planted", "removed", "modified", "assets", "layers", "folders", "terrain", "lighting"]) assert.deepEqual(migrated[key], validatedLegacy[key]);
    assert.deepEqual(project.parseProjectDocument(project.serializeProjectDocument(migrated)), migrated);
  }
});

test("legacy PNG scenes retain exact bytes, names, edits and formerly accepted unused variants", async () => {
  const asset = await readPngFile(pngFile()), legacy = initialScene();
  legacy.assets = [asset]; legacy.planted = [{ id: "planted:png", kind: "image", variant: 23, x: 500, y: 700, scale: 1,
    rotation: 0, assetId: asset.id, imageWidth: 320, imageHeight: 160, name: "Мой рисунок", shadowHeight: 70 }];
  const migrated = project.parseProjectDocument(serializeScene(legacy));
  assert.ok(migrated); assert.deepEqual(migrated.assets, legacy.assets); assert.deepEqual(migrated.planted, legacy.planted);
  for (const version of [2, 3, 4]) {
    const previous = structuredClone(legacy); previous.version = version; delete previous.lighting; delete previous.planted[0].shadowHeight;
    if (version < 4) { delete previous.folders; delete previous.terrain; }
    if (version < 3) { delete previous.layers; delete previous.planted[0].name; }
    const oldMigration = project.parseProjectDocument(JSON.stringify(previous));
    assert.ok(oldMigration, `PNG v${version}`); assert.deepEqual(oldMigration.assets, legacy.assets);
    assert.equal(oldMigration.planted[0].variant, 23); assert.equal(oldMigration.planted[0].assetId, asset.id);
  }
});

test("a v6 snapshot does not regenerate content when the seed changes or baseline differs from current preset output", () => {
  const source = project.createProjectDocument({ id: "project:frozen", name: "Снимок", presetId: "forest-v5" });
  const changed = { ...source, seed: source.seed + 10, baseObjects: [{ id: "saved:rock", kind: "rock", x: 200, y: 300, scale: 1, variant: 3 }] };
  const imported = project.parseProjectDocument(project.serializeProjectDocument(changed));
  assert.deepEqual(imported.baseObjects, changed.baseObjects);
  const runtime = createDocumentRuntimePreset(imported, imported.baseObjects, imported), painter = createScenePainter(() => assert.fail("queries allocate no canvas"), runtime);
  try {
    assert.deepEqual(painter.objects({ ...imported, removed: new Set(imported.removed) }), changed.baseObjects);
  } finally { painter.dispose(); }
});

test("project history includes names, dimensions, baseline, folders, lights and exact asset snapshots", async () => {
  const initial = document(); initial.assets = [await readPngFile(pngFile())];
  const history = project.createProjectHistory(initial, 2), preview = history.getDocument();
  preview.name = "Переименован"; preview.width = 400; preview.baseObjects[0].x = 220;
  preview.assets[0].name = "renamed.png"; preview.folders[0].name = "Моя папка"; preview.lighting.points[0].radius = 160;
  assert.deepEqual(history.getScene(), initial); assert.equal(history.canUndo, false);
  assert.equal(history.commit(preview), true); preview.baseObjects[0].x = 999;
  assert.equal(history.getDocument().baseObjects[0].x, 220, "committed snapshots do not depend on caller objects");
  const edited = history.getDocument(); assert.deepEqual(history.undo(), initial); assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(), edited); assert.equal(history.commit(core.cloneSceneDocument(edited)), false);
  const returned = history.undo(); returned.assets[0].name = "mutated.png";
  const fork = history.getDocument(); fork.name = "Другая ветка"; assert.equal(history.commit(fork), true);
  assert.equal(history.canRedo, false); assert.equal(history.getDocument().assets[0].name, "original.png");
});

test("history ignores sparse terrain key order, retains bounded commands and validates its limit", () => {
  const initial = document(), history = project.createProjectHistory(initial, 2);
  const reordered = core.cloneSceneDocument(initial); reordered.terrain.cells = { "18:140": "water", "0:0": "sand" };
  assert.equal(history.commit(reordered), false); assert.equal(history.canUndo, false);
  for (const name of ["Один", "Два", "Три"]) history.commit({ ...initial, name });
  assert.equal(history.undo().name, "Два"); assert.equal(history.undo().name, "Один"); assert.equal(history.undo(), null);
  assert.equal(history.redo().name, "Два"); assert.equal(history.redo().name, "Три"); assert.equal(history.redo(), null);
  for (const limit of [0, -1, 1.5, Infinity, 1001]) assert.throws(() => project.createProjectHistory(initial, limit), RangeError);
});

test("portable serialization falls back to compact JSON and never exports a file its importer rejects for size", () => {
  const source = empty(), stackOrder = Array.from({ length: 256 }, () => 1_000_000_000);
  source.baseObjects = Array.from({ length: 6_500 }, (_, index) => ({ ...object(`base:${index}`), stackOrder }));
  const compact = project.serializeProjectDocument(source);
  assert.ok(compact === JSON.stringify(source), "a dense valid project uses compact form when whitespace exceeds the byte limit");
  assert.ok(project.parseProjectDocument(compact));
  source.baseObjects = Array.from({ length: 13_000 }, (_, index) => ({ ...object(`base:${index}`), stackOrder }));
  assert.ok(core.validateSceneDocument(source), "the structure is bounded, but its dense stack keys need more than the portable byte budget");
  assert.throws(() => project.serializeProjectDocument(source), /32 МиБ/);
});
