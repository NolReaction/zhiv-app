import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { DEFAULT_LAYERS, defaultLayers, objectLayerId, isObjectVisible, isObjectLocked, stackKey, compareStackKeys, stackKeyBetween } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/scene/stacking.ts");
const { forestObjects, initialProps, compareObjects, pickObject, WORLD_HEIGHT } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/scene/objects.ts");
const { initialScene, cloneScene, validateScene, parseScene, serializeScene, createSceneHistory, MAX_SCENE_BYTES } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/scene/editor-scene.ts");
const { readPngFile, imageObjectSize } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/assets/image-assets.ts");
const { beginResize, resizedObject, resizeHandlePositions } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/input/transform.ts");

const rock = (id = "planted:rock", patch = {}) => ({ id, kind: "rock", x: 800, y: 700, scale: 1, variant: 0, rotation: 0, ...patch });
const sceneWithRock = patch => ({ ...initialScene(), planted: [rock("planted:rock", patch)] });
const sign = value => Math.sign(value);
const expectedLayers = [
  { id: "background", name: "Задний план", visible: true, locked: false },
  { id: "world", name: "Мир", visible: true, locked: false },
  { id: "foreground", name: "Передний план", visible: true, locked: false },
];

// A small genuine RGBA PNG exercises scene migration through the production importer.
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, payload) {
  const body = Buffer.concat([Buffer.from(type), payload]), result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length); body.copy(result, 4); result.writeUInt32BE(crc(body), result.length - 4); return result;
}
function png() {
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 22, 44, 66, 255, 99, 88, 77, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
const originalPng = png();
const pngAsset = await readPngFile(new File([originalPng], "перенос.png", { type: "image/png" }));

test("default layers and new scenes are independently editable without changing the frozen shared defaults", () => {
  assert.deepEqual(DEFAULT_LAYERS, expectedLayers);
  assert.ok(Object.isFrozen(DEFAULT_LAYERS));
  assert.ok(DEFAULT_LAYERS.every(Object.isFrozen));
  const first = defaultLayers(), second = defaultLayers();
  first.reverse(); first[0].visible = false; first[0].name = "Изменено";
  assert.deepEqual(second, expectedLayers); assert.deepEqual(DEFAULT_LAYERS, expectedLayers);
  const a = initialScene(), b = initialScene();
  assert.equal(a.version, 4); assert.deepEqual(a.layers, expectedLayers);
  a.layers[1].locked = true;
  assert.deepEqual(b.layers, expectedLayers); assert.deepEqual(defaultLayers(), expectedLayers);
  assert.equal(objectLayerId(rock()), "world");
  assert.equal(objectLayerId(rock("planted:background", { layerId: "background" })), "background");
});

test("v2 scenes migrate embedded PNG bytes and object edits with fresh default layers", () => {
  const image = { ...rock("planted:picture"), kind: "image", assetId: pngAsset.id, ...imageObjectSize(pngAsset) };
  const legacy = { version: 2, seed: initialScene().seed, width: 1600, planted: [image], removed: ["prop:jetty"],
    modified: [{ ...initialProps()[0], x: 700, rotation: 20 }], assets: [pngAsset] };
  const before = structuredClone(legacy), migrated = parseScene(JSON.stringify(legacy));
  assert.ok(migrated); assert.equal(migrated.version, 4); assert.deepEqual(migrated.layers, expectedLayers);
  assert.deepEqual(migrated.planted, [image]); assert.deepEqual(migrated.removed, legacy.removed); assert.deepEqual(migrated.modified, legacy.modified);
  assert.equal(migrated.assets[0].dataUrl, pngAsset.dataUrl);
  assert.deepEqual(Buffer.from(migrated.assets[0].dataUrl.split(",")[1], "base64"), originalPng);
  assert.deepEqual(parseScene(serializeScene(migrated)), migrated);
  migrated.layers[0].name = "Другая сцена";
  assert.deepEqual(parseScene(JSON.stringify(legacy)).layers, expectedLayers);
  assert.deepEqual(legacy, before, "migration never mutates the imported v2 scene");
});

test("v1 migration removes only retired stump houses and rejects new metadata on legacy versions", () => {
  const house = { ...rock("planted:house"), kind: "stump-house" };
  const survivor = rock("planted:house-looking-id", { variant: 2 });
  const legacy = { version: 1, seed: initialScene().seed, width: 1600, planted: [house, { ...house, id: "planted:removed-house" }, survivor],
    removed: ["planted:removed-house", "prop:jetty"], modified: [{ ...house, x: 600 }, { ...initialProps()[0], x: 900, rotation: 10 }] };
  const migrated = validateScene(legacy);
  assert.deepEqual(migrated, { ...initialScene(), planted: [survivor], removed: ["prop:jetty"], modified: [legacy.modified[1]] });
  for (const version of [1, 2]) {
    const source = { ...legacy, version, planted: [survivor], removed: [], modified: [], ...(version === 2 ? { assets: [] } : {}) };
    for (const patch of [{ layerId: "world" }, { hidden: false }, { locked: false }, { name: "Камень" }, { stackOrder: [1] }]) {
      assert.equal(validateScene({ ...source, planted: [{ ...survivor, ...patch }] }), null);
    }
    assert.equal(validateScene({ ...source, layers: defaultLayers() }), null, "legacy schemas cannot smuggle v3 layers");
  }
});

test("visibility and locking combine object flags and layer flags, and picking skips every unavailable object", () => {
  const layers = defaultLayers();
  const bottom = rock("planted:bottom", { stackOrder: [0] });
  const top = rock("planted:top", { stackOrder: [10] });
  assert.equal(isObjectVisible(top), true); assert.equal(isObjectLocked(top), false);
  assert.equal(pickObject([bottom, top], 800, 688, layers)?.id, top.id);
  for (const patch of [{ hidden: true }, { locked: true }, { layerId: "missing" }]) {
    assert.equal(pickObject([bottom, { ...top, ...patch }], 800, 688, layers)?.id, bottom.id);
  }
  layers[2].visible = false;
  const foreground = { ...top, layerId: "foreground" };
  assert.equal(isObjectVisible(foreground, layers), false);
  assert.equal(pickObject([bottom, foreground], 800, 688, layers)?.id, bottom.id);
  layers[2].visible = true; layers[2].locked = true;
  assert.equal(isObjectVisible(foreground, layers), true); assert.equal(isObjectLocked(foreground, layers), true);
  assert.equal(pickObject([bottom, foreground], 800, 688, layers)?.id, bottom.id);
  layers[1].locked = true;
  assert.equal(pickObject([bottom, foreground], 800, 688, layers), undefined);
  assert.equal(isObjectVisible({ ...top, layerId: "missing" }, layers), false);
  assert.equal(isObjectLocked({ ...top, layerId: "missing" }, layers), true);
});

test("layer order overrides depth and ties at identical coordinates use stable ASCII object IDs", () => {
  const layers = defaultLayers();
  const objects = [rock("planted:a"), rock("planted:Z"), rock("planted:A")];
  assert.deepEqual([...objects].sort(compareObjects).map(object => object.id), ["planted:A", "planted:Z", "planted:a"]);
  assert.deepEqual([...objects].reverse().sort(compareObjects).map(object => object.id), ["planted:A", "planted:Z", "planted:a"]);
  assert.equal(pickObject(objects, 800, 688)?.id, "planted:a");
  const back = rock("planted:back", { layerId: "background", y: 1590, stackOrder: [1e6] });
  const front = rock("planted:front", { layerId: "foreground", y: 10, stackOrder: [-1e6] });
  assert.ok(compareObjects(back, front, layers) < 0);
  assert.ok(compareObjects(back, objects[0], layers) < 0);
  layers.reverse();
  assert.ok(compareObjects(back, front, layers) > 0, "reordering a layer moves its entire contents");
  const equalManual = objects.map(object => ({ ...object, stackOrder: [42, 0] }));
  assert.deepEqual(equalManual.sort(compareObjects).map(object => object.id), ["planted:A", "planted:Z", "planted:a"]);
});

test("automatic keys keep distinct same-position objects reorderable, while manual order survives movement and resize", () => {
  const a = rock("planted:A"), b = rock("planted:B");
  assert.ok(compareStackKeys(stackKey(a), stackKey(b)) < 0);
  const between = stackKeyBetween(stackKey(a), stackKey(b));
  assert.ok(compareStackKeys(stackKey(a), between) < 0); assert.ok(compareStackKeys(between, stackKey(b)) < 0);
  const manual = { ...a, stackOrder: between, layerId: "foreground", name: "Выбранный камень", locked: false };
  assert.deepEqual(stackKey({ ...manual, x: 123, y: 987, rotation: 170, scale: 3 }), between);
  const start = resizeHandlePositions(manual)[0], resize = beginResize(manual, 0, start);
  const changed = resizedObject(resize, { x: start.x - 60, y: start.y - 60 }, 3200, 1600);
  assert.notEqual(changed.scale, manual.scale); assert.deepEqual(stackKey(changed), between);
  assert.equal(changed.layerId, manual.layerId); assert.equal(changed.name, manual.name);
  const roundTrip = parseScene(serializeScene({ ...initialScene(), planted: [changed] }));
  assert.deepEqual(roundTrip.planted[0].stackOrder, between);
});

test("fractional stacking keys insert before, after and between prefixes and adjacent IEEE numbers without ties", () => {
  assert.deepEqual(stackKeyBetween(undefined, [4, 7]), [3]);
  assert.deepEqual(stackKeyBetween([4, 7], undefined), [5]);
  assert.deepEqual(stackKeyBetween(), [0]);
  for (const [lower, upper] of [[[4], [6]], [[4, 10], [4, 20]], [[4], [4, -3]], [[1], [1 + Number.EPSILON]],
    [[1, 123], [1 + Number.EPSILON, -123]], [[0], [Number.MIN_VALUE]]]) {
    const key = stackKeyBetween(lower, upper);
    assert.ok(compareStackKeys(lower, key) < 0, `${key} must follow ${lower}`);
    assert.ok(compareStackKeys(key, upper) < 0, `${key} must precede ${upper}`);
  }
  const keys = [stackKey(rock("planted:A")), stackKey(rock("planted:B"))];
  let cursor = 7391;
  for (let step = 0; step < 400; step++) {
    cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
    const index = cursor % (keys.length - 1), inserted = stackKeyBetween(keys[index], keys[index + 1]);
    keys.splice(index + 1, 0, inserted);
  }
  for (let i = 1; i < keys.length; i++) assert.ok(compareStackKeys(keys[i - 1], keys[i]) < 0, "repeated reorder insertions remain strictly ordered");
  assert.equal(new Set(keys.map(key => JSON.stringify(key))).size, keys.length);
  assert.equal(sign(compareStackKeys([5], [5, -100])), -1, "a shorter common-prefix key sorts first");
});

test("invalid, reversed or exhausted stacking intervals fail explicitly rather than returning ambiguous order", () => {
  for (const [lower, upper] of [[[1], [1]], [[2], [1]], [[], [1]], [[1], []], [[NaN], [2]], [[1], [Infinity]],
    [[-1e9 - 1], [0]], [[0], [1e9 + 1]], [Array(257).fill(0), [1]], [undefined, [-1e9]], [[1e9], undefined],
    [[1], [1, -1e9]], [[...Array(255).fill(0), 1], [...Array(255).fill(0), 1 + Number.EPSILON]]]) {
    assert.throws(() => stackKeyBetween(lower, upper), RangeError);
  }
});

test("v3 validates object names, flags, layer references and bounded manual keys without mutating imports", () => {
  const source = sceneWithRock({ layerId: "foreground", hidden: false, locked: true, name: "Камень 🌿", stackOrder: [1, -2, 0] });
  const before = structuredClone(source);
  assert.deepEqual(validateScene(source), source);
  for (const patch of [{ layerId: "missing" }, { layerId: "" }, { layerId: 2 }, { hidden: "false" }, { locked: 1 },
    { name: "" }, { name: "   " }, { name: " Камень " }, { name: "x".repeat(101) }, { name: "🌿".repeat(51) }, { name: "bad\u0000name" }, { name: "bad\nname" },
    { name: "bad\u007fname" }, { stackOrder: [] }, { stackOrder: [NaN] }, { stackOrder: [Infinity] }, { stackOrder: [1e9 + 1] },
    { stackOrder: [-1e9 - 1] }, { stackOrder: Array(257).fill(0) }, { stackOrder: "1" }, { stackOrder: null }, { unknown: true }]) {
    assert.equal(validateScene({ ...source, planted: [{ ...source.planted[0], ...patch }] }), null, JSON.stringify(patch));
  }
  assert.ok(validateScene(sceneWithRock({ name: "🌿".repeat(50), stackOrder: [-1e9, 1e9] })));
  assert.deepEqual(source, before);
  const override = { ...initialProps()[0], layerId: "missing" };
  assert.equal(validateScene({ ...initialScene(), modified: [override] }), null, "references on overrides receive the same strict validation");
});

test("v3 requires bounded unique layers with a world layer and validates every layer record", () => {
  const source = sceneWithRock();
  const invalid = [[], defaultLayers().filter(layer => layer.id !== "world"), [...defaultLayers(), { ...defaultLayers()[1] }],
    Array.from({ length: 33 }, (_, i) => ({ id: i === 0 ? "world" : `layer:${i}`, name: `Слой ${i}`, visible: true, locked: false }))];
  for (const layers of invalid) assert.equal(validateScene({ ...source, layers }), null);
  for (const patch of [{ id: "" }, { id: "invalid id" }, { id: "слой" }, { id: "__proto__" }, { id: "x".repeat(129) },
    { name: "" }, { name: "\t" }, { name: " Слой " }, { name: "x".repeat(101) }, { name: "bad\u0000name" }, { visible: 1 }, { locked: "no" }, { extra: true }]) {
    const layers = defaultLayers(); layers[0] = { ...layers[0], ...patch };
    assert.equal(validateScene({ ...source, layers }), null, JSON.stringify(patch));
  }
  assert.equal(validateScene({ ...source, layers: undefined }), null);
  const onlyWorld = { ...source, layers: [{ id: "world", name: "Мой мир", visible: false, locked: true }] };
  assert.deepEqual(validateScene(onlyWorld), onlyWorld);
  const full = Array.from({ length: 32 }, (_, i) => ({ id: i === 0 ? "world" : `layer:${i}`, name: `Слой ${i}`, visible: true, locked: false }));
  assert.ok(validateScene({ ...source, layers: full }));
});

test("history deeply isolates layer records and key arrays, detects semantic no-ops and restores layer edits", () => {
  const source = sceneWithRock({ stackOrder: [1, 2], layerId: "world" });
  source.modified.push({ ...initialProps()[0], stackOrder: [5, 6] });
  const copy = cloneScene(source);
  assert.notEqual(copy.layers, source.layers); assert.notEqual(copy.layers[0], source.layers[0]);
  assert.notEqual(copy.planted[0].stackOrder, source.planted[0].stackOrder);
  assert.notEqual(copy.modified[0].stackOrder, source.modified[0].stackOrder);
  const history = createSceneHistory(source);
  source.layers[0].name = "Mutation"; source.planted[0].stackOrder[0] = 99;
  assert.equal(history.getScene().layers[0].name, expectedLayers[0].name); assert.deepEqual(history.getScene().planted[0].stackOrder, [1, 2]);
  assert.equal(history.commit(cloneScene(history.getScene())), false, "equivalent separately allocated key arrays are a no-op");
  assert.equal(history.canUndo, false);
  const edited = history.getScene(); edited.layers[1].locked = true; edited.layers.reverse(); edited.planted[0].stackOrder[1] = 3;
  assert.equal(history.commit(edited), true);
  edited.layers[0].visible = false; edited.planted[0].stackOrder.push(999);
  assert.equal(history.getScene().layers[0].visible, true); assert.deepEqual(history.getScene().planted[0].stackOrder, [1, 3]);
  const undone = history.undo(); assert.deepEqual(undone, copy);
  undone.layers[0].name = "Returned mutation"; undone.modified[0].stackOrder[0] = 99;
  const redone = history.redo(); assert.equal(redone.layers[2].name, expectedLayers[0].name);
  assert.deepEqual(redone.modified[0].stackOrder, [5, 6]);
  assert.equal(history.commit(cloneScene(redone)), false); assert.equal(history.canRedo, false);
});

test("legacy v3 metadata-only edits preserve overscan anchors while arbitrary out-of-world moves remain rejected", () => {
  const source = initialScene();
  const legacy = { ...source, version: 3 }; delete legacy.folders; delete legacy.terrain;
  const overscan = forestObjects(source.seed, { x: 0, y: 0, width: source.width, height: WORLD_HEIGHT })
    .find(object => object.x < 0 || object.y < 0 || object.x > source.width || object.y > WORLD_HEIGHT);
  assert.ok(overscan, "fixture includes a genuine generated object beyond the canvas edge");
  const metadata = { ...overscan, rotation: 0, layerId: "background", hidden: true, locked: true, name: "За краем", stackOrder: [3, 1] };
  const scene = { ...legacy, modified: [metadata] }, migrated = { ...source, modified: [metadata] };
  assert.deepEqual(validateScene(scene), migrated); assert.deepEqual(parseScene(serializeScene(scene)), migrated);
  for (const patch of [{ x: metadata.x + .001 }, { y: metadata.y + .001 }, { x: -10000, y: -10000 }]) {
    assert.equal(validateScene({ ...scene, modified: [{ ...metadata, ...patch }] }), null);
  }
  assert.equal(validateScene({ ...source, planted: [rock("planted:outside", { x: overscan.x, y: overscan.y })] }), null);
  const original = forestObjects(source.seed, { x: 0, y: 0, width: source.width, height: WORLD_HEIGHT })
    .find(object => object.x > 0 && object.x < source.width && object.y > 0 && object.y < WORLD_HEIGHT);
  assert.equal(validateScene({ ...legacy, modified: [{ ...original, x: -1, rotation: 0 }] }), null);
});

test("large valid compact imports remain portable when pretty formatting would exceed the JSON byte limit", () => {
  assert.match(serializeScene(initialScene()), /\n  "version"/, "ordinary exports retain readable formatting");
  const scene = initialScene(), key = Array(256).fill(.12345678901234568);
  scene.planted = Array.from({ length: 5000 }, (_, index) => rock(`planted:${index}`, { stackOrder: key }));
  const compact = JSON.stringify(scene), pretty = JSON.stringify(scene, null, 2);
  assert.ok(Buffer.byteLength(compact, "utf8") < MAX_SCENE_BYTES);
  assert.ok(Buffer.byteLength(pretty, "utf8") > MAX_SCENE_BYTES);
  const opened = parseScene(compact); assert.ok(opened, "the compact input fits all scene limits");
  const exported = serializeScene(opened);
  assert.equal(exported, JSON.stringify(opened), "oversized indentation falls back to compact JSON");
  assert.ok(Buffer.byteLength(exported, "utf8") <= MAX_SCENE_BYTES);
  assert.deepEqual(parseScene(exported), opened, "export preserves every object and manual key without losing re-importability");
  assert.equal(scene.planted[0].stackOrder, key, "serialization does not mutate caller records");
});
