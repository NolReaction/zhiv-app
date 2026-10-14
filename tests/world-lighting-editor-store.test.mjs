import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldLightingEditorStore } = await vite.ssrLoadModule("/features/world/dev/world-lighting-editor-store.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");

const caster = (id, when) => ({ id, points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }],
  baseHeight: 0, height: 20, opacity: 1, softness: 2, ...(when ? { when } : {}) });
const scene = () => ({ schemaVersion: 1, id: "editor-test", width: 100, height: 100, terrain: [], sites: [],
  focus: { x: 0, y: 0, width: 100, height: 100 }, shadowCasters: [caster("tree"), caster("house", { siteId: "home", level: 1 })] });
const patch = (original, entries) => JSON.stringify({ schemaVersion: 1, sceneId: original.id, casters: entries.map(([id, after]) => ({ id,
  before: structuredClone(original.shadowCasters.find(caster => caster.id === id)), after })) });
function browser(storage, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  try { return run(); } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
}
function memoryStorage() {
  const values = new Map(), writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); writes.push([key, value]); },
    removeItem: key => { values.delete(key); writes.push([key, null]); } };
}

test("initial snapshots detach and freeze authored casters; production store never mutates or accesses storage", () => {
  const original = scene(), store = createWorldLightingEditorStore(true, original), initial = store.getSnapshot();
  assert.equal(initial.enabled, false);
  assert.equal(store.getServerSnapshot(), initial);
  assert.equal(store.getSnapshot(), initial);
  original.shadowCasters[0].points[0].x = 999;
  assert.equal(initial.casters[0].points[0].x, 10);
  assert.throws(() => { initial.casters[0].points[0].x = 15; }, TypeError);
  assert.throws(() => { initial.casters[1].when.level = 2; }, TypeError);
  assert.throws(() => { initial.dirtyIds.push("tree"); }, TypeError);
  const clean = scene(), disabled = createWorldLightingEditorStore(false, clean), before = disabled.getSnapshot();
  const unsubscribe = disabled.subscribe(() => assert.fail("Production store notified a listener"));
  browser(new Proxy({}, { get() { assert.fail("Production accessed browser storage"); } }), () => {
    disabled.setEnabled(true); disabled.select("tree", 0); disabled.beginGesture();
    disabled.patchSelected({ height: 99 }); disabled.moveVertex(0, { x: 20, y: 20 });
    disabled.addVertex(0, { x: 20, y: 10 }); disabled.deleteVertex(0);
    disabled.commitGesture(); disabled.cancelGesture(); disabled.resetSelected(); disabled.resetAll(); disabled.undo(); disabled.redo(); disabled.hydrate();
    assert.equal(disabled.importPatch(patch(clean, [["tree", { ...clean.shadowCasters[0], height: 99 }]])), false);
  });
  assert.equal(disabled.getSnapshot(), before);
  assert.equal(disabled.getServerSnapshot(), before);
  assert.equal(disabled.applyToScene(clean), clean);
  assert.equal(disabled.exportPatch(), ""); unsubscribe(); unsubscribe();
});

test("drag changes update geometry immediately but collapse history and persistence into one commit", () => {
  const original = scene(), untouched = structuredClone(original), storage = memoryStorage();
  browser(storage, () => {
    const store = createWorldLightingEditorStore(true, original);
    store.select("tree", 0); const start = store.getSnapshot();
    store.beginGesture(); store.moveVertex(0, { x: 11, y: 11 }); store.moveVertex(0, { x: 12, y: 12 });
    assert.equal(store.getSnapshot().revision, 2);
    assert.equal(store.getSnapshot().canUndo, false);
    assert.equal(storage.writes.length, 0);
    store.commitGesture(); const committed = store.getSnapshot();
    assert.equal(committed.canUndo, true); assert.equal(storage.writes.length, 1);
    assert.equal(committed.revision, 2, "Committing a gesture does not invalidate geometry");
    store.undo();
    assert.deepEqual(store.getSnapshot().casters, start.casters);
    assert.equal(store.getSnapshot().canUndo, false);
    assert.equal(store.getSnapshot().canRedo, true);
    assert.equal(store.getSnapshot().revision, 3);
    assert.equal(storage.values.size, 0, "Returning to authoring baseline removes the draft");
    store.redo(); assert.deepEqual(store.getSnapshot().casters, committed.casters);
    assert.equal(store.getSnapshot().revision, 4);
    assert.equal(store.getSnapshot().canRedo, false);
    assert.equal(store.getServerSnapshot().revision, 0);
  });
  assert.deepEqual(original, untouched);
});

test("cancelled and zero net-change gestures preserve undo and saved draft", () => {
  const storage = memoryStorage();
  browser(storage, () => {
    const store = createWorldLightingEditorStore(true, scene()); store.select("tree");
    store.patchSelected({ height: 30 }); const committed = store.getSnapshot();
    const writes = storage.writes.length;
    store.beginGesture(); store.patchSelected({ height: 50 }); store.cancelGesture();
    assert.deepEqual(store.getSnapshot().casters, committed.casters);
    assert.equal(store.getSnapshot().canUndo, true);
    assert.equal(storage.writes.length, writes);
    store.beginGesture(); store.patchSelected({ height: 40 }); store.patchSelected({ height: 30 }); store.commitGesture();
    assert.equal(storage.writes.length, writes);
    store.undo(); assert.equal(store.getSnapshot().casters[0].height, 20);
    assert.equal(store.getSnapshot().canUndo, false, "Zero net-change gesture adds no undo entry");
    const revision = store.getSnapshot().revision;
    store.patchSelected({ height: 20 }); assert.equal(store.getSnapshot().revision, revision);
  });
});

test("invalid numeric and contour edits are atomic with visible errors", () => {
  const store = createWorldLightingEditorStore(true, scene()); store.select("tree", 0);
  const baseline = store.getSnapshot().casters, revision = store.getSnapshot().revision;
  const invalid = [
    () => store.patchSelected({ height: 0 }), () => store.patchSelected({ height: 301 }),
    () => store.patchSelected({ height: NaN }), () => store.patchSelected({ baseHeight: -1 }),
    () => store.patchSelected({ baseHeight: 390 }), () => store.patchSelected({ opacity: 1.01 }),
    () => store.patchSelected({ softness: 13 }), () => store.patchSelected({ id: "different" }),
    () => store.moveVertex(0, { x: Infinity, y: 0 }), () => store.moveVertex(0, { x: -1, y: 10 }),
    () => store.moveVertex(0, { x: 101, y: 10 }), () => store.moveVertex(0, { x: 30, y: 30 }),
    () => store.moveVertex(0, { x: 40, y: 20 }), () => store.moveVertex(8, { x: 12, y: 12 }),
    () => store.addVertex(0, { x: 30, y: 10 }), () => store.deleteVertex(-1),
  ];
  for (const edit of invalid) {
    edit(); const snapshot = store.getSnapshot();
    assert.equal(snapshot.casters, baseline); assert.equal(snapshot.revision, revision);
    assert.equal(snapshot.canUndo, false); assert.ok(snapshot.error);
  }
  store.patchSelected({ height: 300, baseHeight: 100, opacity: 0, softness: 12 });
  assert.equal(store.getSnapshot().error, null);
  assert.equal(store.getSnapshot().casters[0].baseHeight + store.getSnapshot().casters[0].height, 400);
});

test("contour insertion supports closing edges and deletion rejects an incomplete or degenerate polygon", () => {
  const store = createWorldLightingEditorStore(true, scene()); store.select("tree", 0);
  store.addVertex(3, { x: 10, y: 20 });
  assert.equal(store.getSnapshot().casters[0].points.length, 5);
  assert.deepEqual(store.getSnapshot().casters[0].points[4], { x: 10, y: 20 });
  store.undo(); assert.equal(store.getSnapshot().casters[0].points.length, 4);
  store.deleteVertex(0); const triangle = store.getSnapshot().casters;
  assert.equal(triangle[0].points.length, 3);
  store.deleteVertex(0); assert.equal(store.getSnapshot().casters, triangle);
  assert.match(store.getSnapshot().error, /3/);
  store.resetSelected(); assert.equal(store.getSnapshot().casters[0].points.length, 4);
  const original = scene(), ring = Array.from({ length: 64 }, (_, i) => ({ x: 50 + 20 * Math.cos(i / 64 * Math.PI * 2), y: 50 + 20 * Math.sin(i / 64 * Math.PI * 2) }));
  original.shadowCasters[0].points = ring;
  const many = createWorldLightingEditorStore(true, original); many.select("tree");
  const before = many.getSnapshot().casters;
  many.addVertex(0, { x: (ring[0].x + ring[1].x) / 2, y: (ring[0].y + ring[1].y) / 2 });
  assert.equal(many.getSnapshot().casters, before); assert.match(many.getSnapshot().error, /64/);
});

test("vertex insertion and deletion preserve selection identity; moving a vertex never changes the selected index", () => {
  const store = createWorldLightingEditorStore(true, scene()); store.select("tree", 2);
  store.moveVertex(0, { x: 11, y: 11 }); assert.equal(store.getSnapshot().selectedVertex, 2);
  store.addVertex(0, { x: 20, y: 10.5 }); assert.equal(store.getSnapshot().selectedVertex, 3);
  assert.deepEqual(store.getSnapshot().casters[0].points[3], { x: 30, y: 30 });
  store.deleteVertex(1); assert.equal(store.getSnapshot().selectedVertex, 2);
  store.deleteVertex(2); assert.equal(store.getSnapshot().selectedVertex, null);
});

test("export includes only dirty casters with exact baselines and unchanged level conditions", () => {
  const original = scene(), store = createWorldLightingEditorStore(true, original);
  store.select("house"); store.patchSelected({ baseHeight: 45, height: 40, opacity: .6, softness: 7 });
  const exported = JSON.parse(store.exportPatch());
  assert.equal(exported.schemaVersion, 3); assert.equal(exported.sceneId, original.id); assert.deepEqual(exported.lights, []);
  assert.equal(exported.casters.length, 1); assert.equal(exported.casters[0].id, "house");
  assert.deepEqual(exported.casters[0].before, original.shadowCasters[1]);
  assert.deepEqual(exported.casters[0].after.when, original.shadowCasters[1].when);
  assert.deepEqual(exported.casters[0].after, { ...original.shadowCasters[1], baseHeight: 45, height: 40, opacity: .6, softness: 7 });
  store.resetSelected(); assert.deepEqual(JSON.parse(store.exportPatch()).casters, []);
  store.undo(); assert.deepEqual(store.getSnapshot().dirtyIds, ["house"]);
  store.resetAll(); assert.deepEqual(store.getSnapshot().dirtyIds, []);
});

test("import validates every entry before applying and replaces the complete draft atomically", () => {
  const original = scene(), store = createWorldLightingEditorStore(true, original);
  store.select("tree"); store.patchSelected({ height: 25 }); const previous = store.getSnapshot().casters;
  const valid = JSON.parse(patch(original, [["tree", { ...original.shadowCasters[0], height: 40 }], ["house", { ...original.shadowCasters[1], height: 50 }]]));
  const mutate = callback => { const copy = structuredClone(valid); callback(copy); return JSON.stringify(copy); };
  const invalid = ["{", mutate(value => { value.sceneId = "other"; }), mutate(value => { value.extra = 1; }),
    mutate(value => { value.casters[1].id = "missing"; }), mutate(value => { value.casters.push(value.casters[0]); }),
    mutate(value => { value.casters[1].before.height++; }), mutate(value => { value.casters[1].after.id = "tree"; }),
    mutate(value => { value.casters[1].after.when.level = 2; }), mutate(value => { delete value.casters[1].after.when; }),
    mutate(value => { value.casters[1].after.points[0] = { x: 40, y: 20 }; }),
    mutate(value => { value.casters[1].after.points[0].x = 101; }), mutate(value => { value.casters[1].after.softness = 13; }),
    mutate(value => { value.casters[1].after.points[0].z = 1; }), mutate(value => { value.casters[1].before.when.other = "ignored?"; })];
  for (const text of invalid) {
    assert.equal(store.importPatch(text), false);
    assert.equal(store.getSnapshot().casters, previous, "Failed multi-object import leaves all edited casters untouched");
    assert.ok(store.getSnapshot().error);
  }
  assert.equal(store.importPatch(patch(original, [["house", { ...original.shadowCasters[1], height: 50 }]])), true);
  assert.equal(store.getSnapshot().casters[0].height, 20, "Unlisted earlier edits are replaced by the imported complete draft");
  assert.equal(store.getSnapshot().casters[1].height, 50);
  assert.deepEqual(store.getSnapshot().dirtyIds, ["house"]);
  store.undo(); assert.deepEqual(store.getSnapshot().casters, previous);
});

test("draft restore is explicit, validated and storage failures leave edit and export available", () => {
  const original = scene(), storage = memoryStorage();
  browser(storage, () => {
    const first = createWorldLightingEditorStore(true, original); first.select("tree"); first.patchSelected({ height: 80 });
    const second = createWorldLightingEditorStore(true, original);
    assert.equal(second.getSnapshot().casters[0].height, 20);
    second.hydrate(); assert.equal(second.getSnapshot().casters[0].height, 80);
    assert.equal(second.getSnapshot().canUndo, false); assert.equal(second.getSnapshot().enabled, false);
    second.hydrate(); assert.equal(second.getSnapshot().revision, 1);
    assert.equal(storage.writes.length, 1, "Restoration does not immediately overwrite storage");
    const changed = scene(); changed.shadowCasters[0].height = 21;
    const stale = createWorldLightingEditorStore(true, changed); stale.hydrate();
    assert.equal(stale.getSnapshot().casters[0].height, 21); assert.ok(stale.getSnapshot().error);
  });
  const denied = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("denied"); } };
  browser(denied, () => {
    const store = createWorldLightingEditorStore(true, original); store.hydrate(); assert.ok(store.getSnapshot().error);
    store.select("tree"); store.patchSelected({ height: 60 });
    assert.equal(store.getSnapshot().casters[0].height, 60); assert.ok(store.getSnapshot().error);
    assert.equal(JSON.parse(store.exportPatch()).casters[0].after.height, 60);
    store.undo(); assert.equal(store.getSnapshot().casters[0].height, 20);
  });
});

test("hydration discards exactly applied drafts while mismatched and corrupt drafts remain explicitly discardable", () => {
  const original = scene(), storage = memoryStorage();
  browser(storage, () => {
    const first = createWorldLightingEditorStore(true, original); first.select("tree"); first.patchSelected({ height: 80 });
    const authored = scene(); authored.shadowCasters[0].height = 80;
    const integrated = createWorldLightingEditorStore(true, authored); integrated.hydrate();
    assert.equal(integrated.getSnapshot().error, null); assert.equal(integrated.getSnapshot().revision, 0);
    assert.equal(storage.values.size, 0);
    first.patchSelected({ height: 90 });
    const mismatched = createWorldLightingEditorStore(true, authored); mismatched.hydrate();
    assert.ok(mismatched.getSnapshot().error); assert.equal(storage.values.size, 1);
    mismatched.resetAll(); assert.equal(storage.values.size, 0); assert.equal(mismatched.getSnapshot().error, null);
    storage.values.set("zhiv:world-lighting-editor:v1:editor-test", "bad-json");
    const corrupted = createWorldLightingEditorStore(true, original); corrupted.hydrate();
    assert.ok(corrupted.getSnapshot().error); assert.equal(storage.values.size, 1);
    corrupted.resetAll(); assert.equal(storage.values.size, 0);
  });
});

test("derived scene cache depends on source and geometry revision, never mode or selection", () => {
  const original = scene(), before = structuredClone(original), store = createWorldLightingEditorStore(true, original);
  assert.equal(store.applyToScene(original), original);
  store.select("tree"); store.patchSelected({ height: 40 });
  const effective = store.applyToScene(original), revision = store.getSnapshot().revision;
  assert.equal(effective.shadowCasters[0].height, 40);
  assert.equal(store.applyToScene(original), effective);
  store.setEnabled(true); store.select("house", 1); store.setEnabled(false);
  assert.equal(store.getSnapshot().revision, revision);
  assert.equal(store.applyToScene(original), effective);
  assert.ok(Object.isFrozen(effective)); assert.ok(Object.isFrozen(effective.shadowCasters));
  const otherSource = structuredClone(original); const otherEffective = store.applyToScene(otherSource);
  assert.notEqual(otherEffective, effective); assert.equal(store.applyToScene(otherSource), otherEffective);
  const activeScene = { ...original, shadowCasters: [original.shadowCasters[1]] };
  assert.equal(store.applyToScene(activeScene), activeScene, "Inactive building levels are not added to the preview");
  store.undo(); assert.equal(store.applyToScene(original), original);
  store.redo(); assert.notEqual(store.applyToScene(original), effective, "Undo and redo bump cache revision");
  assert.deepEqual(original, before); assert.deepEqual(otherSource, before);
});

test("all authored building levels remain editable and apply only to their active preview", () => {
  const original = structuredClone(TILED_WORLD), before = structuredClone(original);
  const store = createWorldLightingEditorStore(true, original);
  const authoredHouse = original.shadowCasters.filter(caster => caster.when?.siteId === "home");
  assert.equal(authoredHouse.length, 5);
  for (const caster of authoredHouse) {
    store.select(caster.id); store.patchSelected({ softness: caster.softness === 7 ? 6 : 7 });
    const preview = previewWorldScene(original, { home: caster.when.level });
    const effective = store.applyToScene(preview);
    assert.equal(effective.shadowCasters.filter(caster => caster.when?.siteId === "home").length, 1);
    assert.equal(effective.shadowCasters.find(candidate => candidate.id === caster.id).softness, caster.softness === 7 ? 6 : 7);
  }
  assert.equal(JSON.parse(store.exportPatch()).casters.length, 5);
  assert.deepEqual(original, before);
});

const lamp = (id = "home-lantern") => ({ id, position: { x: 40, y: 40 }, kind: "lantern", radius: 70, intensity: 1, color: "#ffd28a", flicker: .04 });
const litScene = () => ({ ...scene(), lights: [lamp()], shadowReceivers: [{ id: "ground", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], height: 0 }] });
const patchV2 = (original, casterEdits = [], lightEdits = []) => JSON.stringify({ schemaVersion: 2, sceneId: original.id,
  casters: casterEdits.map(([id, after]) => ({ id, before: structuredClone(original.shadowCasters.find(caster => caster.id === id)), after })),
  lights: lightEdits.map(([id, after, before]) => ({ id, before: before === undefined ? structuredClone(original.lights.find(light => light.id === id) ?? null) : before, after })) });

test("light authoring is immutable and validates the entire patch before changing a source", () => {
  const original = litScene(), untouched = structuredClone(original), store = createWorldLightingEditorStore(true, original);
  store.selectLight("home-lantern");
  assert.equal(store.getSnapshot().selectedKind, "light"); assert.equal(store.getSnapshot().selectedVertex, null);
  const before = store.getSnapshot().lights;
  for (const invalid of [{ height: 0 }, { height: 201 }, { radius: 0 }, { radius: 501 }, { intensity: NaN }, { intensity: 2.1 }, { flicker: -1 },
    { flicker: 1.1 }, { color: "red" }, { color: "#ffffffff" }, { enabled: 1 }, { manualPosition: "yes" }, { id: "changed" },
    { position: { x: -1, y: 10 } }, { position: { x: 101, y: 10 } }, { position: { x: 10, y: Infinity } }, { position: { x: 10, y: 10, z: 5 } }]) {
    store.patchLight(invalid); assert.equal(store.getSnapshot().lights, before); assert.ok(store.getSnapshot().error);
    assert.equal(store.getSnapshot().lightRevision, 0); assert.equal(store.getSnapshot().casterRevision, 0);
  }
  store.patchLight({ height: 200, radius: 500, intensity: 2, color: "#AABBC0", flicker: 1, enabled: false });
  assert.equal(store.getSnapshot().lights[0].color, "#aabbc0"); assert.equal(store.getSnapshot().error, null);
  assert.throws(() => { store.getSnapshot().lights[0].position.x = 0; }, TypeError);
  assert.deepEqual(original, untouched);
});

test("moving an attached baseline source writes manual bulb coordinates even when they equal its original position", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original); store.selectLight("home-lantern");
  store.patchLight({ position: { x: 40, y: 40 } });
  assert.equal(store.getSnapshot().lights[0].manualPosition, true);
  assert.equal(store.getSnapshot().lightRevision, 1); assert.equal(store.getSnapshot().casterRevision, 0);
  const revision = store.getSnapshot().revision; store.moveSelectedBy(0, 0); assert.equal(store.getSnapshot().revision, revision);
  store.resetSelected(); assert.deepEqual(store.getSnapshot().lights, original.lights);
  assert.deepEqual(JSON.parse(store.exportPatch()).lights, []);
});

test("baseline removal disables fallback IDs; independent custom lights can be created, duplicated and deleted", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original); store.selectLight("home-lantern"); store.removeLight();
  assert.equal(store.getSnapshot().lights.length, 1); assert.equal(store.getSnapshot().lights[0].enabled, false);
  assert.equal(store.applyToScene(original).lights[0].enabled, false);
  assert.deepEqual(JSON.parse(store.exportPatch()).lights[0].before, original.lights[0]);
  const id = store.addLight({ x: 20, y: 20 }, "torch"); assert.ok(id);
  assert.equal(store.getSnapshot().selectedId, id); assert.equal(store.getSnapshot().selectedKind, "light");
  const created = store.getSnapshot().lights.find(light => light.id === id);
  assert.equal(created.kind, "torch"); assert.equal(created.manualPosition, true); assert.equal(created.enabled, true);
  const duplicated = store.duplicateLight(); assert.notEqual(duplicated, id);
  assert.deepEqual(store.getSnapshot().lights.find(light => light.id === duplicated).position, { x: 30, y: 30 });
  store.removeLight(); assert.equal(store.getSnapshot().lights.some(light => light.id === duplicated), false);
  assert.equal(store.getSnapshot().selectedId, null); assert.equal(store.getSnapshot().dirtyLightIds.includes(duplicated), false);
  store.undo(); assert.ok(store.getSnapshot().lights.some(light => light.id === duplicated));
  store.selectLight(id); store.resetSelected(); assert.equal(store.getSnapshot().lights.some(light => light.id === id), false);
  store.resetAll(); assert.deepEqual(store.getSnapshot().lights, original.lights);
});

test("unified gestures and undo restore source and caster edits while only their respective revisions change", () => {
  const original = litScene(), storage = memoryStorage();
  browser(storage, () => {
    const store = createWorldLightingEditorStore(true, original); store.selectLight("home-lantern");
    store.beginGesture(); store.patchLight({ radius: 90 }); store.patchLight({ radius: 120 });
    assert.equal(store.isGesturing(), true); assert.equal(store.getSnapshot().casterRevision, 0); assert.equal(store.getSnapshot().lightRevision, 2);
    assert.equal(storage.writes.length, 0); store.commitGesture(); assert.equal(storage.writes.length, 1);
    store.select("tree"); store.patchSelected({ height: 60 });
    assert.equal(store.getSnapshot().casterRevision, 1); assert.equal(store.getSnapshot().lightRevision, 2);
    store.undo(); assert.equal(store.getSnapshot().casters[0].height, 20); assert.equal(store.getSnapshot().lights[0].radius, 120);
    assert.equal(store.getSnapshot().casterRevision, 2); assert.equal(store.getSnapshot().lightRevision, 2);
    store.undo(); assert.equal(store.getSnapshot().lights[0].radius, 70); assert.equal(store.getSnapshot().lightRevision, 3);
    assert.equal(store.getSnapshot().casterRevision, 2);
    store.redo(); store.selectLight("home-lantern"); store.beginGesture(); store.patchLight({ radius: 150 }); store.cancelGesture();
    assert.equal(store.getSnapshot().lights[0].radius, 120); assert.equal(store.isGesturing(), false);
  });
});

test("v2 source CRUD and caster edits import atomically with exact before baselines and one undo entry", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original), created = { ...lamp("custom-lamp"), height: 25, manualPosition: true };
  const good = JSON.parse(patchV2(original, [["tree", { ...original.shadowCasters[0], height: 50 }]], [
    ["home-lantern", { ...original.lights[0], intensity: .5 }], [created.id, created, null],
  ]));
  const before = store.getSnapshot();
  const mutate = callback => { const copy = structuredClone(good); callback(copy); return JSON.stringify(copy); };
  const invalid = [mutate(value => { value.lights[0].before.radius++; }), mutate(value => { value.lights[1].before = original.lights[0]; }),
    mutate(value => { value.lights[0].before = null; }), mutate(value => { value.lights[0].after.id = "changed"; }),
    mutate(value => { value.lights[1].after.radius = 501; }), mutate(value => { value.lights[1].after.position.x = -1; }),
    mutate(value => { value.lights[1].after.color = "bad"; }), mutate(value => { value.lights.push(value.lights[0]); }),
    mutate(value => { value.lights[1].before = null; value.lights[1].after = null; }), mutate(value => { value.lights[1].after.id = "bad\nname"; value.lights[1].id = "bad\nname"; }),
    mutate(value => { value.casters[0].before.height++; }), mutate(value => { value.lights[0].extra = 1; })];
  for (const text of invalid) {
    assert.equal(store.importPatch(text), false); assert.equal(store.getSnapshot().casters, before.casters); assert.equal(store.getSnapshot().lights, before.lights);
    assert.equal(store.getSnapshot().revision, 0); assert.ok(store.getSnapshot().error);
  }
  assert.equal(store.importPatch(JSON.stringify(good)), true);
  assert.equal(store.getSnapshot().casters[0].height, 50); assert.equal(store.getSnapshot().lights.length, 2);
  assert.equal(store.getSnapshot().casterRevision, 1); assert.equal(store.getSnapshot().lightRevision, 1); assert.equal(store.getSnapshot().revision, 1);
  const exported = JSON.parse(store.exportPatch()); assert.deepEqual(exported, { ...good, schemaVersion: 3, receivers: [] });
  store.undo(); assert.deepEqual(store.getSnapshot().casters, original.shadowCasters); assert.deepEqual(store.getSnapshot().lights, original.lights);
  assert.equal(store.getSnapshot().canUndo, false);
  assert.equal(store.importPatch(patchV2(original, [], [["home-lantern", null]])), true);
  assert.equal(store.getSnapshot().lights.length, 0); assert.deepEqual(store.getSnapshot().dirtyLightIds, ["home-lantern"]);
  assert.equal(store.applyToScene(original).lights.length, 0);
});

test("v1 files and old storage remain supported; new v3 drafts restore sources and discard exact applied creations", () => {
  const original = litScene(), oldText = patch(original, [["tree", { ...original.shadowCasters[0], height: 80 }]]), storage = memoryStorage();
  storage.values.set("zhiv:world-lighting-editor:v1:editor-test", oldText);
  browser(storage, () => {
    const legacy = createWorldLightingEditorStore(true, original); legacy.hydrate(); assert.equal(legacy.getSnapshot().casters[0].height, 80);
    assert.deepEqual(legacy.getSnapshot().lights, original.lights);
    const id = legacy.addLight({ x: 20, y: 20 }, "glow"); assert.ok(id);
    assert.equal(storage.values.has("zhiv:world-lighting-editor:v1:editor-test"), false);
    assert.equal(JSON.parse(storage.values.get("zhiv:world-lighting-editor:v3:editor-test")).schemaVersion, 3);
    const restored = createWorldLightingEditorStore(true, original); restored.hydrate();
    assert.equal(restored.getSnapshot().lights.length, 2); assert.equal(restored.getSnapshot().casters[0].height, 80);
    const integrated = structuredClone(original); integrated.shadowCasters[0].height = 80; integrated.lights.push(structuredClone(restored.getSnapshot().lights[1]));
    const afterApply = createWorldLightingEditorStore(true, integrated); afterApply.hydrate(); assert.equal(afterApply.getSnapshot().error, null);
    assert.equal(storage.values.size, 0); assert.equal(afterApply.getSnapshot().revision, 0);
    restored.importPatch(oldText); assert.deepEqual(restored.getSnapshot().lights, original.lights, "v1 import replaces the complete draft against authoring baseline");
  });
});

test("tools and snapping preserve contour shape, source limits and cache identities while A/B preserves drafts", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original); store.selectLight("home-lantern"); store.patchLight({ radius: 90 });
  const lightsOnly = store.applyToScene(original);
  assert.equal(lightsOnly.shadowCasters, original.shadowCasters); assert.equal(lightsOnly.shadowReceivers, original.shadowReceivers);
  store.setTool("move"); store.setSnap(5); store.setOverlay("selected"); store.setLightKind("glow");
  assert.equal(store.applyToScene(original), lightsOnly); assert.equal(store.getSnapshot().revision, 1);
  store.select("tree"); const distances = store.getSnapshot().casters[0].points.map(point => ({ x: point.x - 10, y: point.y - 10 }));
  store.moveSelectedBy(3, 8); const moved = store.getSnapshot().casters[0].points;
  assert.deepEqual(moved[0], { x: 15, y: 20 }); assert.deepEqual(moved.map(point => ({ x: point.x - 15, y: point.y - 20 })), distances);
  const previous = store.getSnapshot().casters; store.moveSelectedBy(-200, 0); assert.equal(store.getSnapshot().casters, previous);
  store.moveVertex(0, { x: 16, y: 21 }); assert.equal(store.getSnapshot().casters, previous, "A snapped no-op leaves revision unchanged");
  const edited = store.applyToScene(original), revision = store.getSnapshot().revision;
  store.setPreviewDraft(false); assert.equal(store.applyToScene(original), original);
  assert.equal(store.getSnapshot().casters[0].points[0].x, 15); assert.equal(store.getSnapshot().revision, revision);
  store.setPreviewDraft(true); assert.equal(store.applyToScene(original), edited);
  const id = store.addLight({ x: 23, y: 28 }, "glow"); assert.deepEqual(store.getSnapshot().lights.find(light => light.id === id).position, { x: 25, y: 30 });
  const beforeLight = store.getSnapshot().lights; store.moveSelectedBy(100, 0); assert.equal(store.getSnapshot().lights, beforeLight);
  const limited = litScene(); limited.lights = Array.from({ length: 128 }, (_, index) => lamp(`lamp-${index}`));
  const full = createWorldLightingEditorStore(true, limited); assert.equal(full.addLight({ x: 20, y: 20 }, "lantern"), null); assert.match(full.getSnapshot().error, /128/);
});

test("production studio adds no browser side effects or geometry changes through its extended API", () => {
  const original = litScene(), store = createWorldLightingEditorStore(false, original), before = store.getSnapshot();
  browser(new Proxy({}, { get() { assert.fail("Production studio accessed browser storage"); } }), () => {
    store.selectLight("home-lantern"); store.setTool("light"); store.setSnap(10); store.setOverlay("off"); store.setLightKind("torch"); store.setPreviewDraft(false);
    store.patchLight({ radius: 100 }); assert.equal(store.addLight({ x: 10, y: 10 }, "torch"), null); assert.equal(store.duplicateLight(), null);
    store.removeLight(); store.moveSelectedBy(10, 10); assert.equal(store.isGesturing(), false);
    assert.equal(store.importPatch(patchV2(original, [], [["home-lantern", null]])), false);
  });
  assert.equal(store.getSnapshot(), before); assert.equal(store.applyToScene(original), original);
});

test("source imports canonicalize hexadecimal color case consistently with Tiled patch application", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original);
  const edited = { ...original.lights[0], color: "#AABBC0" };
  const text = JSON.parse(patchV2(original, [], [["home-lantern", edited]]));
  text.lights[0].before.color = "#FFD28A";
  assert.equal(store.importPatch(JSON.stringify(text)), true);
  assert.equal(store.getSnapshot().lights[0].color, "#aabbc0");
  assert.equal(JSON.parse(store.exportPatch()).lights[0].after.color, "#aabbc0");
});

test("rendered light projections are immutable view metadata with stable scalar equality and no draft side effects", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original), storage = memoryStorage();
  browser(storage, () => {
    const before = store.getSnapshot(), exported = store.exportPatch(); let updates = 0;
    const unsubscribe = store.subscribe(() => updates++);
    const projection = { id: "home-lantern", position: { x: 61, y: 52 }, height: 36 };
    store.setLightProjections([projection, { id: "generated-lamp", position: { x: 0, y: 0 }, height: 10 }]);
    const projected = store.getSnapshot();
    assert.equal(updates, 1); assert.equal(projected.lightProjections.length, 1);
    assert.equal(projected.casters, before.casters); assert.equal(projected.lights, before.lights);
    assert.equal(projected.revision, before.revision); assert.equal(projected.casterRevision, before.casterRevision); assert.equal(projected.lightRevision, before.lightRevision);
    assert.equal(projected.canUndo, false); assert.equal(projected.canRedo, false); assert.equal(store.exportPatch(), exported);
    assert.equal(storage.writes.length, 0);
    projection.position.x = 10; assert.equal(projected.lightProjections[0].position.x, 61);
    assert.throws(() => { projected.lightProjections[0].position.x = 0; }, TypeError);
    assert.throws(() => { projected.lightProjections.push(projection); }, TypeError);
    store.setLightProjections([{ id: "home-lantern", position: { x: 61, y: 52 }, height: 36 }]);
    assert.equal(store.getSnapshot(), projected); assert.equal(updates, 1, "Repeated frame metadata cannot create a render loop");
    store.setLightProjections([{ id: "home-lantern", position: { x: 62, y: 52 }, height: 36 }]);
    assert.equal(updates, 2); assert.equal(store.getSnapshot().revision, 0); assert.equal(store.exportPatch(), exported);
    unsubscribe();
  });
});

test("projection publication ignores unknown IDs, invalid values and duplicate IDs and compares independently from order", () => {
  const original = litScene(); original.lights.push(lamp("second-lamp"));
  const store = createWorldLightingEditorStore(true, original);
  const one = { id: "home-lantern", position: { x: 41, y: 42 }, height: 30 }, two = { id: "second-lamp", position: { x: 51, y: 52 }, height: 40 };
  store.setLightProjections([one, two]); const before = store.getSnapshot();
  store.setLightProjections([two, one, { ...one, height: 99 }, { id: "missing", position: { x: 1, y: 1 }, height: 1 }]);
  assert.equal(store.getSnapshot(), before);
  store.setLightProjections([null, { ...one, height: NaN }, { ...two, position: { x: Infinity, y: 0 } }]);
  assert.deepEqual(store.getSnapshot().lightProjections, []);
  assert.equal(store.getSnapshot().error, null);
  const disabled = createWorldLightingEditorStore(false, original), initial = disabled.getSnapshot();
  disabled.setLightProjections(new Proxy([], { get() { assert.fail("Production inspected view metadata"); } }));
  assert.equal(disabled.getSnapshot(), initial);
});

test("bound source detach, duplication and first nudge preserve level-five effective position and solver height", () => {
  const original = structuredClone(TILED_WORLD), store = createWorldLightingEditorStore(true, original);
  const projection = { id: "home-lantern", position: { x: 664.0328111107732, y: 614.4593030767328 }, height: 31.366577727744925 };
  assert.notDeepEqual(projection.position, original.lights.find(light => light.id === projection.id).position);
  store.setLightProjections([projection]); store.selectLight(projection.id);
  const copyId = store.duplicateLight(), copy = store.getSnapshot().lights.find(light => light.id === copyId);
  assert.deepEqual(copy.position, { x: projection.position.x + 10, y: projection.position.y + 10 }); assert.equal(copy.height, projection.height);
  store.selectLight(projection.id); store.moveSelectedBy(1, -1);
  let detached = store.getSnapshot().lights.find(light => light.id === projection.id);
  assert.deepEqual(detached.position, { x: projection.position.x + 1, y: projection.position.y - 1 });
  assert.equal(detached.height, projection.height); assert.equal(detached.manualPosition, true);
  store.setLightProjections([{ ...projection, position: { x: 200, y: 200 }, height: 90 }]);
  store.moveSelectedBy(1, 1); detached = store.getSnapshot().lights.find(light => light.id === projection.id);
  assert.deepEqual(detached.position, { x: projection.position.x + 2, y: projection.position.y }); assert.equal(detached.height, projection.height);
  const manualCopyId = store.duplicateLight(), manualCopy = store.getSnapshot().lights.find(light => light.id === manualCopyId);
  assert.deepEqual(manualCopy.position, { x: detached.position.x + 10, y: detached.position.y + 10 }); assert.equal(manualCopy.height, detached.height);
  store.selectLight(projection.id); store.resetSelected(); store.setLightProjections([projection]);
  store.patchLight({ position: { x: projection.position.x + 3, y: projection.position.y } });
  assert.equal(store.getSnapshot().lights.find(light => light.id === projection.id).height, projection.height);
  store.resetSelected(); store.patchLight({ position: projection.position, height: 80 });
  assert.equal(store.getSnapshot().lights.find(light => light.id === projection.id).height, 80, "An explicitly edited height wins over view metadata");
});

test("total light edits remain CLI-compatible after deleting authored sources and creating their replacements", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original);
  assert.equal(store.importPatch(patchV2(original, [], [["home-lantern", null]])), true);
  for (let index = 0; index < 127; index++) assert.ok(store.addLight({ x: 20, y: 20 }, "lantern"));
  const before = store.getSnapshot(), patchText = store.exportPatch();
  assert.equal(before.lights.length, 127); assert.equal(before.dirtyLightIds.length, 128);
  assert.equal(store.addLight({ x: 30, y: 30 }, "lantern"), null);
  assert.equal(store.getSnapshot().lights, before.lights); assert.equal(store.getSnapshot().selectedId, before.selectedId);
  assert.equal(store.getSnapshot().revision, before.revision); assert.equal(store.getSnapshot().lightRevision, before.lightRevision);
  assert.equal(store.getSnapshot().canUndo, before.canUndo); assert.equal(store.exportPatch(), patchText);
  assert.match(store.getSnapshot().error, /128/);
  const selfImport = createWorldLightingEditorStore(true, original); assert.equal(selfImport.importPatch(patchText), true);
  const tooMany = JSON.parse(patchText); tooMany.lights.push({ id: "over-cap", before: null, after: lamp("over-cap") });
  assert.equal(selfImport.importPatch(JSON.stringify(tooMany)), false); assert.equal(JSON.parse(selfImport.exportPatch()).lights.length, 128);
});

test("import rejects all control characters forbidden by the CLI without changing draft geometry", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original), before = store.getSnapshot();
  for (const character of ["\u0000", "\u001f", "\u007f", "\u0080", "\u009f", "\u2028", "\u2029"]) {
    const id = `custom${character}lamp`;
    assert.equal(store.importPatch(patchV2(original, [], [[id, lamp(id), null]])), false);
    assert.equal(store.getSnapshot().lights, before.lights); assert.equal(store.getSnapshot().revision, 0);
  }
  const id = "Фонарь у воды"; assert.equal(store.importPatch(patchV2(original, [], [[id, lamp(id), null]])), true);
});

test("source changes reuse already edited caster geometry so the renderer can preserve its projection cache", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original);
  store.select("tree"); store.patchSelected({ height: 50 });
  const casterEdited = store.applyToScene(original), casterRevision = store.getSnapshot().casterRevision;
  assert.notEqual(casterEdited.shadowCasters, original.shadowCasters);
  store.selectLight("home-lantern"); store.patchLight({ radius: 90 });
  const lightEdited = store.applyToScene(original);
  assert.notEqual(lightEdited, casterEdited); assert.equal(lightEdited.shadowCasters, casterEdited.shadowCasters);
  assert.equal(lightEdited.shadowReceivers, original.shadowReceivers); assert.equal(store.getSnapshot().casterRevision, casterRevision);
  store.patchLight({ color: "#aaccee" });
  const recolored = store.applyToScene(original); assert.equal(recolored.shadowCasters, casterEdited.shadowCasters);
  store.undo(); assert.equal(store.applyToScene(original).shadowCasters, casterEdited.shadowCasters);
  store.select("tree"); store.patchSelected({ height: 60 });
  const changedAgain = store.applyToScene(original); assert.notEqual(changedAgain.shadowCasters, casterEdited.shadowCasters);
  assert.equal(changedAgain.shadowCasters[0].height, 60);
});

const patchV3 = (original, { casters = [], receivers = [], lights = [] } = {}) => JSON.stringify({ schemaVersion: 3, sceneId: original.id,
  casters: casters.map(([id, after, before]) => ({ id, before: before === undefined ? structuredClone(original.shadowCasters?.find(item => item.id === id) ?? null) : before, after })),
  receivers: receivers.map(([id, after, before]) => ({ id, before: before === undefined ? structuredClone(original.shadowReceivers?.find(item => item.id === id) ?? null) : before, after })),
  lights: lights.map(([id, after, before]) => ({ id, before: before === undefined ? structuredClone(original.lights?.find(item => item.id === id) ?? null) : before, after })) });
const receiver = (id = "surface") => ({ id, points: [{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }], height: 0 });

test("v3 caster and receiver CRUD is immutable, round trips atomically and shares undo history", () => {
  const original = litScene(), before = structuredClone(original), store = createWorldLightingEditorStore(true, original);
  store.select("tree"); store.removeSelected();
  assert.deepEqual(store.getSnapshot().deletedCasters.map(item => item.id), ["tree"]);
  assert.equal(store.getSnapshot().selectedId, null); assert.equal(store.applyToScene(original).shadowCasters.length, 1);
  store.selectReceiver("ground", 1); store.patchReceiver({ height: 20 });
  assert.equal(store.getSnapshot().selectedKind, "receiver"); assert.equal(store.getSnapshot().receiverRevision, 1);
  store.removeSelected(); assert.deepEqual(store.getSnapshot().deletedReceivers.map(item => item.id), ["ground"]);
  assert.deepEqual(store.applyToScene(original).shadowReceivers, []);
  const volume = store.addCaster({ x: 2, y: 99 }), surface = store.addReceiver({ x: 98, y: 1 });
  assert.ok(volume); assert.ok(surface); assert.equal(store.getSnapshot().selectedKind, "receiver");
  assert.equal(store.getSnapshot().receivers.find(item => item.id === surface).height, 0);
  const exported = JSON.parse(store.exportPatch());
  assert.equal(exported.schemaVersion, 3); assert.deepEqual(exported.casters.find(item => item.id === "tree").after, null);
  assert.equal(exported.casters.find(item => item.id === volume).before, null);
  assert.equal(exported.receivers.find(item => item.id === "ground").after, null);
  assert.equal(exported.receivers.find(item => item.id === surface).before, null);
  const restored = createWorldLightingEditorStore(true, original); assert.equal(restored.importPatch(JSON.stringify(exported)), true);
  assert.deepEqual(restored.getSnapshot().casters, store.getSnapshot().casters); assert.deepEqual(restored.getSnapshot().receivers, store.getSnapshot().receivers);
  restored.undo(); assert.deepEqual(restored.getSnapshot().casters, original.shadowCasters); assert.deepEqual(restored.getSnapshot().receivers, original.shadowReceivers);
  restored.redo(); assert.deepEqual(restored.getSnapshot().receivers, store.getSnapshot().receivers);
  store.undo(); assert.equal(store.getSnapshot().receivers.some(item => item.id === surface), false);
  store.redo(); store.selectReceiver(surface); store.resetSelected(); assert.equal(store.getSnapshot().receivers.length, 0);
  assert.equal(store.restoreElement("caster", "tree"), true); assert.equal(store.restoreElement("receiver", "ground"), true);
  assert.deepEqual(store.getSnapshot().deletedCasters, []); assert.deepEqual(store.getSnapshot().deletedReceivers, []);
  assert.deepEqual(store.getSnapshot().casters.slice(0, 2), original.shadowCasters, "Restored originals precede newly created volumes in authored order");
  assert.deepEqual(original, before); assert.throws(() => { store.getSnapshot().receivers[0].points[0].x = 9; }, TypeError);
});

test("receiver contours support snap, vertex gestures, height validation and source-independent geometry revision", () => {
  const original = litScene(); original.shadowReceivers = [receiver()];
  const storage = memoryStorage();
  browser(storage, () => {
    const store = createWorldLightingEditorStore(true, original); store.selectReceiver("surface", 2); store.setSnap(5);
    const baseline = store.getSnapshot(), originalVertex = baseline.receivers[0].points[2];
    store.beginGesture(); store.moveSelectedBy(3, 8); store.moveVertex(0, { x: 43, y: 48 });
    assert.equal(storage.writes.length, 0); assert.equal(store.getSnapshot().localSaveStatus, "pending");
    store.commitGesture(); assert.equal(storage.writes.length, 1); assert.equal(store.getSnapshot().localSaveStatus, "saved");
    assert.deepEqual(store.getSnapshot().receivers[0].points[0], { x: 45, y: 50 });
    assert.equal(store.getSnapshot().selectedVertex, 2); assert.deepEqual(store.getSnapshot().receivers[0].points[2], { x: originalVertex.x + 5, y: originalVertex.y + 10 });
    assert.equal(store.getSnapshot().casterRevision, 0); assert.equal(store.getSnapshot().lightRevision, 0);
    assert.equal(store.getSnapshot().geometryRevision, store.getSnapshot().receiverRevision);
    const moved = store.getSnapshot().receivers;
    for (const invalid of [{ height: -1 }, { height: 301 }, { height: NaN }, { opacity: 1 }, { id: "other" }]) {
      store.patchReceiver(invalid); assert.equal(store.getSnapshot().receivers, moved); assert.ok(store.getSnapshot().error);
    }
    store.patchReceiver({ height: 300 }); assert.equal(store.getSnapshot().receivers[0].height, 300);
    store.addVertex(0, { x: 55, y: 50 }); assert.equal(store.getSnapshot().selectedVertex, 3);
    store.deleteVertex(1); assert.equal(store.getSnapshot().selectedVertex, 2);
    store.undo(); assert.equal(store.getSnapshot().receivers[0].points.length, 5);
    store.selectLight("home-lantern"); const geometryRevision = store.getSnapshot().geometryRevision;
    store.patchLight({ radius: 90 }); assert.equal(store.getSnapshot().geometryRevision, geometryRevision);
    const rendered = store.applyToScene(original); store.patchLight({ radius: 100 });
    assert.equal(store.applyToScene(original).shadowReceivers, rendered.shadowReceivers);
    assert.equal(store.applyToScene(original).shadowCasters, original.shadowCasters);
  });
});

test("v3 rejects missing CRUD baselines, invalid geometry IDs, changed conditions and cross-kind creations atomically", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original);
  const good = JSON.parse(patchV3(original, { casters: [["tree", null], ["new-volume", caster("new-volume"), null]], receivers: [["surface", receiver(), null]], lights: [["new-lamp", lamp("new-lamp"), null]] }));
  const before = store.getSnapshot();
  const invalid = ["{", ...[
    value => { delete value.receivers; }, value => { delete value.casters[0].before; }, value => { delete value.receivers[0].after; },
    value => { value.casters[1].id = "Bad Name"; value.casters[1].after.id = "Bad Name"; },
    value => { value.casters[0].before.height++; }, value => { value.casters[0].before = null; },
    value => { value.receivers[0].after.height = 301; }, value => { value.receivers[0].after.points[0].x = -1; },
    value => { value.receivers[0].after.opacity = 1; }, value => { value.receivers[0].after.points[0] = value.receivers[0].after.points[2]; },
    value => { value.receivers.push(value.receivers[0]); }, value => { value.receivers[0].before = null; value.receivers[0].after = null; },
    value => { value.receivers[0].id = "new-volume"; value.receivers[0].after.id = "new-volume"; },
    value => { value.casters[1].after.when = { siteId: "unknown", level: 0 }; },
    value => { value.lights[0].id = "tree"; value.lights[0].after.id = "tree"; },
  ].map(mutate => { const copy = structuredClone(good); mutate(copy); return JSON.stringify(copy); })];
  for (const text of invalid) {
    assert.equal(store.importPatch(text), false); assert.equal(store.getSnapshot().casters, before.casters); assert.equal(store.getSnapshot().receivers, before.receivers);
    assert.equal(store.getSnapshot().lights, before.lights); assert.equal(store.getSnapshot().revision, 0);
  }
  const conditional = { ...original.shadowCasters[1], height: 50, when: { siteId: "home", level: 2 } };
  assert.equal(store.importPatch(patchV3(original, { casters: [["house", conditional]] })), false);
  assert.equal(store.importPatch(JSON.stringify(good)), true); assert.equal(store.getSnapshot().casters.length, 2);
});

test("v3 limits count deleted originals and additions as edits and restore cannot exceed a full map", () => {
  const original = litScene(); original.shadowReceivers = Array.from({ length: 32 }, (_, index) => receiver(`surface-${index}`));
  const store = createWorldLightingEditorStore(true, original);
  assert.equal(store.addReceiver({ x: 50, y: 50 }), null); assert.match(store.getSnapshot().error, /32/);
  store.selectReceiver("surface-0"); store.removeSelected();
  const id = store.addReceiver({ x: 50, y: 50 }); assert.ok(id);
  const full = store.getSnapshot(); assert.equal(full.receivers.length, 32); assert.equal(full.dirtyReceiverIds.length, 2);
  assert.equal(store.restoreElement("receiver", "surface-0"), false); assert.equal(store.getSnapshot().receivers, full.receivers);
  assert.equal(store.getSnapshot().selectedId, id); assert.match(store.getSnapshot().error, /32/);
  for (let index = 1; index < 31; index++) { store.selectReceiver(`surface-${index}`); store.patchReceiver({ height: 20 }); }
  assert.equal(store.getSnapshot().dirtyReceiverIds.length, 32);
  store.selectReceiver("surface-31"); const capped = store.getSnapshot(); store.patchReceiver({ height: 20 });
  assert.equal(store.getSnapshot().receivers, capped.receivers); assert.equal(store.getSnapshot().revision, capped.revision);
  assert.match(store.getSnapshot().error, /32/);
});

test("autosave reports pending gestures, recoverable storage failures and an explicit successful retry", () => {
  const storage = memoryStorage(); let quota = true;
  const guarded = { ...storage, setItem(key, value) { if (quota) throw new Error("quota"); storage.setItem(key, value); } };
  browser(guarded, () => {
    const store = createWorldLightingEditorStore(true, litScene()); store.select("tree"); store.patchSelected({ height: 50 });
    assert.equal(store.getSnapshot().localSaveStatus, "error"); assert.ok(store.getSnapshot().localSaveError); assert.equal(store.getSnapshot().localSavedAt, null);
    assert.equal(JSON.parse(store.exportPatch()).casters[0].after.height, 50);
    quota = false; assert.equal(store.retryLocalSave(), true);
    const saved = store.getSnapshot(); assert.equal(saved.localSaveStatus, "saved"); assert.ok(saved.localSavedAt > 0); assert.equal(saved.localSaveError, null);
    const writes = storage.writes.length;
    store.beginGesture(); store.patchSelected({ height: 60 }); assert.equal(store.getSnapshot().localSaveStatus, "pending");
    store.cancelGesture(); assert.equal(store.getSnapshot().localSaveStatus, "saved"); assert.equal(store.getSnapshot().localSavedAt, saved.localSavedAt);
    assert.equal(storage.writes.length, writes); assert.equal(store.getSnapshot().casters[0].height, 50);
    store.setOverlay("all"); store.setShowReceivers(true); store.setShowCasters(false); store.setShowWireframe(false);
    assert.equal(storage.writes.length, writes); assert.equal(store.getSnapshot().revision, saved.revision + 2);
    assert.equal(store.saveDraft(), true); assert.equal(JSON.parse(storage.values.get("zhiv:world-lighting-editor:v3:editor-test")).schemaVersion, 3);
  });
});

test("baseline acknowledgement preserves saved rendering, deletion, exact cache identities and undo", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original);
  store.select("tree"); store.removeSelected(); store.select("house"); store.patchSelected({ height: 55 });
  store.selectReceiver("ground"); store.removeSelected(); const surface = store.addReceiver({ x: 50, y: 50 }); const volume = store.addCaster({ x: 65, y: 65 });
  store.selectLight("home-lantern"); store.patchLight({ radius: 120 });
  const rendered = store.applyToScene(original), revision = store.getSnapshot().geometryRevision;
  const disk = { ...structuredClone(original), shadowCasters: structuredClone(store.getSnapshot().casters), shadowReceivers: structuredClone(store.getSnapshot().receivers), lights: structuredClone(store.getSnapshot().lights) };
  assert.equal(store.reconcileProjectBaseline(disk), true);
  assert.deepEqual(JSON.parse(store.exportPatch()).casters, []); assert.deepEqual(JSON.parse(store.exportPatch()).receivers, []); assert.deepEqual(JSON.parse(store.exportPatch()).lights, []);
  assert.equal(store.getSnapshot().geometryRevision, revision);
  const committed = store.applyToScene(original); assert.equal(committed, rendered, "Acknowledgement never reveals old bundled geometry before HMR");
  assert.equal(committed.shadowCasters.some(item => item.id === "tree"), false); assert.equal(committed.shadowCasters.some(item => item.id === volume), true);
  assert.equal(committed.shadowReceivers.some(item => item.id === "ground"), false); assert.equal(committed.shadowReceivers.some(item => item.id === surface), true);
  store.patchLight({ color: "#aabbcc" }); const recolored = store.applyToScene(original);
  assert.equal(recolored.shadowCasters, rendered.shadowCasters); assert.equal(recolored.shadowReceivers, rendered.shadowReceivers);
  store.undo(); assert.equal(store.getSnapshot().lights[0].color, disk.lights[0].color);
  store.undo(); assert.equal(store.getSnapshot().lights[0].radius, 70, "Undo remains available after disk acknowledgement");
  assert.equal(store.applyToScene(original).lights[0].radius, 70); assert.equal(JSON.parse(store.exportPatch()).lights[0].before.radius, 120);
});

test("Tiled floating point round trips clear baseline dirty IDs without normalizing current editable geometry", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original);
  store.select("tree"); store.moveVertex(0, { x: 10.123456789, y: 10.7654321 });
  store.selectReceiver("ground"); store.patchReceiver({ height: 5 });
  const current = store.getSnapshot(), disk = { ...structuredClone(original), shadowCasters: structuredClone(current.casters), shadowReceivers: structuredClone(current.receivers) };
  disk.shadowCasters[0].points[0].x += 1e-13; disk.shadowReceivers[0].points[0].x += 1e-13;
  assert.equal(store.reconcileProjectBaseline(disk), true); assert.deepEqual(store.getSnapshot().dirtyIds, []); assert.deepEqual(store.getSnapshot().dirtyReceiverIds, []);
  assert.equal(store.getSnapshot().casters, current.casters); assert.equal(store.getSnapshot().receivers, current.receivers);
  store.select("tree"); store.moveVertex(0, { x: current.casters[0].points[0].x + .001, y: current.casters[0].points[0].y });
  assert.deepEqual(store.getSnapshot().dirtyIds, ["tree"]);
});

test("complete backups remain useful after autosave ACK and restore all authored lighting against a different draft", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original);
  store.select("tree"); store.removeSelected(); store.selectReceiver("ground"); store.patchReceiver({ height: 30 });
  const volume = store.addCaster({ x: 50, y: 50 }); store.selectLight("home-lantern"); store.removeSelected();
  const disk = { ...structuredClone(original), shadowCasters: structuredClone(store.getSnapshot().casters), shadowReceivers: structuredClone(store.getSnapshot().receivers), lights: structuredClone(store.getSnapshot().lights) };
  store.reconcileProjectBaseline(disk);
  const backup = JSON.parse(store.exportSceneBackup()); assert.equal(backup.type, "world-studio-backup"); assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.casters.some(item => item.id === volume), true); assert.equal(backup.casters.some(item => item.id === "tree"), false);
  assert.equal(backup.receivers[0].height, 30); assert.equal(backup.lights[0].enabled, false); assert.deepEqual(JSON.parse(store.exportPatch()).casters, []);
  const restored = createWorldLightingEditorStore(true, original); restored.select("tree"); restored.patchSelected({ height: 90 });
  assert.equal(restored.importSceneBackup(JSON.stringify(backup)), true);
  assert.deepEqual(restored.getSnapshot().casters, store.getSnapshot().casters); assert.deepEqual(restored.getSnapshot().receivers, store.getSnapshot().receivers);
  assert.deepEqual(restored.getSnapshot().lights, store.getSnapshot().lights); restored.undo(); assert.equal(restored.getSnapshot().casters[0].height, 90);
  assert.equal(restored.importPatch(JSON.stringify(backup)), true, "Normal import detects full-backup discriminator");
  const before = restored.getSnapshot();
  for (const mutate of [value => { value.width++; }, value => { value.extra = true; }, value => { value.receivers[0].height = -1; }, value => { value.casters.push(value.casters[0]); },
    value => { value.casters[0].when.level++; }, value => { value.lights[0].radius = 501; }]) {
    const invalid = structuredClone(backup); mutate(invalid); assert.equal(restored.importSceneBackup(JSON.stringify(invalid)), false);
    assert.equal(restored.getSnapshot().casters, before.casters); assert.equal(restored.getSnapshot().receivers, before.receivers); assert.equal(restored.getSnapshot().lights, before.lights);
  }
});

test("stale unread drafts survive project connects and ordinary saves until explicit recovery or reset", () => {
  const original = litScene(), stale = patchV3(original, { casters: [["tree", { ...original.shadowCasters[0], height: 80 }]] }), storage = memoryStorage();
  const changed = structuredClone(original); changed.shadowCasters[0].height = 35;
  storage.values.set("zhiv:world-lighting-editor:v3:editor-test", stale);
  browser(storage, () => {
    const store = createWorldLightingEditorStore(true, changed); store.hydrate();
    assert.equal(store.hasHydrationConflict(), true); assert.equal(store.exportConflictedDraft(), stale); assert.equal(store.getSnapshot().localSaveStatus, "error");
    assert.equal(store.adoptProjectScene(changed), false); assert.equal(store.reconcileProjectBaseline(changed), false); assert.equal(store.saveDraft(), false);
    assert.equal(storage.values.get("zhiv:world-lighting-editor:v3:editor-test"), stale); assert.equal(store.restoreProjectDraft(changed), "conflict");
    assert.equal(store.getSnapshot().casters[0].height, 35); assert.equal(storage.values.get("zhiv:world-lighting-editor:v3:editor-test"), stale);
    assert.equal(store.restoreProjectDraft(original), "restored"); assert.equal(store.hasHydrationConflict(), false); assert.equal(store.getSnapshot().casters[0].height, 80);
    assert.equal(store.exportConflictedDraft(), null); assert.equal(store.getSnapshot().localSaveStatus, "saved");
    store.resetAll(); assert.equal(storage.values.size, 0);
    storage.values.set("zhiv:world-lighting-editor:v3:editor-test", "broken-json");
    const invalid = createWorldLightingEditorStore(true, original); invalid.hydrate(); assert.equal(invalid.hasHydrationConflict(), true);
    invalid.resetAll(); assert.equal(invalid.hasHydrationConflict(), false); assert.equal(storage.values.size, 0);
  });
});

test("new edits against an acknowledged project restore on reload even while the bundled world is stale", () => {
  const original = litScene(), storage = memoryStorage();
  browser(storage, () => {
    const first = createWorldLightingEditorStore(true, original); first.select("tree"); first.patchSelected({ height: 50 });
    const disk = { ...structuredClone(original), shadowCasters: structuredClone(first.getSnapshot().casters) };
    first.reconcileProjectBaseline(disk); first.patchSelected({ height: 70 });
    const raw = storage.values.get("zhiv:world-lighting-editor:v3:editor-test"); assert.equal(JSON.parse(raw).casters[0].before.height, 50);
    const restored = createWorldLightingEditorStore(true, original); restored.hydrate(); assert.equal(restored.hasHydrationConflict(), true);
    assert.equal(restored.restoreProjectDraft(disk), "restored"); assert.equal(restored.getSnapshot().casters[0].height, 70);
    assert.equal(restored.getSceneBaseline().shadowCasters[0].height, 50); assert.equal(restored.applyToScene(original).shadowCasters[0].height, 70);
    const integrated = { ...structuredClone(disk), shadowCasters: structuredClone(restored.getSnapshot().casters) };
    const applied = createWorldLightingEditorStore(true, original); applied.hydrate(); assert.equal(applied.restoreProjectDraft(integrated), "restored");
    assert.equal(applied.getSnapshot().casters[0].height, 70); assert.equal(storage.values.size, 0); assert.deepEqual(JSON.parse(applied.exportPatch()).casters, []);
  });
});

test("conditional new geometry follows exact requested levels without reintroducing inactive authored levels", () => {
  const original = litScene(); original.sites = [{ id: "home", initialLevel: 1, states: [{ level: 1 }, { level: 2 }] }];
  const store = createWorldLightingEditorStore(true, original), created = { ...caster("conditional-volume"), when: { siteId: "home", level: 2 } };
  assert.equal(store.importPatch(patchV3(original, { casters: [[created.id, created, null]] })), true);
  const emptyLevelScene = { ...original, shadowCasters: [original.shadowCasters[0]] };
  const inactive = store.applyToScene(emptyLevelScene, { home: 1 }); assert.equal(inactive.shadowCasters.some(item => item.id === created.id), false);
  const active = store.applyToScene(emptyLevelScene, { home: 2 }); assert.equal(active.shadowCasters.some(item => item.id === created.id), true);
  assert.equal(active.shadowCasters.some(item => item.id === "house"), false, "Absent authored conditional objects are not appended");
  assert.equal(store.applyToScene(emptyLevelScene, { home: 1 }), emptyLevelScene);
  assert.equal(store.applyToScene(original).shadowCasters.some(item => item.id === created.id), true, "Full raw authoring scene retains all new levels");
});

test("production extended v3 and backup APIs do not inspect input data, storage or update state", () => {
  const original = litScene(), store = createWorldLightingEditorStore(false, original), before = store.getSnapshot();
  const denied = new Proxy({}, { get() { assert.fail("Production inspected studio data"); } });
  browser(denied, () => {
    store.selectReceiver("ground"); store.patchReceiver(denied); store.setShowCasters(false); store.setShowReceivers(true); store.setShowWireframe(false);
    assert.equal(store.addCaster(denied), null); assert.equal(store.addReceiver(denied), null); store.removeSelected(); assert.equal(store.restoreElement("receiver", "ground"), false);
    assert.equal(store.saveDraft(), false); assert.equal(store.retryLocalSave(), false); assert.equal(store.importSceneBackup("bad"), false); assert.equal(store.exportSceneBackup(), "");
    assert.equal(store.adoptProjectScene(denied), false); assert.equal(store.reconcileProjectBaseline(denied), false); assert.equal(store.restoreProjectDraft(denied), "none");
  });
  assert.equal(store.getSnapshot(), before); assert.equal(store.applyToScene(original), original);
});

test("complete backups disable omitted authored lamps so automatic building lights cannot reappear", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original), backup = JSON.parse(store.exportSceneBackup());
  backup.lights = []; assert.equal(store.importSceneBackup(JSON.stringify(backup)), true);
  assert.equal(store.getSnapshot().lights.length, 1); assert.equal(store.getSnapshot().lights[0].enabled, false);
  const exported = JSON.parse(store.exportPatch()); assert.equal(exported.lights[0].after.enabled, false); assert.notEqual(exported.lights[0].after, null);
  assert.equal(store.applyToScene(original).lights[0].enabled, false);
});

test("project baseline methods preserve an in-progress gesture until the coordinator can acknowledge it safely", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original); store.select("tree"); store.patchSelected({ height: 50 });
  const acknowledged = { ...structuredClone(original), shadowCasters: structuredClone(store.getSnapshot().casters) };
  store.beginGesture(); store.patchSelected({ height: 70 }); const draft = store.getSnapshot();
  assert.equal(store.reconcileProjectBaseline(acknowledged), false); assert.equal(store.adoptProjectScene(acknowledged), false);
  assert.equal(store.isGesturing(), true); assert.equal(store.getSnapshot().casters, draft.casters); assert.equal(store.getSceneBaseline(), original);
  store.commitGesture(); assert.equal(store.reconcileProjectBaseline(acknowledged), true);
  assert.equal(store.getSnapshot().casters[0].height, 70); assert.equal(JSON.parse(store.exportPatch()).casters[0].before.height, 50);
  store.undo(); assert.equal(store.getSnapshot().casters[0].height, 50);
});

test("original comparison uses the last acknowledged project, including saved deletions before bundled-scene reload", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original);
  store.select("tree"); store.removeSelected(); store.selectReceiver("ground"); store.patchReceiver({ height: 25 });
  store.selectLight("home-lantern"); store.patchLight({ radius: 90 });
  const acknowledged = { ...structuredClone(original), shadowCasters: structuredClone(store.getSnapshot().casters), shadowReceivers: structuredClone(store.getSnapshot().receivers), lights: structuredClone(store.getSnapshot().lights) };
  store.reconcileProjectBaseline(acknowledged); store.selectReceiver("ground"); store.patchReceiver({ height: 35 });
  assert.equal(store.applyToScene(original).shadowReceivers[0].height, 35);
  store.setPreviewDraft(false); const saved = store.applyToScene(original);
  assert.equal(saved.shadowReceivers[0].height, 25); assert.equal(saved.shadowCasters.some(item => item.id === "tree"), false); assert.equal(saved.lights[0].radius, 90);
  assert.equal(store.applyToScene(original), saved); store.setPreviewDraft(true); assert.equal(store.applyToScene(original).shadowReceivers[0].height, 35);
  store.setPreviewDraft(false); assert.equal(store.applyToScene(original), saved);
});

test("backup tombstones count against the total light bound before any geometry is replaced", () => {
  const original = litScene(); original.lights = Array.from({ length: 128 }, (_, index) => ({ ...lamp(`original-${index}`), enabled: false }));
  const store = createWorldLightingEditorStore(true, original), before = store.getSnapshot(), backup = JSON.parse(store.exportSceneBackup());
  backup.lights = Array.from({ length: 128 }, (_, index) => lamp(`custom-${index}`));
  assert.equal(store.importSceneBackup(JSON.stringify(backup)), false);
  assert.equal(store.getSnapshot().casters, before.casters); assert.equal(store.getSnapshot().lights, before.lights); assert.equal(store.getSnapshot().revision, 0);
});

test("explicit project conflict resolution validates the fresh scene before discarding protected raw data or history", () => {
  const original = litScene(), storage = memoryStorage(), raw = "unreadable-old-draft";
  storage.values.set("zhiv:world-lighting-editor:v3:editor-test", raw);
  browser(storage, () => {
    const store = createWorldLightingEditorStore(true, original); store.hydrate(); store.select("tree"); store.patchSelected({ height: 60 });
    const before = store.getSnapshot(); assert.equal(store.hasHydrationConflict(), true); assert.equal(before.canUndo, true);
    const invalid = structuredClone(original); invalid.shadowReceivers[0].height = 301;
    assert.equal(store.adoptProjectScene(invalid, { discardConflictedDraft: true }), false);
    assert.equal(store.hasHydrationConflict(), true); assert.equal(store.exportConflictedDraft(), raw);
    assert.equal(storage.values.get("zhiv:world-lighting-editor:v3:editor-test"), raw);
    assert.equal(store.getSnapshot().casters, before.casters); assert.equal(store.getSnapshot().canUndo, true);
    store.beginGesture(); store.patchSelected({ height: 70 });
    assert.equal(store.adoptProjectScene(original, { discardConflictedDraft: true }), false);
    assert.equal(store.hasHydrationConflict(), true); assert.equal(store.isGesturing(), true); store.cancelGesture();
    const project = structuredClone(original); project.shadowCasters[0].height = 45;
    assert.equal(store.adoptProjectScene(project), false, "Ordinary connects keep the protected draft");
    assert.equal(store.adoptProjectScene(project, { discardConflictedDraft: true }), true);
    assert.equal(store.hasHydrationConflict(), false); assert.equal(store.exportConflictedDraft(), null);
    assert.equal(store.getSnapshot().casters[0].height, 45); assert.equal(store.getSnapshot().canUndo, false); assert.equal(store.getSnapshot().canRedo, false);
    assert.equal(store.getSnapshot().localSaveStatus, "saved"); assert.equal(storage.values.size, 0);
    assert.equal(store.applyToScene(original).shadowCasters[0].height, 45);
  });
});

test("DEV client module reevaluation preserves the exact editor session, subscribers, selection and undo", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), previousMode = process.env.NODE_ENV;
  const hot = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: memoryStorage() } });
  process.env.NODE_ENV = "development";
  try {
    const first = await hot.ssrLoadModule("/features/world/dev/world-lighting-editor-store.ts?studio-hmr=first"), editor = first.worldLightingEditorStore;
    const authored = editor.getSnapshot().casters[0]; editor.setEnabled(true); editor.select(authored.id, 0); editor.patchSelected({ softness: authored.softness === 7 ? 6 : 7 });
    const selected = editor.getSnapshot(); let updates = 0; const unsubscribe = editor.subscribe(() => updates++);
    const refreshed = await hot.ssrLoadModule("/features/world/dev/world-lighting-editor-store.ts?studio-hmr=second");
    assert.notEqual(refreshed.createWorldLightingEditorStore, first.createWorldLightingEditorStore, "This reevaluates the module rather than returning an SSR module cache hit");
    assert.equal(refreshed.worldLightingEditorStore, editor); assert.equal(refreshed.worldLightingEditorStore.getSnapshot(), selected);
    assert.equal(selected.selectedId, authored.id); assert.equal(selected.selectedVertex, 0); assert.equal(selected.canUndo, true); assert.equal(selected.enabled, true);
    refreshed.worldLightingEditorStore.undo(); assert.equal(updates > 0, true, "Existing subscriptions remain live");
    assert.equal(editor.getSnapshot().casters[0].softness, authored.softness); assert.equal(editor.getSnapshot().canRedo, true);
    refreshed.worldLightingEditorStore.redo(); assert.equal(editor.getSnapshot().casters[0].softness, selected.casters[0].softness); unsubscribe();
  } finally {
    await hot.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete globalThis.window;
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
  }
});

test("restoring a deleted authored lamp re-enables it after its disabled tombstone was acknowledged", () => {
  const original = litScene(), store = createWorldLightingEditorStore(true, original);
  store.selectLight("home-lantern"); store.removeSelected();
  const acknowledged = { ...structuredClone(original), lights: structuredClone(store.getSnapshot().lights) };
  assert.equal(store.reconcileProjectBaseline(acknowledged), true);
  assert.equal(store.getSnapshot().lights[0].enabled, false); assert.deepEqual(store.getSnapshot().dirtyLightIds, []);
  assert.equal(store.restoreElement("light", "home-lantern"), true);
  assert.equal(store.getSnapshot().lights[0].enabled, true); assert.equal(store.applyToScene(original).lights[0].enabled, true);
  const patch = JSON.parse(store.exportPatch()); assert.equal(patch.lights[0].before.enabled, false); assert.equal(patch.lights[0].after.enabled, true);
  store.undo(); assert.equal(store.getSnapshot().lights[0].enabled, false); store.redo(); assert.equal(store.getSnapshot().lights[0].enabled, true);
});
