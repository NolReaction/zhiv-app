import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { DEFAULT_FOLDERS, defaultFolders, folderForKind, objectFolderId, folderAncestors, isFolderVisible, isFolderLocked, folderContains } = await vite.ssrLoadModule("/apps/engine/examples/forest/scene/folders.ts");
const { defaultLayers, isObjectVisible, isObjectLocked } = await vite.ssrLoadModule("/apps/engine/examples/forest/scene/stacking.ts");
const { forestObjects, initialProps, compareObjects, pickObject, canPlant, OVERSCAN_EDIT_MARGIN, WORLD_HEIGHT, MAX_WIDTH } = await vite.ssrLoadModule("/apps/engine/examples/forest/scene/objects.ts");
const { initialScene, cloneScene, validateScene, parseScene, serializeScene, createSceneHistory, writeStoredScene } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/editor-scene.ts");
const { initialTerrain, terrainCellKey } = await vite.ssrLoadModule("/apps/engine/examples/forest/terrain/terrain-data.ts");
const { readPngFile, imageObjectSize } = await vite.ssrLoadModule("/packages/engine/src/assets/image-assets.ts");
const rock = (id = "planted:rock", patch = {}) => ({ id, kind: "rock", x: 800, y: 700, scale: 1, variant: 0, rotation: 0, ...patch });
const child = (id = "child", parentId = "trees", patch = {}) => ({ id, name: "Молодые деревья", parentId, visible: true, locked: false, ...patch });
const generatedFor = scene => forestObjects(scene.seed, { x: 0, y: 0, width: scene.width, height: WORLD_HEIGHT });

test("default folders group all object kinds without changing generated records and remain independently editable", () => {
  assert.deepEqual(DEFAULT_FOLDERS.map(folder => [folder.id, folder.name]), [["trees", "Деревья"], ["shrubs", "Кусты"], ["rocks", "Камни"], ["props", "Постройки"], ["images", "Изображения"]]);
  assert.ok(Object.isFrozen(DEFAULT_FOLDERS) && DEFAULT_FOLDERS.every(Object.isFrozen));
  for (const [kind, id] of [["tree", "trees"], ["shrub", "shrubs"], ["rock", "rocks"], ["ruins", "props"], ["bridge", "props"], ["jetty", "props"], ["image", "images"]]) {
    assert.equal(folderForKind(kind), id); assert.equal(objectFolderId({ ...rock(), kind }), id);
  }
  const first = defaultFolders(), second = defaultFolders(); first[0].visible = false; first[0].name = "Изменено";
  assert.deepEqual(second, DEFAULT_FOLDERS); assert.deepEqual(initialScene().folders, DEFAULT_FOLDERS);
  const tree = generatedFor(initialScene()).find(object => object.kind === "tree");
  assert.equal(tree.folderId, undefined, "automatic membership does not add thousands of overrides");
  assert.equal(objectFolderId(tree), "trees"); assert.equal(objectFolderId({ ...tree, folderId: null }), null);
});

test("nested folder ancestry controls visibility and locks without changing painter order", () => {
  const folders = [...defaultFolders(), child(), child("grandchild", "child")];
  const object = rock("planted:child", { folderId: "grandchild" }), other = rock("planted:other", { y: 720 });
  assert.deepEqual(folderAncestors("grandchild", folders).map(folder => folder.id), ["grandchild", "child", "trees"]);
  assert.deepEqual(folderAncestors(null, folders), []);
  assert.equal(folderContains("trees", "grandchild", folders), true); assert.equal(folderContains("child", "child", folders), true);
  assert.equal(folderContains("grandchild", "child", folders), false); assert.equal(folderContains(null, "grandchild", folders), true);
  const order = [object, other].sort(compareObjects).map(entry => entry.id);
  folders[0].visible = false; folders[0].locked = true;
  assert.equal(isFolderVisible("grandchild", folders), false); assert.equal(isFolderLocked("grandchild", folders), true);
  assert.equal(isObjectVisible(object, defaultLayers(), folders), false); assert.equal(isObjectLocked(object, defaultLayers(), folders), true);
  assert.deepEqual([object, other].sort(compareObjects).map(entry => entry.id), order, "folder order and flags never change stacking keys");
});

test("folder flags combine with layers and object flags, including safe invalid hierarchies and root placement", () => {
  const folders = [...defaultFolders(), child()], layers = defaultLayers();
  const back = rock("planted:back", { stackOrder: [0], folderId: null }), front = rock("planted:front", { stackOrder: [1], folderId: "child" });
  assert.equal(pickObject([back, front], 800, 688, layers, folders)?.id, front.id);
  folders[0].locked = true; assert.equal(pickObject([back, front], 800, 688, layers, folders)?.id, back.id);
  folders[0].locked = false; folders[0].visible = false;
  assert.equal(pickObject([back, front], 800, 688, layers, folders)?.id, back.id);
  assert.equal(isObjectVisible(back, layers, folders), true); assert.equal(isObjectLocked(back, layers, folders), false);
  folders[0].visible = true; layers[1].visible = false; assert.equal(isObjectVisible(front, layers, folders), false);
  layers[1].visible = true; assert.equal(isObjectVisible({ ...front, hidden: true }, layers, folders), false);
  assert.equal(isObjectLocked({ ...front, locked: true }, layers, folders), true);
  for (const id of ["missing", "cycle"]) {
    const invalid = [...folders, child("cycle", "cycle")];
    assert.equal(folderAncestors(id, invalid), null); assert.equal(isFolderVisible(id, invalid), false); assert.equal(isFolderLocked(id, invalid), true);
  }
});

test("deleting a default group sends automatic members to root while explicit missing references are rejected", () => {
  const scene = initialScene(); scene.folders = scene.folders.filter(folder => folder.id !== "rocks");
  const automatic = rock(), rooted = rock("planted:root", { folderId: null }); scene.planted = [automatic, rooted];
  assert.ok(validateScene(scene)); assert.equal(objectFolderId(automatic, scene.folders), null);
  assert.equal(isObjectVisible(automatic, scene.layers, scene.folders), true);
  assert.equal(validateScene({ ...scene, planted: [{ ...automatic, folderId: "rocks" }] }), null);
  assert.ok(validateScene({ ...scene, folders: [], planted: [automatic, rooted] }), "an intentionally ungrouped scene is valid");
});

test("folder validation rejects cycles, dangling parents, duplicate IDs, unsafe records and excessive depth or count", () => {
  const scene = initialScene();
  const invalid = [[child("self", "self")], [child("a", "b"), child("b", "a")], [child("orphan", "missing")],
    [...defaultFolders(), { ...defaultFolders()[0] }], Array.from({ length: 129 }, (_, index) => child(`f:${index}`, null))];
  for (const folders of invalid) assert.equal(validateScene({ ...scene, folders }), null);
  for (const patch of [{ id: "" }, { id: "__proto__" }, { id: "bad id" }, { id: "x".repeat(129) }, { name: "" }, { name: " Parent " },
    { name: "x".repeat(101) }, { name: "bad\nname" }, { visible: 0 }, { locked: "false" }, { parentId: undefined }, { parentId: 1 }, { unexpected: true }]) {
    assert.equal(validateScene({ ...scene, folders: [child("test", null, patch)] }), null);
  }
  const chain = Array.from({ length: 128 }, (_, index) => child(`f:${index}`, index ? `f:${index - 1}` : null));
  assert.ok(validateScene({ ...scene, folders: chain })); assert.equal(folderAncestors("f:127", chain).length, 128);
  for (const folderId of ["missing", 1, false, ""]) assert.equal(validateScene({ ...scene, planted: [rock("planted:wrong", { folderId })] }), null);
});

test("v3 migration retains PNG bytes, layer order and every object edit while creating compact automatic folders and default terrain", async () => {
  const bytes = await readFile(new URL("../public/world/prototype/home-level-1.png", import.meta.url));
  const asset = await readPngFile(new File([bytes], "home-level-1.png"));
  const legacy = { version: 3, seed: 7391, width: 1600, assets: [asset], layers: defaultLayers().reverse(),
    planted: [{ ...rock("planted:image"), kind: "image", assetId: asset.id, ...imageObjectSize(asset), name: "Дом", layerId: "foreground", stackOrder: [3, 2], hidden: false, locked: true }],
    removed: ["prop:jetty"], modified: [{ ...initialProps()[0], x: 750, rotation: 10, name: "Вход", layerId: "background", stackOrder: [4] }] };
  const before = structuredClone(legacy), migrated = parseScene(JSON.stringify(legacy));
  assert.equal(migrated.version, 5); assert.deepEqual(migrated.folders, defaultFolders()); assert.deepEqual(migrated.terrain, initialTerrain());
  for (const field of ["layers", "planted", "removed", "modified", "assets"]) assert.deepEqual(migrated[field], legacy[field]);
  assert.deepEqual(Buffer.from(migrated.assets[0].dataUrl.split(",")[1], "base64"), bytes);
  assert.equal(migrated.planted[0].folderId, undefined); assert.deepEqual(parseScene(serializeScene(migrated)), migrated);
  assert.deepEqual(legacy, before);
  assert.equal(validateScene({ ...legacy, folders: defaultFolders() }), null);
  assert.equal(validateScene({ ...legacy, planted: [{ ...legacy.planted[0], folderId: null }] }), null);
});

test("v4 requires valid terrain and folders and round trips explicit root membership and sparse material edits", () => {
  const scene = initialScene(); scene.planted = [rock("planted:root", { folderId: null })];
  scene.terrain = { baseTrails: false, cells: { "12:38": "water", "20:30": "sand" } };
  assert.deepEqual(parseScene(serializeScene(scene)), scene);
  for (const patch of [{ folders: undefined }, { terrain: undefined }, { terrain: { baseTrails: "yes", cells: {} } },
    { terrain: { baseTrails: true, cells: { "100:0": "water" } } }, { terrain: { baseTrails: true, cells: { "1:1": "lava" } } }]) {
    assert.equal(validateScene({ ...scene, ...patch }), null);
  }
});

test("whole-group movement permits bounded generated overscan while planted objects and props remain in the world", () => {
  const scene = initialScene(), object = generatedFor(scene).find(entry => entry.kind === "tree");
  assert.equal(OVERSCAN_EDIT_MARGIN, 320);
  for (const [x, y] of [[-320, -320], [scene.width + 320, WORLD_HEIGHT + 320]]) {
    const edited = { ...object, x, y, rotation: 0, folderId: "trees" };
    assert.ok(validateScene({ ...scene, modified: [edited] }));
    const legacy = { ...scene, version: 3, modified: [{ ...edited }] }; delete legacy.folders; delete legacy.terrain; delete legacy.lighting; delete legacy.modified[0].folderId;
    assert.equal(validateScene(legacy), null, "older schemas cannot introduce new out-of-world coordinates");
  }
  for (const [x, y] of [[-320.01, 0], [0, -320.01], [scene.width + 320.01, 0], [0, WORLD_HEIGHT + 320.01]]) {
    assert.equal(validateScene({ ...scene, modified: [{ ...object, x, y, rotation: 0 }] }), null);
  }
  assert.equal(validateScene({ ...scene, planted: [rock("planted:outside", { x: -1 })] }), null);
  assert.equal(validateScene({ ...scene, modified: [{ ...initialProps()[0], x: -1, rotation: 0 }] }), null);
  const expanded = { ...scene, width: MAX_WIDTH }, far = generatedFor(expanded).find(entry => entry.x > MAX_WIDTH + 256);
  assert.ok(far, "the canonical generator really roots a few trees beyond the previous 256 px allowance");
  const legacy = { ...expanded, version: 3, modified: [{ ...far, rotation: 0, name: "На краю" }] }; delete legacy.folders; delete legacy.terrain; delete legacy.lighting;
  const migrated = validateScene(legacy); assert.ok(migrated); assert.deepEqual(parseScene(serializeScene(migrated)), migrated);
});

test("history deeply isolates folder records and terrain cells and compares equivalent sparse maps without extra commands", () => {
  const scene = initialScene(); scene.terrain.cells["2:3"] = "grass";
  scene.planted = [rock("planted:grouped", { folderId: "rocks" })];
  const copy = cloneScene(scene), history = createSceneHistory(scene);
  assert.notEqual(copy.folders[0], scene.folders[0]); assert.notEqual(copy.terrain.cells, scene.terrain.cells);
  scene.folders[0].name = "Mutation"; scene.terrain.cells["2:3"] = "water";
  assert.equal(history.getScene().folders[0].name, "Деревья"); assert.equal(history.getScene().terrain.cells["2:3"], "grass");
  assert.equal(history.commit(cloneScene(copy)), false);
  const next = history.getScene(); next.folders.push(child()); next.planted[0].folderId = "child"; next.terrain.baseTrails = false; next.terrain.cells["5:6"] = "sand";
  assert.equal(history.commit(next), true); next.folders.at(-1).locked = true; next.terrain.cells["5:6"] = "water";
  assert.deepEqual(history.undo(), copy); const redone = history.redo(); assert.equal(redone.folders.at(-1).locked, false); assert.equal(redone.terrain.cells["5:6"], "sand");
  const reordered = cloneScene(redone); reordered.terrain.cells = { "5:6": "sand", "2:3": "grass" };
  assert.equal(history.commit(reordered), false, "record insertion order is not a terrain edit");
});

test("planting honors brush overrides and base trail visibility while preserving legacy placement rules", () => {
  const state = initialTerrain(), key = terrainCellKey(200, 620);
  assert.equal(canPlant(200, 620, 1600), true); assert.equal(canPlant(200, 620, 1600, state), true);
  const water = { ...state, cells: { [key]: "water" } };
  assert.equal(canPlant(200, 620, 1600, water), false);
  const preview = { cells: new Map([[key, "grass"]]), chunkVersions: new Map() };
  assert.equal(canPlant(200, 620, 1600, water, preview), true);
  assert.equal(canPlant(1500, 1400, 1600, { ...state, cells: { [terrainCellKey(1500, 1400)]: "grass" } }), true);
  assert.equal(canPlant(620, 773, 1600), false); assert.equal(canPlant(620, 773, 1600, { ...state, baseTrails: false }), true);
  assert.equal(canPlant(730, 400, 1600, { ...state, cells: { [terrainCellKey(730, 400)]: "grass" } }), false, "authored prop reservations stay intact");
});

test("autosave uses compact JSON directly and keeps the exported scene portable", () => {
  const scene = initialScene(); scene.planted = [rock()]; let saved;
  const storage = { setItem: (_key, value) => { saved = value; }, getItem: () => saved };
  const encoder = globalThis.TextEncoder;
  try {
    globalThis.TextEncoder = class { constructor() { throw new Error("autosave must not allocate a UTF8 validation buffer"); } };
    assert.equal(writeStoredScene(storage, scene), true);
  } finally { globalThis.TextEncoder = encoder; }
  assert.equal(saved, JSON.stringify(scene)); assert.deepEqual(parseScene(saved), scene);
});
