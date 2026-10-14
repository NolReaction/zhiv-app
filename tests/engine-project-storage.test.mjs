import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createIndexedDbProjectRepository, PROJECT_STORE, RESOURCE_STORE, METADATA_STORE } = await vite.ssrLoadModule("/apps/engine/src/editor/projects/project-repository.ts");
const { createProjectSession } = await vite.ssrLoadModule("/apps/engine/src/editor/projects/project-session.ts");
const { migrateLegacyLocalStorage } = await vite.ssrLoadModule("/apps/engine/src/editor/projects/legacy-migration.ts");
const { createProjectDocument, serializeProjectDocument } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/project-document.ts");
const { initialScene, serializeScene, SCENE_STORAGE_KEY } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/editor-scene.ts");
const { readPngFile } = await vite.ssrLoadModule("/packages/engine/src/assets/image-assets.ts");

function pngFile(red = 30) {
  const chunk = (name, data) => {
    const type = Buffer.from(name), bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length); type.copy(bytes, 4); data.copy(bytes, 8);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) {
      crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return new File([Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, red, 100, 70, 210]))), chunk("IEND", Buffer.alloc(0))])], "original.png", { type: "image/png" });
}
function project(id = "project:first", name = "Первый") { return createProjectDocument({ id, name, presetId: "empty-v1", width: 600, height: 400 }); }
async function imageProject(id) {
  const document = project(id), asset = await readPngFile(pngFile());
  document.assets.push(asset);
  document.planted.push({ id: "placed:image", kind: "image", x: 100, y: 200, scale: 1, variant: 0, assetId: asset.id, imageWidth: 90, imageHeight: 90 });
  return document;
}
function createRepository(t, factory = new IDBFactory(), databaseName = `engine-test-${Math.random()}`) {
  let timestamp = 100;
  const repository = createIndexedDbProjectRepository({ indexedDB: factory, databaseName, now: () => ++timestamp, createId: () => "project:duplicate" });
  t.after(() => repository.close());
  return { repository, factory, databaseName };
}
function request(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function completed(transaction) { return new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error); }); }
async function inspect(factory, databaseName) {
  const database = await request(factory.open(databaseName));
  try {
    const transaction = database.transaction([PROJECT_STORE, RESOURCE_STORE, METADATA_STORE]), done = completed(transaction);
    const result = await Promise.all([request(transaction.objectStore(PROJECT_STORE).getAll()), request(transaction.objectStore(RESOURCE_STORE).getAll()), request(transaction.objectStore(METADATA_STORE).getAll()), done]);
    return { manifests: result[0], resources: result[1], markers: result[2].filter(record => record.key.startsWith("legacy:")), counters: result[2].filter(record => record.key.startsWith("revision:")) };
  } finally { database.close(); }
}
function patchPut(t, interceptor) {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) { return interceptor(this, () => original.apply(this, args), args[0]); };
  const restore = () => { IDBObjectStore.prototype.put = original; };
  t.after(restore); return restore;
}

test("IndexedDB separates PNG Blobs and manifests, restores exact portable bytes, and never rewrites PNG for coordinate/name edits", async t => {
  const { repository, factory, databaseName } = createRepository(t), document = await imageProject();
  let resourceWrites = 0;
  patchPut(t, (store, put) => { if (store.name === RESOURCE_STORE) resourceWrites++; return put(); });
  assert.equal((await repository.save(document)).revision, 1);
  let stored = await inspect(factory, databaseName);
  assert.equal(stored.manifests.length, 1); assert.equal(stored.resources.length, 1);
  assert.equal(stored.manifests[0].document.assets[0].dataUrl, undefined);
  assert.match(stored.manifests[0].document.assets[0].resourceKey, /^sha256:[a-f0-9]{64}$/);
  assert.ok(stored.resources[0].blob instanceof Blob);
  assert.deepEqual(await repository.load(document.id), document);
  assert.equal(serializeProjectDocument(await repository.load(document.id)), serializeProjectDocument(document));
  const edited = structuredClone(document); edited.planted[0].x = 210; edited.name = "Перемещённый дом"; edited.assets[0].name = "renamed.png";
  await repository.save(edited);
  assert.equal(resourceWrites, 1, "only the initial PNG import writes its binary Blob");
  assert.deepEqual(await repository.load(document.id), edited);
  stored = await inspect(factory, databaseName);
  assert.equal(stored.manifests[0].revision, 2);
  assert.equal(stored.resources.length, 1);
  assert.deepEqual(Buffer.from(await stored.resources[0].blob.arrayBuffer()), Buffer.from(await pngFile().arrayBuffer()));
});

test("duplicate shares content resources and deleting one project keeps PNG until the final reference is gone", async t => {
  const { repository, factory, databaseName } = createRepository(t), document = await imageProject();
  await repository.save(document);
  const duplicate = await repository.duplicate(document.id, "Копия сцены");
  assert.equal(duplicate.id, "project:duplicate"); assert.equal(duplicate.name, "Копия сцены");
  assert.equal((await inspect(factory, databaseName)).resources.length, 1);
  await repository.delete(document.id);
  assert.equal(await repository.load(document.id), null);
  assert.deepEqual(await repository.load(duplicate.id), duplicate);
  assert.equal((await inspect(factory, databaseName)).resources.length, 1);
  await repository.delete(duplicate.id);
  const empty = await inspect(factory, databaseName);
  assert.equal(empty.manifests.length, 0); assert.equal(empty.resources.length, 0);
});

test("repository snapshots at save invocation and close lets accepted queued writes commit before rejecting new work", async t => {
  const { repository, factory, databaseName } = createRepository(t), document = project();
  const saving = repository.save(document), closing = repository.close(); document.name = "Изменено вызывающим кодом";
  await saving; await closing;
  assert.equal((await inspect(factory, databaseName)).manifests[0].document.name, "Первый");
  await assert.rejects(repository.list(), /закрыто/);
});

test("a maximum-length project name remains duplicable with a valid bounded default copy name", async t => {
  const { repository } = createRepository(t), document = project("project:long-name", "Д".repeat(100));
  await repository.save(document); const duplicate = await repository.duplicate(document.id);
  assert.equal(duplicate.name.length, 100); assert.match(duplicate.name, / \(копия\)$/);
  assert.deepEqual(await repository.load(duplicate.id), duplicate);
});

test("an aborted resource transaction rolls back both a changed manifest and newly written binary bytes", async t => {
  const { repository, factory, databaseName } = createRepository(t), original = await imageProject();
  await repository.save(original);
  const changed = structuredClone(original), asset = await readPngFile(pngFile(80));
  changed.assets = [asset]; changed.planted[0].assetId = asset.id; changed.planted[0].x = 300;
  const restore = patchPut(t, (store, put) => {
    const result = put();
    if (store.name === RESOURCE_STORE) result.addEventListener("success", () => store.transaction.abort(), { once: true });
    return result;
  });
  await assert.rejects(repository.save(changed), /прервано|abort/i);
  restore();
  assert.deepEqual(await repository.load(original.id), original);
  const stored = await inspect(factory, databaseName);
  assert.equal(stored.manifests[0].revision, 1); assert.equal(stored.resources.length, 1);
  await repository.save(changed);
  assert.deepEqual(await repository.load(changed.id), changed);
  assert.equal((await inspect(factory, databaseName)).resources.length, 1, "old unreferenced resource is collected only on successful commit");
});

test("a synchronous quota failure in a Blob callback aborts the manifest and preserves the original project", async t => {
  const { repository, factory, databaseName } = createRepository(t), document = project();
  await repository.save(document);
  const changed = await imageProject(document.id);
  const restore = patchPut(t, (store, put) => { if (store.name === RESOURCE_STORE) throw new DOMException("Storage quota reached", "QuotaExceededError"); return put(); });
  await assert.rejects(repository.save(changed), { name: "QuotaExceededError" });
  restore();
  assert.deepEqual(await repository.load(document.id), document);
  assert.equal((await inspect(factory, databaseName)).resources.length, 0);
  await repository.save(changed); assert.deepEqual(await repository.load(document.id), changed);
});

test("two independent repositories reject stale cross-tab writes instead of silently overwriting a committed project", async t => {
  const factory = new IDBFactory(), name = "shared-database";
  const first = createRepository(t, factory, name).repository, second = createRepository(t, factory, name).repository;
  const document = project(); await first.save(document);
  const stale = await second.load(document.id);
  const changed = structuredClone(document); changed.name = "Изменён в первой вкладке"; await first.save(changed);
  stale.name = "Несохранённая вторая вкладка";
  await assert.rejects(second.save(stale), error => error.code === "PROJECT_CONFLICT");
  assert.equal(stale.name, "Несохранённая вторая вкладка", "the caller retains its exportable document");
  assert.deepEqual(await second.load(document.id), changed);
  stale.name = "После повторного открытия";
  await second.save(stale);
  assert.equal((await first.load(document.id)).name, stale.name);
});

test("a queued load cannot authorize a stale save that was submitted with the earlier revision", async t => {
  const factory = new IDBFactory(), name = "queued-load-conflict";
  const first = createRepository(t, factory, name).repository, second = createRepository(t, factory, name).repository;
  const document = project(); await first.save(document);
  const stale = await second.load(document.id);
  await first.save({ ...document, name: "Новое содержимое другой вкладки" });
  const [loaded, save] = await Promise.allSettled([second.load(document.id), second.save({ ...stale, name: "Старое редактирование в очереди" })]);
  assert.equal(loaded.status, "fulfilled"); assert.equal(save.status, "rejected"); assert.equal(save.reason.code, "PROJECT_CONFLICT");
  assert.equal((await first.load(document.id)).name, "Новое содержимое другой вкладки");
});

test("revision tombstones prevent a stale tab from overwriting a deleted and recreated project with the same ID", async t => {
  const factory = new IDBFactory(), name = "recreated-conflict";
  const first = createRepository(t, factory, name).repository, second = createRepository(t, factory, name).repository;
  const document = project(); await first.save(document); const stale = await second.load(document.id);
  await first.delete(document.id);
  const recreated = { ...document, name: "Новый экземпляр того же ID" };
  assert.equal((await first.save(recreated)).revision, 2);
  await assert.rejects(second.save({ ...stale, name: "Старые несохранённые правки" }), error => error.code === "PROJECT_CONFLICT");
  assert.deepEqual(await first.load(document.id), recreated);
});

test("a confirmed delete with a stale loaded or listed revision cannot remove newer content from another tab", async t => {
  const factory = new IDBFactory(), name = "delete-conflict";
  const first = createRepository(t, factory, name).repository, second = createRepository(t, factory, name).repository;
  const document = project(); const listed = await first.save(document); await second.load(document.id);
  const newest = { ...document, name: "Новое содержимое" }; await first.save(newest);
  await assert.rejects(second.delete(document.id), error => error.code === "PROJECT_CONFLICT");
  await assert.rejects(first.delete(document.id, listed.revision), error => error.code === "PROJECT_CONFLICT");
  assert.deepEqual(await first.load(document.id), newest);
});

test("corrupt resource references reject cleanly and content/identity corruption never loads as a valid image", async t => {
  const { repository, factory, databaseName } = createRepository(t), document = await imageProject(); await repository.save(document);
  const originalResourceKey = (await inspect(factory, databaseName)).resources[0].key;
  const database = await request(factory.open(databaseName)); t.after(() => database.close());
  let transaction = database.transaction(PROJECT_STORE, "readwrite"), done = completed(transaction);
  let manifest = await request(transaction.objectStore(PROJECT_STORE).get(document.id));
  manifest.document.assets[0].resourceKey = { invalid: true };
  transaction.objectStore(PROJECT_STORE).put(manifest); await done;
  await assert.rejects(repository.load(document.id), /Ссылка на ресурс/);
  manifest.document.assets[0].resourceKey = originalResourceKey;
  transaction = database.transaction([PROJECT_STORE, RESOURCE_STORE], "readwrite"); done = completed(transaction);
  transaction.objectStore(PROJECT_STORE).put(manifest);
  const resource = await request(transaction.objectStore(RESOURCE_STORE).get(manifest.document.assets[0].resourceKey));
  resource.contentId = "png:wrong"; transaction.objectStore(RESOURCE_STORE).put(resource); await done;
  await assert.rejects(repository.load(document.id), /повреждён/);
  const changed = structuredClone(document); changed.planted[0].x = 250;
  await assert.rejects(repository.save(changed), /Конфликт содержимого PNG/);
  assert.equal((await inspect(factory, databaseName)).manifests[0].document.planted[0].x, 100);
});

test("legacy migration retries after abort, retains source JSON and commits a single marker that survives deletion", async t => {
  const { repository, factory, databaseName } = createRepository(t), legacy = initialScene(); legacy.assets.push(await readPngFile(pngFile()));
  const json = serializeScene(legacy), storage = { getItem: key => { assert.equal(key, SCENE_STORAGE_KEY); return json; } };
  const restore = patchPut(t, (store, put) => {
    const result = put(); if (store.name === PROJECT_STORE) result.addEventListener("success", () => store.transaction.abort(), { once: true }); return result;
  });
  await assert.rejects(migrateLegacyLocalStorage(repository, storage)); restore();
  let stored = await inspect(factory, databaseName);
  assert.equal(stored.manifests.length, 0); assert.equal(stored.resources.length, 0); assert.equal(stored.markers.length, 0);
  const migrated = await migrateLegacyLocalStorage(repository, storage);
  assert.equal(migrated.migrated, true); assert.equal(migrated.document.version, 6);
  assert.equal(migrated.document.assets[0].dataUrl, legacy.assets[0].dataUrl);
  assert.equal(storage.getItem(SCENE_STORAGE_KEY), json);
  const repeated = await migrateLegacyLocalStorage(repository, storage);
  assert.equal(repeated.alreadyMigrated, true); assert.equal(repeated.document.id, migrated.document.id);
  stored = await inspect(factory, databaseName); assert.equal(stored.manifests.length, 1); assert.equal(stored.markers.length, 1);
  await repository.delete(migrated.document.id);
  const deleted = await migrateLegacyLocalStorage(repository, storage);
  assert.equal(deleted.document, null); assert.equal(deleted.alreadyMigrated, true);
  assert.equal((await repository.list()).length, 0);
});

test("concurrent legacy migrations in separate tabs atomically choose one project and one source marker", async t => {
  const factory = new IDBFactory(), name = "legacy-shared";
  const first = createRepository(t, factory, name).repository, second = createRepository(t, factory, name).repository;
  const [a, b] = await Promise.all([first.importLegacy(project("project:a"), "old-key"), second.importLegacy(project("project:b"), "old-key")]);
  assert.equal(a.document.id, b.document.id); assert.equal(Number(a.migrated) + Number(b.migrated), 1);
  assert.equal((await first.list()).length, 1);
});

test("unsupported storage, invalid projects and legacy read/parse failures reject without any destructive fallback", async t => {
  const unavailable = createIndexedDbProjectRepository({ indexedDB: null }); t.after(() => unavailable.close());
  await assert.rejects(unavailable.save(project()), /IndexedDB/);
  const { repository } = createRepository(t);
  await assert.rejects(repository.save({ ...project(), height: 0 }), /проверку/);
  await assert.rejects(migrateLegacyLocalStorage(repository, { getItem() { throw new Error("Storage denied"); } }), /Storage denied/);
  await assert.rejects(migrateLegacyLocalStorage(repository, { getItem: () => "{broken" }), /Старая сцена/);
  assert.equal((await repository.list()).length, 0);
  assert.deepEqual(await migrateLegacyLocalStorage(repository, { getItem: () => null }), { document: null, migrated: false, alreadyMigrated: false });
});

test("versionchange releases the old connection so another version can open without being blocked", async t => {
  const { repository, factory, databaseName } = createRepository(t);
  await repository.save(project());
  const opened = factory.open(databaseName, 2);
  opened.onblocked = () => assert.fail("repository must release its old connection on versionchange");
  const upgraded = await request(opened); upgraded.close();
  await assert.rejects(repository.list(), { name: "VersionError" });
});

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const microtasks = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function sessionHarness({ load } = {}) {
  const saves = [], callbacks = [], states = []; let closed = false;
  const repository = {
    save(document) { const gate = deferred(); saves.push({ document, ...gate }); return gate.promise; },
    load: load ?? (async id => project(id)), close: async () => { closed = true; },
  };
  const session = createProjectSession(repository, { onChange: state => states.push(state), scheduleSave(callback) { const entry = { callback, cancelled: false }; callbacks.push(entry); return () => { entry.cancelled = true; }; } });
  return { session, saves, states, callbacks, get closed() { return closed; } };
}

test("session coalesces queued revisions, snapshots writes and reports saved only after the latest revision commits", async () => {
  const harness = sessionHarness(), { session, saves, states, callbacks } = harness;
  const document = project(); await session.activate(document, { persisted: true });
  const first = structuredClone(document); first.name = "Первый жест"; session.update(first);
  const second = structuredClone(first); second.name = "Второй жест"; session.update(second);
  assert.equal(callbacks.length, 1);
  const flushing = session.flush(); assert.equal(saves.length, 1); assert.equal(saves[0].document.name, second.name);
  second.name = "Внешняя мутация"; assert.notEqual(saves[0].document.name, second.name);
  const latest = structuredClone(document); latest.name = "Третий жест во время сохранения"; session.update(latest);
  saves[0].resolve(); await microtasks();
  assert.equal(saves.length, 2); assert.equal(saves[1].document.name, latest.name);
  assert.equal(session.getState().savedRevision, 2); assert.equal(session.getState().revision, 3);
  assert.ok(!states.some(state => state.saveState === "saved" && state.savedRevision < state.revision));
  saves[1].resolve(); await flushing;
  assert.equal(session.getState().saveState, "saved"); assert.equal(session.getState().savedRevision, 3);
  await session.close(); assert.equal(harness.closed, true);
});

test("a rejected save prevents project switching, retains latest exportable edits, and can be explicitly retried", async () => {
  const { session, saves } = sessionHarness(), original = project(); await session.activate(original, { persisted: true });
  const changed = structuredClone(original); changed.name = "Несохранённые изменения"; session.update(changed);
  const switching = session.activate(project("project:other"), { persisted: true });
  saves[0].reject(new DOMException("Quota exceeded", "QuotaExceededError"));
  await assert.rejects(switching, { name: "QuotaExceededError" });
  assert.equal(session.getState().document.id, original.id); assert.equal(session.getState().document.name, changed.name);
  assert.equal(session.getState().saveState, "error"); assert.equal(session.getState().savedRevision, 0);
  const retry = session.retry(); saves[1].resolve(); await retry;
  await session.activate(project("project:other"), { persisted: true });
  assert.equal(session.getState().document.id, "project:other"); await session.close();
});

test("opening another project saves edits that finish while its async load is pending", async () => {
  const loaded = deferred(), { session, saves } = sessionHarness({ load: () => loaded.promise });
  const original = project(); await session.activate(original, { persisted: true });
  const opening = session.open("project:other"); await microtasks();
  const changed = structuredClone(original); changed.name = "Завершённый жест"; session.update(changed);
  loaded.resolve(project("project:other")); await microtasks();
  assert.equal(saves.length, 1); assert.equal(saves[0].document.id, original.id);
  assert.equal(session.getState().document.id, original.id);
  saves[0].resolve(); await opening;
  assert.equal(session.getState().document.id, "project:other"); assert.equal(session.getState().saveState, "saved"); await session.close();
});

test("opening the active project returns its latest saved document without installing a stale same-ID load", async () => {
  const initial = project(), changed = { ...initial, name: "Последняя правка активного проекта" };
  let stored = structuredClone(initial), revision = 1, loadCalls = 0, session;
  const repository = {
    getRevision: () => revision,
    save: async document => { stored = structuredClone(document); return { revision: ++revision }; },
    load: async () => {
      loadCalls++;
      const snapshot = structuredClone(stored);
      queueMicrotask(() => session.update({ ...initial, name: "Жест завершился во время загрузки" }));
      return snapshot;
    },
    close: async () => {},
  };
  session = createProjectSession(repository, { scheduleSave: () => () => {} });
  await session.activate(initial, { persisted: true }); session.update(changed);
  const opened = await session.open(initial.id);
  assert.equal(loadCalls, 0, "an already active project does not fetch and install an earlier storage snapshot");
  assert.deepEqual(opened, changed); assert.deepEqual(session.getState().document, stored);
  assert.equal(session.getState().saveState, "saved");
  opened.name = "Мутация результата"; assert.equal(session.getState().document.name, changed.name);
  await session.close();
});

test("closing during an active project transition waits for its final document to save before closing the repository", async () => {
  const loaded = deferred(), harness = sessionHarness({ load: () => loaded.promise }), { session, saves } = harness;
  await session.activate(project(), { persisted: true });
  const opening = session.open("project:other"), closing = session.close();
  assert.equal(harness.closed, false);
  loaded.resolve(project("project:other")); await opening; await closing;
  assert.equal(harness.closed, true); assert.equal(saves.length, 0);
  assert.throws(() => session.update(project("project:other")), /закрыта/);
});

test("new-project activation remains editable and exportable when persistence fails, with explicit error and no saved status", async () => {
  const { session, saves } = sessionHarness(); const document = project();
  await session.activate(document);
  assert.equal(session.getState().document.id, document.id); assert.equal(session.getState().saveState, "pending");
  const flush = session.flush(); saves[0].reject(new Error("Database denied")); await assert.rejects(flush, /Database denied/);
  assert.equal(session.getState().saveState, "error"); assert.equal(session.getState().document.id, document.id);
  assert.match(serializeProjectDocument(session.getState().document), /"version": 6/);
  const close = session.close(); await microtasks(); saves[1].resolve(); await close;
});

test("a session keeps its loaded revision token even if a separate load observes a newer same-ID document", async t => {
  const factory = new IDBFactory(), name = "session-revision";
  const first = createRepository(t, factory, name).repository, second = createRepository(t, factory, name).repository;
  const document = project(); await first.save(document);
  const initial = await second.load(document.id), session = createProjectSession(second, { scheduleSave: () => () => {} });
  await session.activate(initial, { persisted: true });
  await first.save({ ...document, name: "Другой автор сохранил" });
  await second.load(document.id);
  session.update({ ...initial, name: "Старый активный документ" });
  await assert.rejects(session.flush(), error => error.code === "PROJECT_CONFLICT");
  assert.equal(session.getState().document.name, "Старый активный документ"); assert.equal(session.getState().saveState, "error");
  assert.equal((await first.load(document.id)).name, "Другой автор сохранил");
});

test("explicit recovery replaces unsaved edits only after a verified load succeeds and retains them on a failed load", async () => {
  const original = project(), saved = { ...original, name: "Версия в хранилище" }, pending = deferred();
  const harness = sessionHarness({ load: () => pending.promise }), { session, saves } = harness;
  await session.activate(original, { persisted: true }); session.update({ ...original, name: "Несохранённая версия" });
  const restoring = session.reopenSaved(); pending.reject(new Error("Read denied")); await assert.rejects(restoring, /Read denied/);
  assert.equal(session.getState().document.name, "Несохранённая версия"); assert.equal(saves.length, 0);
  const recover = sessionHarness({ load: async () => saved });
  await recover.session.activate(original, { persisted: true }); recover.session.update({ ...original, name: "Несохранённая версия" });
  await recover.session.reopenSaved(); assert.equal(recover.session.getState().document.name, saved.name); assert.equal(recover.saves.length, 0);
  await recover.session.close();
});

test("recovery rejects if editing changes the active document while the saved version is loading", async () => {
  const pending = deferred(), { session, saves } = sessionHarness({ load: () => pending.promise }), original = project();
  await session.activate(original, { persisted: true }); session.update({ ...original, name: "До загрузки" });
  const restoring = session.reopenSaved(); await microtasks(); session.update({ ...original, name: "Жест во время загрузки" });
  pending.resolve({ ...original, name: "Внешнее сохранение" }); await assert.rejects(restoring, /изменилась во время загрузки/);
  assert.equal(session.getState().document.name, "Жест во время загрузки"); assert.equal(saves.length, 0);
});

test("an edit queued at the saved-notification microtask boundary remains scheduled after the old drain completes", async () => {
  const original = project(), latest = { ...original, name: "Микрозадача после сохранения" }, saves = [], scheduled = [];
  let session, queued = false;
  session = createProjectSession({ save(document) { const gate = deferred(); saves.push({ document, ...gate }); return gate.promise; }, close: async () => {} }, {
    onChange(state) {
      if (!queued && state.revision === 1 && state.saveState === "saved") {
        queued = true; queueMicrotask(() => session.update(latest));
      }
    },
    scheduleSave(callback) { scheduled.push(callback); return () => {}; },
  });
  await session.activate(original, { persisted: true }); session.update({ ...original, name: "Первое изменение" });
  const flushed = session.flush(); saves[0].resolve(); await flushed; await microtasks();
  assert.equal(session.getState().document.name, latest.name);
  assert.equal(session.getState().saveState, "pending"); assert.equal(scheduled.length, 2, "the microtask edit gets its own autosave schedule");
  scheduled[1](); await microtasks(); assert.equal(saves[1].document.name, latest.name);
  saves[1].resolve(); await microtasks(); assert.equal(session.getState().saveState, "saved"); await session.close();
});
