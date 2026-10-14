import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldStudioProjectSave, createWorldStudioIncrementalPatch, createWorldStudioRequestId, retainWorldStudioProjectSave } = await vite.ssrLoadModule("/features/world/dev/world-studio-project-save.ts");
const { createWorldLightingEditorStore } = await vite.ssrLoadModule("/features/world/dev/world-lighting-editor-store.ts");
const clone = value => structuredClone(value);
const revision = number => number.toString(16).padStart(64, "0");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const scene = () => ({ schemaVersion: 1, id: "editor-test", width: 100, height: 100, sites: [], terrain: [],
  focus: { x: 0, y: 0, width: 100, height: 100 }, shadowCasters: [{ id: "tree", points: [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }],
    height: 20, baseHeight: 0, opacity: 1, softness: 2 }], shadowReceivers: [{ id: "ground", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], height: 0 }], lights: [] });
function editor(initial = scene()) {
  let baseline = clone(initial), current = { casters: clone(initial.shadowCasters), receivers: clone(initial.shadowReceivers), lights: clone(initial.lights) }, gesturing = false;
  const listeners = new Set(), history = [];
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    getSnapshot: () => current, getSceneBaseline: () => baseline, hydrate() {},
    hasHydrationConflict: () => false, restoreProjectDraft: () => "none",
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isGesturing: () => gesturing, saveDraft: () => true,
    reconcileProjectBaseline(value) { baseline = clone(value); emit(); return true; },
    adoptProjectScene(value) { baseline = clone(value); current = { casters: clone(value.shadowCasters), receivers: clone(value.shadowReceivers), lights: clone(value.lights) }; emit(); return true; },
    editHeight(height) { history.push(clone(current)); current = { ...current, casters: current.casters.map((item, index) => index === 0 ? { ...item, height } : item) }; emit(); },
    beginGesture() { gesturing = true; }, commitGesture() { gesturing = false; emit(); },
    undo() { current = history.pop(); emit(); },
    removeCaster() { history.push(clone(current)); current = { ...current, casters: [] }; emit(); },
    addLight() { current = { ...current, lights: [...current.lights, { id: "lamp", position: { x: 50, y: 50 }, height: 20, kind: "lantern", radius: 60, intensity: 1, color: "#ffd28a", flicker: 0 }] }; emit(); },
    removeLight() { current = { ...current, lights: [] }; emit(); },
  };
}
function server(initial = scene()) {
  let disk = { available: true, revision: revision(1), scene: clone(initial) }, sequence = 1;
  const requests = [], receipts = new Map();
  const fetcher = async (_url, options) => {
    if (options.method === "GET") return Response.json(clone(disk));
    const body = JSON.parse(options.body); requests.push(body);
    if (receipts.has(body.requestId)) return Response.json(receipts.get(body.requestId));
    if (body.expectedRevision !== disk.revision) return Response.json({ message: "Tiled changed externally" }, { status: 409 });
    for (const [property, edits] of [["shadowCasters", body.patch.casters], ["shadowReceivers", body.patch.receivers], ["lights", body.patch.lights]]) {
      const values = new Map(disk.scene[property].map(value => [value.id, value]));
      for (const change of edits) {
        assert.deepEqual(values.get(change.id) ?? null, change.before);
        if (change.after === null) values.delete(change.id); else values.set(change.id, change.after);
      }
      disk.scene[property] = [...values.values()];
    }
    disk.revision = revision(++sequence);
    receipts.set(body.requestId, clone(disk));
    return Response.json(clone(disk));
  };
  return { fetcher, requests, getDisk: () => clone(disk), externalEdit(height = 90) { disk.scene.shadowCasters[0].height = height; disk.revision = revision(++sequence); } };
}
function setup(t, options = {}) {
  const store = editor(), backend = server();
  let sequence = 0;
  const manager = createWorldStudioProjectSave({ editor: store, available: true, fetcher: backend.fetcher, debounceMs: 10,
    requestId: () => `request-${++sequence}`, ...options });
  t.after(() => manager.dispose());
  return { store, backend, manager };
}
async function browser(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window"), values = new Map();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
  } } });
  try { return await run(values); }
  finally { if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else delete globalThis.window; }
}

test("incremental patch supports light/receiver/caster creation and deletion independently", () => {
  const authored = scene();
  const patch = createWorldStudioIncrementalPatch(authored, { casters: [], receivers: authored.shadowReceivers, lights: [] });
  assert.equal(patch.schemaVersion, 3);
  assert.deepEqual(patch.casters, [{ id: "tree", before: authored.shadowCasters[0], after: null }]);
  assert.deepEqual(patch.receivers, []);
  assert.deepEqual(patch.lights, []);
});

test("confirmed project connection autosaves only committed gesture with debounce", async t => {
  const { store, backend, manager } = setup(t);
  await manager.connect();
  assert.equal(manager.getSnapshot().status, "ready");
  store.beginGesture(); store.editHeight(25); store.editHeight(27);
  await wait(30);
  assert.equal(backend.requests.length, 0);
  store.commitGesture();
  await wait(40);
  assert.equal(backend.requests.length, 1);
  assert.equal(backend.getDisk().scene.shadowCasters[0].height, 27);
  assert.equal(manager.getSnapshot().status, "saved");
  assert.equal(manager.getSnapshot().pending, false);
});

test("second edit, deletion and Undo save against acknowledged disk, never original page baseline", async t => {
  const { store, backend, manager } = setup(t);
  await manager.connect(); manager.setPaused(true);
  store.editHeight(30); await manager.requestSave();
  store.editHeight(40); await manager.requestSave();
  assert.equal(backend.requests[1].patch.casters[0].before.height, 30);
  store.undo(); await manager.requestSave();
  assert.equal(backend.requests[2].patch.casters[0].before.height, 40);
  assert.equal(backend.getDisk().scene.shadowCasters[0].height, 30);
  store.removeCaster(); await manager.requestSave();
  store.undo(); await manager.requestSave();
  assert.equal(backend.requests.at(-1).patch.casters[0].before, null);
  assert.equal(backend.getDisk().scene.shadowCasters[0].height, 30);
  store.addLight(); await manager.requestSave(); store.removeLight(); await manager.requestSave();
  assert.equal(backend.requests.at(-1).patch.lights[0].after, null);
  assert.equal(backend.getDisk().scene.lights.length, 0);
});

test("new edit made during request survives first ACK and is serialized into next save", async t => {
  const store = editor(), backend = server();
  let release, first = true;
  const fetcher = async (url, options) => {
    if (options.method === "POST" && first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return backend.fetcher(url, options);
  };
  const { manager } = setup(t, { editor: store, fetcher });
  await manager.connect(); manager.setPaused(true);
  store.editHeight(30); const saving = manager.requestSave();
  await wait(0); store.editHeight(50);
  release(); await saving;
  assert.equal(store.getSnapshot().casters[0].height, 50);
  assert.equal(manager.getSnapshot().pending, true);
  await manager.requestSave();
  assert.equal(backend.requests.length, 2);
  assert.equal(backend.requests[1].patch.casters[0].before.height, 30);
  assert.equal(backend.requests[1].patch.casters[0].after.height, 50);
});

test("lost acknowledgement retry retains exact request ID/body and newer draft", async t => {
  const store = editor(), backend = server();
  let lose = true;
  const fetcher = async (url, options) => {
    const result = await backend.fetcher(url, options);
    if (options.method === "POST" && lose) { lose = false; throw new Error("acknowledgement lost"); }
    return result;
  };
  const { manager } = setup(t, { editor: store, fetcher });
  await manager.connect(); manager.setPaused(true);
  store.editHeight(30); await manager.requestSave();
  assert.equal(manager.getSnapshot().status, "error");
  store.editHeight(45); await manager.retry();
  assert.deepEqual(backend.requests[1], backend.requests[0]);
  assert.equal(store.getSnapshot().casters[0].height, 45);
  assert.equal(manager.getSnapshot().pending, true);
  await manager.requestSave();
  assert.equal(backend.requests[2].patch.casters[0].before.height, 30);
  assert.equal(backend.getDisk().scene.shadowCasters[0].height, 45);
});

test("external modification pauses writes and retry preserves browser draft without replacing Tiled", async t => {
  const { store, backend, manager } = setup(t);
  await manager.connect(); manager.setPaused(true);
  store.editHeight(35); backend.externalEdit(); await manager.requestSave();
  assert.equal(manager.getSnapshot().status, "conflict");
  assert.equal(store.getSnapshot().casters[0].height, 35);
  assert.equal(backend.getDisk().scene.shadowCasters[0].height, 90);
  await manager.retry(); await manager.requestSave();
  assert.equal(manager.getSnapshot().status, "conflict");
  assert.equal(backend.requests.length, 1);
  assert.equal(store.getSnapshot().casters[0].height, 35);
});

test("unavailable hosted endpoint retains local draft and never sends project POST", async t => {
  const store = editor(), calls = [];
  const { manager } = setup(t, { editor: store, fetcher: async (_url, options) => { calls.push(options.method); return Response.json({ available: false }, { status: 404 }); } });
  store.editHeight(44); await manager.connect(); await manager.requestSave();
  assert.equal(manager.getSnapshot().status, "unavailable");
  assert.deepEqual(calls, ["GET"]);
  assert.equal(store.getSnapshot().casters[0].height, 44);
});

test("production coordinator never probes or edits store", async t => {
  let probes = 0;
  const manager = createWorldStudioProjectSave({ editor: new Proxy({}, { get() { assert.fail("production store accessed"); } }), available: false,
    fetcher: async () => { probes++; return Response.json({}); } });
  t.after(() => manager.dispose());
  await manager.connect(); await manager.requestSave(); await manager.retry();
  assert.equal(probes, 0); assert.equal(manager.getSnapshot().status, "unavailable");
});

test("compiler's rotated contour roundtrip noise does not cause repeated autonomous saves", async t => {
  const initial = scene();
  initial.shadowReceivers[0].holes = [[{ x: 50, y: 10 }, { x: 65, y: 10 }, { x: 65, y: 25 }]];
  const store = editor(initial), backend = server(initial);
  const fetcher = async (url, options) => {
    const response = await backend.fetcher(url, options), data = await response.json();
    if (options.method === "POST") {
      data.scene.shadowCasters[0].points[0].x += 1e-13;
      data.scene.shadowReceivers[0].points[0].x += 1e-13;
      data.scene.shadowReceivers[0].holes[0][1].y += 1e-13;
    }
    return Response.json(data);
  };
  const { manager } = setup(t, { editor: store, fetcher });
  await manager.connect(); store.editHeight(31);
  await wait(80);
  assert.equal(backend.requests.length, 1);
  assert.equal(manager.getSnapshot().pending, false);
  assert.equal(manager.getSnapshot().status, "saved");
});

test("receiver exclusion edits remain real patches while harmless coordinate noise does not create a save loop", () => {
  const initial = scene();
  initial.shadowReceivers[0].holes = [[{ x: 50, y: 10 }, { x: 65, y: 10 }, { x: 65, y: 25 }]];
  const current = { casters: clone(initial.shadowCasters), receivers: clone(initial.shadowReceivers), lights: [] };
  current.receivers[0].holes[0][0].x += 1e-13;
  assert.equal(createWorldStudioIncrementalPatch(initial, current).receivers.length, 0);
  current.receivers[0].holes[0][0].x += .01;
  const patch = createWorldStudioIncrementalPatch(initial, current);
  assert.equal(patch.receivers.length, 1);
  assert.deepEqual(patch.receivers[0].before.holes, initial.shadowReceivers[0].holes);
  assert.deepEqual(patch.receivers[0].after.holes, current.receivers[0].holes);
  current.receivers[0].holes = [];
  assert.equal(createWorldStudioIncrementalPatch(initial, current).receivers.length, 1);
});

test("a conflicting raw browser draft is never treated as an empty draft or overwritten", async t => {
  const store = editor(), backend = server();
  let adopted = 0, rebased = 0;
  store.hasHydrationConflict = () => true;
  store.restoreProjectDraft = () => "conflict";
  store.adoptProjectScene = () => { adopted++; return true; };
  store.reconcileProjectBaseline = () => { rebased++; return true; };
  const { manager } = setup(t, { editor: store, fetcher: backend.fetcher });
  await manager.connect(); await manager.requestSave();
  assert.equal(manager.getSnapshot().status, "conflict");
  assert.equal(adopted, 0); assert.equal(rebased, 0); assert.equal(backend.requests.length, 0);
});

test("HTTP LAN browsers lacking secure-context randomUUID can generate unique save IDs", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues(bytes) { bytes.fill(7); return bytes; } } });
  try { assert.match(createWorldStudioRequestId(), /^studio-(07){16}$/); }
  finally { if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor); else delete globalThis.crypto; }
});

test("request preparation failures show an error without losing draft or rejecting autosave", async t => {
  const { store, manager } = setup(t, { requestId() { throw new Error("id unavailable"); } });
  await manager.connect(); store.editHeight(39); await manager.requestSave();
  assert.equal(manager.getSnapshot().status, "error");
  assert.equal(manager.getSnapshot().error, "id unavailable");
  assert.equal(store.getSnapshot().casters[0].height, 39);
});

test("real store renders saved changes over an old bundle and saves Undo against disk", async t => browser(async () => {
  const source = scene(), store = createWorldLightingEditorStore(true, source), backend = server(source);
  const { manager } = setup(t, { editor: store, fetcher: backend.fetcher });
  await manager.connect(); manager.setPaused(true); store.setEnabled(true); store.select("tree");
  store.patchSelected({ height: 30 }); await manager.requestSave();
  assert.equal(store.getSnapshot().dirtyIds.length, 0);
  assert.equal(store.applyToScene(source).shadowCasters[0].height, 30);
  store.patchSelected({ height: 40 }); await manager.requestSave(); store.undo(); await manager.requestSave();
  assert.equal(backend.requests.at(-1).patch.casters[0].before.height, 40);
  assert.equal(backend.requests.at(-1).patch.casters[0].after.height, 30);
  assert.equal(store.applyToScene(source).shadowCasters[0].height, 30);
}));

test("reload with old bundle recovers a draft whose baseline is an earlier successful project save", async t => browser(async values => {
  const source = scene(), firstStore = createWorldLightingEditorStore(true, source), backend = server(source);
  const { manager: first } = setup(t, { editor: firstStore, fetcher: backend.fetcher });
  await first.connect(); first.setPaused(true); firstStore.select("tree"); firstStore.patchSelected({ height: 30 }); await first.requestSave();
  firstStore.patchSelected({ height: 45 }); first.dispose();
  const raw = [...values.values()][0]; assert.equal(JSON.parse(raw).casters[0].before.height, 30);
  const reloadedStore = createWorldLightingEditorStore(true, source);
  reloadedStore.hydrate(); assert.equal(reloadedStore.hasHydrationConflict(), true);
  const { manager: reloaded } = setup(t, { editor: reloadedStore, fetcher: backend.fetcher, requestId: () => "reload-0001" });
  reloaded.setPaused(true); await reloaded.connect();
  assert.equal(reloaded.getSnapshot().status, "ready"); assert.equal(reloadedStore.hasHydrationConflict(), false);
  assert.equal(reloadedStore.getSnapshot().casters[0].height, 45);
  await reloaded.requestSave(); assert.equal(backend.getDisk().scene.shadowCasters[0].height, 45);
}));

test("ACK arriving during a new real pointer gesture never commits or saves the pointer preview", async t => browser(async () => {
  const source = scene(), store = createWorldLightingEditorStore(true, source), backend = server(source);
  let release;
  const fetcher = async (url, options) => {
    if (options.method === "POST" && !release) await new Promise(resolve => { release = resolve; });
    return backend.fetcher(url, options);
  };
  const { manager } = setup(t, { editor: store, fetcher });
  await manager.connect(); manager.setPaused(true); store.select("tree"); store.patchSelected({ height: 30 });
  const saving = manager.requestSave(); await wait(0);
  store.beginGesture(); store.patchSelected({ height: 50 }); release(); await saving;
  assert.equal(store.isGesturing(), true);
  await manager.requestSave(); assert.equal(backend.requests.length, 1);
  store.commitGesture(); await manager.requestSave();
  assert.equal(backend.requests.length, 2);
  assert.equal(backend.requests[1].patch.casters[0].before.height, 30);
  assert.equal(backend.requests[1].patch.casters[0].after.height, 50);
}));

test("manual project-version choice resolves external conflict; ordinary retry never discards", async t => {
  const { store, backend, manager } = setup(t);
  await manager.connect(); manager.setPaused(true);
  store.editHeight(35); backend.externalEdit(); await manager.requestSave();
  await manager.retry(); assert.equal(store.getSnapshot().casters[0].height, 35);
  assert.equal(await manager.loadProjectVersion(), true);
  assert.equal(store.getSnapshot().casters[0].height, 90);
  assert.equal(manager.getSnapshot().status, "ready");
  assert.equal(manager.getSnapshot().pending, false);
  store.editHeight(95); await manager.requestSave();
  assert.equal(backend.requests.at(-1).patch.casters[0].before.height, 90);
  assert.equal(backend.getDisk().scene.shadowCasters[0].height, 95);
});

test("failed or invalid fresh GET preserves current draft and saved conflict data", async t => browser(async values => {
  const source = scene(), store = createWorldLightingEditorStore(true, source), backend = server(source);
  let invalid = false;
  const fetcher = async (url, options) => invalid ? Response.json({ available: true, revision: revision(5), scene: { ...source, width: 999 } }) : backend.fetcher(url, options);
  const { manager } = setup(t, { editor: store, fetcher });
  await manager.connect(); manager.setPaused(true); store.select("tree"); store.patchSelected({ height: 38 });
  const geometry = store.getSnapshot().casters, raw = [...values.values()][0]; invalid = true;
  assert.equal(await manager.loadProjectVersion(), false);
  assert.equal(store.getSnapshot().casters, geometry);
  assert.equal([...values.values()][0], raw);
  assert.equal(store.getSnapshot().canUndo, true);
}));

test("new edits made after manual choice but during fresh GET are preserved", async t => {
  const store = editor(), backend = server();
  let delay = false, release;
  const fetcher = async (url, options) => {
    if (options.method === "GET" && delay) await new Promise(resolve => { release = resolve; });
    return backend.fetcher(url, options);
  };
  const { manager } = setup(t, { editor: store, fetcher });
  await manager.connect(); manager.setPaused(true); store.editHeight(35); backend.externalEdit(); delay = true;
  const loading = manager.loadProjectVersion(); await wait(0); store.editHeight(55); release();
  assert.equal(await loading, false);
  assert.equal(store.getSnapshot().casters[0].height, 55);
  assert.equal(backend.getDisk().scene.shadowCasters[0].height, 90);
  assert.equal(manager.getSnapshot().status, "error");
});

test("explicit manual adoption can resolve protected raw hydration conflict only after valid GET", async t => browser(async values => {
  values.set("zhiv:world-lighting-editor:v3:editor-test", "unreadable protected draft");
  const source = scene(), store = createWorldLightingEditorStore(true, source), backend = server(source);
  const { manager } = setup(t, { editor: store, fetcher: backend.fetcher });
  await manager.connect(); assert.equal(manager.getSnapshot().status, "conflict");
  assert.equal(store.hasHydrationConflict(), true);
  assert.equal(await manager.loadProjectVersion(), true);
  assert.equal(store.hasHydrationConflict(), false);
  assert.equal(store.exportConflictedDraft(), null);
  assert.equal(manager.getSnapshot().status, "ready");
}));

test("retained HMR coordinator preserves saved revision, real Undo and a single editor subscription", async t => browser(async () => {
  const previousEnvironment = process.env.NODE_ENV; process.env.NODE_ENV = "development";
  try {
    const source = scene(), store = createWorldLightingEditorStore(true, source), backend = server(source);
    let subscriptions = 0, probes = 0;
    const subscribe = store.subscribe;
    store.subscribe = listener => { subscriptions++; const unsubscribe = subscribe(listener); return () => { subscriptions--; unsubscribe(); }; };
    const options = { editor: store, available: true, debounceMs: 10, requestId: () => "hmr-save-0001", fetcher: async (url, request) => {
      if (request.method === "GET") probes++; return backend.fetcher(url, request);
    } };
    const first = retainWorldStudioProjectSave(options); t.after(() => first.dispose());
    await first.connect(); first.setPaused(true); store.select("tree"); store.patchSelected({ height: 34 }); await first.requestSave();
    const saved = first.getSnapshot(), editorSaved = store.getSnapshot();
    const refreshed = retainWorldStudioProjectSave(options); await refreshed.recheck();
    assert.equal(refreshed, first); assert.equal(refreshed.getSnapshot(), saved);
    assert.equal(store.getSnapshot(), editorSaved); assert.equal(store.getSnapshot().canUndo, true);
    assert.equal(subscriptions, 1); assert.equal(probes, 2); assert.equal(backend.requests.length, 1);
    store.undo(); assert.equal(store.getSnapshot().casters[0].height, 20);
  } finally { if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment; }
}));

test("HMR recheck waits own in-flight ACK before comparing disk and never resets its history", async t => browser(async () => {
  const source = scene(), store = createWorldLightingEditorStore(true, source), backend = server(source);
  let release, probes = 0;
  const fetcher = async (url, request) => {
    if (request.method === "POST") await new Promise(resolve => { release = resolve; });
    else probes++;
    return backend.fetcher(url, request);
  };
  const { manager } = setup(t, { editor: store, fetcher });
  await manager.connect(); manager.setPaused(true); store.select("tree"); store.patchSelected({ height: 36 });
  const saving = manager.requestSave(); await wait(0); const checking = manager.recheck();
  await wait(0); assert.equal(probes, 1); release(); await saving; await checking;
  assert.equal(probes, 2); assert.equal(manager.getSnapshot().status, "saved");
  assert.equal(store.getSnapshot().canUndo, true); assert.equal(store.getSnapshot().casters[0].height, 36);
}));

test("clean external Tiled HMR follows validated disk without sending a POST", async t => {
  const { store, backend, manager } = setup(t);
  await manager.connect(); backend.externalEdit(); await manager.recheck();
  assert.equal(store.getSnapshot().casters[0].height, 90);
  assert.equal(manager.getSnapshot().revision, backend.getDisk().revision);
  assert.equal(manager.getSnapshot().status, "ready"); assert.equal(backend.requests.length, 0);
});

test("external Tiled HMR protects dirty drafts and active pointer previews instead of adopting or writing", async t => {
  const { store, backend, manager } = setup(t);
  await manager.connect(); manager.setPaused(true); store.editHeight(39); backend.externalEdit(); await manager.recheck();
  assert.equal(manager.getSnapshot().status, "conflict"); assert.equal(store.getSnapshot().casters[0].height, 39);
  assert.equal(backend.requests.length, 0);
  const secondStore = editor(), secondBackend = server();
  const { manager: second } = setup(t, { editor: secondStore, fetcher: secondBackend.fetcher });
  await second.connect(); secondStore.beginGesture(); secondBackend.externalEdit(); await second.recheck();
  assert.equal(second.getSnapshot().status, "conflict"); assert.equal(secondStore.isGesturing(), true);
  assert.equal(secondStore.getSnapshot().casters[0].height, 20);
});

test("disposing an obsolete coordinator prevents delayed POST ACK from patching its editor", async t => {
  const store = editor(), backend = server();
  let release, reconciles = 0;
  const reconcile = store.reconcileProjectBaseline;
  store.reconcileProjectBaseline = data => { reconciles++; return reconcile(data); };
  const fetcher = async (url, request) => {
    if (request.method === "POST") await new Promise(resolve => { release = resolve; });
    return backend.fetcher(url, request);
  };
  const { manager } = setup(t, { editor: store, fetcher });
  await manager.connect(); manager.setPaused(true); store.editHeight(30);
  const saving = manager.requestSave(); await wait(0); const count = reconciles; const snapshot = manager.getSnapshot();
  manager.dispose(); release(); await saving;
  assert.equal(reconciles, count); assert.equal(manager.getSnapshot(), snapshot);
  assert.equal(store.getSceneBaseline().shadowCasters[0].height, 20);
});

test("disposing before a delayed fresh GET prevents obsolete project adoption", async t => {
  const store = editor(), backend = server();
  let delay = false, release, adopts = 0;
  const adopt = store.adoptProjectScene;
  store.adoptProjectScene = data => { adopts++; return adopt(data); };
  const fetcher = async (url, request) => {
    if (request.method === "GET" && delay) await new Promise(resolve => { release = resolve; });
    return backend.fetcher(url, request);
  };
  const { manager } = setup(t, { editor: store, fetcher });
  await manager.connect(); backend.externalEdit(); delay = true;
  const checking = manager.recheck(); await wait(0); const count = adopts;
  manager.dispose(); release(); await checking;
  assert.equal(adopts, count); assert.equal(store.getSnapshot().casters[0].height, 20);
});

test("HMR recheck and manual project load serialize fresh GET/adopt in both start orders", async t => {
  for (const firstOperation of ["recheck", "loadProjectVersion"]) {
    const store = editor(), backend = server();
    let probes = 0, release;
    const fetcher = async (url, request) => {
      if (request.method !== "GET") return backend.fetcher(url, request);
      probes++;
      const captured = await (await backend.fetcher(url, request)).json();
      if (probes === 2) await new Promise(resolve => { release = resolve; });
      return Response.json(captured);
    };
    const { manager } = setup(t, { editor: store, fetcher });
    await manager.connect(); manager.setPaused(true); backend.externalEdit(80);
    const first = manager[firstOperation]();
    const second = manager[firstOperation === "recheck" ? "loadProjectVersion" : "recheck"]();
    await wait(0);
    assert.equal(probes, 2, `${firstOperation} must prevent a simultaneous competing GET`);
    backend.externalEdit(90);
    release(); await first; await second;
    assert.equal(probes, 3);
    assert.equal(manager.getSnapshot().revision, backend.getDisk().revision);
    assert.equal(store.getSceneBaseline().shadowCasters[0].height, backend.getDisk().scene.shadowCasters[0].height);
    assert.equal(backend.requests.length, 0);
  }
});
