import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { initialLighting, cloneLighting, validateLighting, MAX_POINT_LIGHTS } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/lighting/lighting-data.ts");
const { initialScene, cloneScene, validateScene, parseScene, serializeScene, createSceneHistory } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/scene/editor-scene.ts");
const { forestObjects, initialProps, getObjectShadowHeight, WORLD_HEIGHT, OVERSCAN_EDIT_MARGIN } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/scene/objects.ts");
const { readPngFile, imageObjectSize } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/assets/image-assets.ts");

const defaults = {
  enabled: false, ambient: 1, ambientColor: "#ffffff", sunAngle: 135, sunElevation: 45,
  sunIntensity: .4, sunColor: "#fff3d8", shadowOpacity: .3, shadowSoftness: 8, points: [],
};
const light = (id = "light:1", patch = {}) => ({ id, name: "Фонарь", x: 800, y: 600, radius: 160, intensity: .8, color: "#ffaa33", enabled: true, ...patch });
const rock = (id = "planted:rock", patch = {}) => ({ id, kind: "rock", x: 600, y: 700, scale: 1, variant: 2, rotation: 0, ...patch });
const withPoint = patch => ({ ...initialLighting(), enabled: true, points: [light("light:1", patch)] });

// Native PNG bytes cross the production import and legacy-scene migration boundaries.
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
    chunk("IDAT", deflateSync(Buffer.from([0, 31, 54, 76, 255, 94, 118, 144, 128]))), chunk("IEND", Buffer.alloc(0))]);
}
const pngBytes = png();
const pngAsset = await readPngFile(new File([pngBytes], "фонарь.png", { type: "image/png" }));

test("lighting starts disabled and independent clones cannot alter defaults or another scene", () => {
  const first = initialLighting(), second = initialLighting();
  assert.deepEqual(first, defaults); assert.deepEqual(second, defaults);
  first.ambient = .2; first.points.push(light());
  assert.deepEqual(second, defaults); assert.deepEqual(initialLighting(), defaults);
  const copied = cloneLighting(first);
  assert.notEqual(copied, first); assert.notEqual(copied.points, first.points); assert.notEqual(copied.points[0], first.points[0]);
  copied.points[0].x = 100; copied.points[0].name = "Другой фонарь";
  assert.equal(first.points[0].x, 800); assert.equal(first.points[0].name, "Фонарь");
  const a = initialScene(), b = initialScene();
  assert.equal(a.version, 5); assert.deepEqual(a.lighting, defaults);
  a.lighting.points.push(light()); a.lighting.sunAngle = 200;
  assert.deepEqual(b.lighting, defaults);
});

test("global lighting parameters accept both boundaries and reject nonfinite, missing or out-of-range values", () => {
  const limits = { ambient: [.15, 1.5], sunAngle: [0, 359], sunElevation: [10, 85], sunIntensity: [0, 1.5], shadowOpacity: [0, .8], shadowSoftness: [0, 24] };
  for (const [field, [minimum, maximum]] of Object.entries(limits)) {
    for (const value of [minimum, maximum]) {
      const source = { ...initialLighting(), [field]: value };
      assert.deepEqual(validateLighting(source, 1600), source, `${field} accepts ${value}`);
    }
    for (const value of [minimum - .001, maximum + .001, NaN, Infinity, -Infinity, "1", null, true, undefined]) {
      assert.equal(validateLighting({ ...initialLighting(), [field]: value }, 1600), null, `${field} rejects ${String(value)}`);
    }
  }
  assert.ok(validateLighting({ ...initialLighting(), sunAngle: 135.25, sunElevation: 43.5 }, 1600), "fractional angles remain valid");
  assert.equal(validateLighting({ ...initialLighting(), enabled: 1 }, 1600), null);
  const missing = initialLighting(); delete missing.enabled;
  assert.equal(validateLighting(missing, 1600), null);
});

test("lighting accepts exact six-digit hex colors and preserves their spelling while rejecting alternate syntax", () => {
  for (const field of ["ambientColor", "sunColor"]) {
    for (const color of ["#000000", "#ffffff", "#Aa09Ff"]) {
      const source = { ...initialLighting(), [field]: color };
      assert.deepEqual(validateLighting(source, 1600), source);
    }
    for (const color of ["white", "#fff", "#ffffff00", "#12345g", "123456", " #ffffff", "#ffffff ", "rgb(0,0,0)", "", null, 123, undefined]) {
      assert.equal(validateLighting({ ...initialLighting(), [field]: color }, 1600), null);
    }
  }
  assert.equal(validateLighting(withPoint({ color: "#AbCdEf" }), 1600).points[0].color, "#AbCdEf");
  for (const color of ["#abc", "#aabbccff", "red", "#12xx34", null]) assert.equal(validateLighting(withPoint({ color }), 1600), null);
});

test("point lights accept world edges, explicit zero intensity and radius limits without clipping", () => {
  for (const width of [1600, 2400, 3200]) {
    const source = { ...initialLighting(), points: [light("light:left", { x: 0, y: 0, radius: 32, intensity: 0, enabled: false }),
      light("light:right", { x: width, y: WORLD_HEIGHT, radius: 800, intensity: 2 })] };
    assert.deepEqual(validateLighting(source, width), source);
    for (const patch of [{ x: -.001 }, { x: width + .001 }, { y: -.001 }, { y: WORLD_HEIGHT + .001 }, { x: NaN }, { y: Infinity },
      { radius: 31.999 }, { radius: 800.001 }, { radius: Infinity }, { intensity: -.001 }, { intensity: 2.001 }, { intensity: NaN },
      { intensity: "1" }, { enabled: 0 }, { enabled: undefined }]) {
      assert.equal(validateLighting(withPoint(patch), width), null, JSON.stringify(patch));
    }
  }
  for (const width of [0, -1, NaN, Infinity, "1600"]) assert.equal(validateLighting(initialLighting(), width), null);
});

test("point light IDs and names are strict, IDs are unique and the scene budget is bounded", () => {
  assert.equal(MAX_POINT_LIGHTS, 32);
  for (const patch of [{ id: "" }, { id: "bad id" }, { id: "фонарь" }, { id: "__proto__" }, { id: "constructor" }, { id: "prototype" },
    { id: "x".repeat(129) }, { id: 1 }, { name: "" }, { name: "   " }, { name: " Фонарь " }, { name: "x".repeat(101) },
    { name: "🌿".repeat(51) }, { name: "bad\u0000name" }, { name: "bad\nname" }, { name: "bad\u007fname" }, { name: null }]) {
    assert.equal(validateLighting(withPoint(patch), 1600), null, JSON.stringify(patch));
  }
  assert.ok(validateLighting(withPoint({ id: "x".repeat(128), name: "🌿".repeat(50) }), 1600));
  const full = { ...initialLighting(), points: Array.from({ length: 32 }, (_, index) => light(`light:${index}`)) };
  assert.ok(validateLighting(full, 1600));
  assert.equal(validateLighting({ ...full, points: [...full.points, light("light:33")] }, 1600), null);
  assert.equal(validateLighting({ ...full, points: [light(), { ...light(), name: "Другая лампа" }] }, 1600), null);
  assert.equal(validateLighting({ ...full, points: null }, 1600), null);
  assert.equal(validateLighting({ ...full, points: [null] }, 1600), null);
});

test("validation rejects unknown lighting fields and unsafe records, returns fresh records and leaves imports intact", () => {
  const source = withPoint(), before = structuredClone(source), accepted = validateLighting(source, 1600);
  assert.deepEqual(accepted, source); assert.notEqual(accepted, source); assert.notEqual(accepted.points, source.points); assert.notEqual(accepted.points[0], source.points[0]);
  accepted.points[0].x = 9; assert.equal(source.points[0].x, 800);
  const inherited = Object.create({ ambient: 1 }); Object.assign(inherited, source);
  for (const value of [null, [], inherited, { ...source, exposure: 1 }, { ...source, points: [light("light:1", { layerId: "world" })] },
    { ...source, points: [light("light:1", { assetId: pngAsset.id })] }, { ...source, points: [light("light:1", { extra: true })] },
    JSON.parse('{"enabled":false,"__proto__":{"polluted":true}}')]) {
    assert.equal(validateLighting(value, 1600), null);
  }
  assert.deepEqual(source, before); assert.equal({}.polluted, undefined);
});

function legacyScene(version) {
  const current = initialScene();
  const source = { version, seed: current.seed, width: current.width, planted: [rock()], removed: ["prop:jetty"],
    modified: [{ ...initialProps()[0], x: 740, y: 430, rotation: 12 }] };
  if (version >= 2) {
    source.assets = [pngAsset];
    source.planted.push({ ...rock("planted:picture"), kind: "image", assetId: pngAsset.id, ...imageObjectSize(pngAsset) });
  }
  if (version >= 3) {
    source.layers = current.layers.map(layer => ({ ...layer })); source.layers[2].name = "Мой передний план";
    source.planted[0].layerId = "foreground"; source.planted[0].name = "Мой камень"; source.planted[0].stackOrder = [700, 2, 1];
  }
  if (version >= 4) {
    source.folders = [{ id: "custom", name: "Наша папка", parentId: null, visible: true, locked: false },
      { id: "nested", name: "Вложенная папка", parentId: "custom", visible: true, locked: true }];
    source.planted[0].folderId = "nested";
    source.terrain = { baseTrails: false, cells: { "1:2": "sand", "20:30": "water", "99:99": "grass" } };
  }
  return source;
}

test("v1 through v4 migrate to disabled v5 lighting while retaining object edits, PNG bytes and authored scene data", () => {
  for (const version of [1, 2, 3, 4]) {
    const source = legacyScene(version), before = structuredClone(source), migrated = parseScene(JSON.stringify(source));
    assert.ok(migrated, `v${version} remains importable`); assert.equal(migrated.version, 5); assert.deepEqual(migrated.lighting, defaults);
    assert.deepEqual(migrated.planted, source.planted); assert.deepEqual(migrated.removed, source.removed); assert.deepEqual(migrated.modified, source.modified);
    assert.deepEqual(migrated.layers, source.layers ?? initialScene().layers);
    assert.deepEqual(migrated.folders, source.folders ?? initialScene().folders);
    assert.deepEqual(migrated.terrain, source.terrain ?? initialScene().terrain);
    if (version >= 2) {
      assert.deepEqual(migrated.assets, source.assets); assert.equal(migrated.assets[0].dataUrl, pngAsset.dataUrl);
      assert.deepEqual(Buffer.from(migrated.assets[0].dataUrl.split(",")[1], "base64"), pngBytes);
    } else assert.deepEqual(migrated.assets, []);
    assert.deepEqual(parseScene(serializeScene(migrated)), migrated);
    migrated.lighting.points.push(light());
    assert.deepEqual(parseScene(JSON.stringify(source)).lighting, defaults, "migrated lighting states are independently owned");
    assert.deepEqual(source, before);
  }
});

test("v1 migration still discards only retired stump houses and their edits", () => {
  const source = legacyScene(1), house = { ...rock("planted:house"), kind: "stump-house" };
  source.planted.push(house, { ...house, id: "planted:removed-house" });
  source.modified.push({ ...house, x: 550 }); source.removed.push("planted:removed-house");
  const migrated = validateScene(source);
  assert.ok(migrated); assert.equal(migrated.version, 5); assert.deepEqual(migrated.lighting, defaults);
  assert.deepEqual(migrated.planted, [source.planted[0]]); assert.deepEqual(migrated.modified, [source.modified[0]]); assert.deepEqual(migrated.removed, ["prop:jetty"]);
  assert.equal(source.planted.length, 3, "migration does not mutate the old save");
});

test("v4 moved overscan vegetation retains its exact edited anchors during migration to v5", () => {
  const source = legacyScene(4);
  const outside = forestObjects(source.seed, { x: 0, y: 0, width: source.width, height: WORLD_HEIGHT })
    .find(object => (object.x < 0 || object.y < 0 || object.x > source.width || object.y > WORLD_HEIGHT)
      && object.x > -OVERSCAN_EDIT_MARGIN + 5 && object.x < source.width + OVERSCAN_EDIT_MARGIN - 5
      && object.y > -OVERSCAN_EDIT_MARGIN + 5 && object.y < WORLD_HEIGHT + OVERSCAN_EDIT_MARGIN - 5);
  assert.ok(outside);
  const moved = { ...outside, rotation: 0, x: outside.x < 0 ? outside.x - 5 : outside.x > source.width ? outside.x + 5 : outside.x,
    y: outside.y < 0 ? outside.y - 5 : outside.y > WORLD_HEIGHT ? outside.y + 5 : outside.y,
    layerId: "background", folderId: "custom", name: "Край леса", stackOrder: [3, 1] };
  source.modified.push(moved);
  const migrated = validateScene(source);
  assert.ok(migrated); assert.deepEqual(migrated.modified[1], moved); assert.deepEqual(parseScene(serializeScene(migrated)), migrated);
  assert.equal(validateScene({ ...migrated, modified: [{ ...moved, x: -OVERSCAN_EDIT_MARGIN - 1 }] }), null);
  assert.equal(validateScene({ ...migrated, planted: [rock("planted:outside", { x: moved.x, y: moved.y })] }), null);
});

test("v5 requires lighting, rejects lighting in older schemas and refuses invalid point data without dropping existing assets", () => {
  const valid = { ...validateScene(legacyScene(4)), lighting: withPoint() };
  assert.deepEqual(parseScene(serializeScene(valid)), valid);
  const missing = { ...valid }; delete missing.lighting;
  assert.equal(validateScene(missing), null);
  assert.equal(validateScene({ ...valid, lighting: null }), null);
  assert.equal(validateScene({ ...valid, lighting: { ...valid.lighting, extra: true } }), null);
  assert.equal(validateScene({ ...valid, lighting: withPoint({ x: valid.width + 1 }) }), null);
  for (const version of [1, 2, 3, 4]) assert.equal(validateScene({ ...legacyScene(version), lighting: initialLighting() }), null);
  assert.equal(validateScene({ ...valid, version: 6 }), null);
  assert.deepEqual(valid.assets[0], pngAsset, "rejected scenes do not alter existing imported PNG records");
});

test("object shadow heights use per-kind defaults, scale uniformly and honour an explicit zero override", () => {
  const heights = { tree: 160, shrub: 44, rock: 24, ruins: 92, bridge: 20, jetty: 16, image: 140 };
  for (const [kind, nominal] of Object.entries(heights)) {
    const object = rock(`planted:${kind}`, { kind, scale: 1.75 });
    assert.equal(getObjectShadowHeight(object), nominal * 1.75);
    assert.equal(getObjectShadowHeight({ ...object, shadowHeight: 0 }), 0, `${kind} can stop casting an elevated shadow`);
    assert.equal(getObjectShadowHeight({ ...object, shadowHeight: 33.5 }), 33.5 * object.scale);
  }
});

test("shadowHeight is a bounded v5-only object field and is preserved on plants and generated overrides", () => {
  const scene = initialScene(); scene.planted.push(rock("planted:zero", { shadowHeight: 0 }), rock("planted:maximum", { shadowHeight: 480 }));
  scene.modified.push({ ...initialProps()[0], rotation: 0, shadowHeight: 137.5 });
  assert.deepEqual(validateScene(scene), scene); assert.deepEqual(parseScene(serializeScene(scene)), scene);
  for (const shadowHeight of [-.001, 480.001, NaN, Infinity, "140", null, true]) {
    assert.equal(validateScene({ ...scene, planted: [rock("planted:bad", { shadowHeight })] }), null);
    assert.equal(validateScene({ ...scene, modified: [{ ...scene.modified[0], shadowHeight }] }), null);
  }
  for (const version of [1, 2, 3, 4]) {
    const legacy = legacyScene(version); legacy.planted[0].shadowHeight = 0;
    assert.equal(validateScene(legacy), null, `v${version} rejects new object fields rather than silently stripping them`);
  }
});

test("scene cloning and history deeply isolate lights, retain zero height and avoid no-op undo entries", () => {
  const source = initialScene(); source.lighting = withPoint(); source.planted.push(rock("planted:zero", { shadowHeight: 0 }));
  const original = cloneScene(source), clone = cloneScene(source);
  assert.notEqual(clone.lighting, source.lighting); assert.notEqual(clone.lighting.points, source.lighting.points); assert.notEqual(clone.lighting.points[0], source.lighting.points[0]);
  const history = createSceneHistory(source);
  source.lighting.points[0].x = 10; source.lighting.ambient = .2;
  assert.deepEqual(history.getScene(), original);
  assert.equal(history.commit(cloneScene(original)), false); assert.equal(history.canUndo, false);
  const edited = history.getScene(); edited.lighting.points[0].x = 900; edited.lighting.sunAngle = 215; edited.planted[0].shadowHeight = 40;
  assert.equal(history.commit(edited), true);
  edited.lighting.points[0].name = "Внешняя мутация"; edited.lighting.points.push(light("light:2"));
  assert.equal(history.getScene().lighting.points.length, 1); assert.equal(history.getScene().lighting.points[0].name, "Фонарь");
  const undone = history.undo(); assert.deepEqual(undone, original); assert.equal(undone.planted[0].shadowHeight, 0);
  undone.lighting.points[0].intensity = 0;
  const redone = history.redo(); assert.equal(redone.lighting.points[0].intensity, .8); assert.equal(redone.lighting.points[0].x, 900); assert.equal(redone.planted[0].shadowHeight, 40);
  assert.equal(history.commit(cloneScene(redone)), false);
  const onlyHeight = history.getScene(); onlyHeight.planted[0].shadowHeight = 0;
  assert.equal(history.commit(onlyHeight), true, "a zero height edit is detected as a real command");
  assert.equal(history.undo().planted[0].shadowHeight, 40); assert.equal(history.redo().planted[0].shadowHeight, 0);
});

test("history detects each global lighting and individual point field change without serializing the scene", () => {
  const source = initialScene(); source.lighting = withPoint();
  const edits = { enabled: false, ambient: .6, ambientColor: "#99aabb", sunAngle: 20, sunElevation: 70,
    sunIntensity: 1.1, sunColor: "#eeffaa", shadowOpacity: .7, shadowSoftness: 20 };
  const pointEdits = { id: "light:renamed", name: "Лунный фонарь", x: 801, y: 601, radius: 400, intensity: 0, color: "#aaffee", enabled: false };
  const history = createSceneHistory(source), stringify = JSON.stringify;
  try {
    JSON.stringify = () => { throw new Error("history comparisons must not serialize the scene"); };
    for (const [field, value] of Object.entries(edits)) {
      const before = history.getScene(), after = history.getScene(); after.lighting[field] = value;
      assert.equal(history.commit(after), true, `global ${field} creates a command`); assert.deepEqual(history.undo(), before); assert.deepEqual(history.redo(), after);
      assert.equal(history.commit(cloneScene(after)), false);
    }
    for (const [field, value] of Object.entries(pointEdits)) {
      const before = history.getScene(), after = history.getScene(); after.lighting.points[0][field] = value;
      assert.equal(history.commit(after), true, `point ${field} creates a command`); assert.deepEqual(history.undo(), before); assert.deepEqual(history.redo(), after);
      assert.equal(history.commit(cloneScene(after)), false);
    }
    const before = history.getScene(), removed = history.getScene(); removed.lighting.points = [];
    assert.equal(history.commit(removed), true); assert.deepEqual(history.undo(), before); assert.deepEqual(history.redo(), removed);
  } finally { JSON.stringify = stringify; }
});

test("scene history isolates terrain appearance while equivalent explicit defaults remain a no-op", () => {
  const source = initialScene(), history = createSceneHistory(source);
  const explicitDefaults = history.getScene();
  explicitDefaults.terrain.appearance = { shoreStyle: "stone", shoreHeight: 12, blendWidth: 24, scatter: .55 };
  assert.equal(history.commit(explicitDefaults), false);
  const edited = history.getScene();
  edited.terrain.appearance = { shoreStyle: "natural", shoreHeight: 8, blendWidth: 32, scatter: .2 };
  assert.equal(history.commit(edited), true);
  const copy = cloneScene(edited); assert.notEqual(copy.terrain.appearance, edited.terrain.appearance);
  edited.terrain.appearance.scatter = 1;
  assert.equal(history.getScene().terrain.appearance.scatter, .2);
  assert.deepEqual(history.undo(), source);
  const redone = history.redo(); assert.equal(redone.terrain.appearance.scatter, .2);
  assert.equal(history.commit(cloneScene(redone)), false);
});
