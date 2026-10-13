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
  assert.equal(exported.schemaVersion, 1); assert.equal(exported.sceneId, original.id);
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
