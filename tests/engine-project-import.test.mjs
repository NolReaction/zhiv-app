import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { IDBFactory } from "fake-indexeddb";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { prepareProjectImport } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/project-import.ts");
const { createProjectDocument, parseProjectDocument, serializeProjectDocument } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/project-document.ts");
const { createIndexedDbProjectRepository, PROJECT_STORE, RESOURCE_STORE, METADATA_STORE } = await vite.ssrLoadModule("/apps/engine/src/editor/projects/project-repository.ts");
const { migrateLegacyLocalStorage } = await vite.ssrLoadModule("/apps/engine/src/editor/projects/legacy-migration.ts");
const { initialScene, serializeScene } = await vite.ssrLoadModule("/apps/engine/src/editor/scene/editor-scene.ts");

function chunk(type, payload) {
  const body = Buffer.concat([Buffer.from(type), payload]), result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length); body.copy(result, 4);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
}
function png(marker = 0, raster = Buffer.alloc(9, marker)) {
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  raster[0] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raster)), chunk("IEND", Buffer.alloc(0))]);
}
// JSON fingerprints verify byte identity, not the validity of chunks or the pixel stream.
function asset(bytes, name = "дом.png") {
  let first = 2166136261, second = 0x9e3779b9;
  for (const byte of bytes) { first = Math.imul(first ^ byte, 16777619) >>> 0; second = Math.imul(second ^ byte, 2246822519) >>> 0; }
  return { id: `png:${bytes.length.toString(16)}:${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`, name,
    dataUrl: "data:image/png;base64," + bytes.toString("base64"), width: 2, height: 1 };
}
function document(assets = [asset(png())]) {
  const source = createProjectDocument({ id: "project:source", name: "Точные PNG", presetId: "empty-v1" });
  source.assets = assets; return source;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("standalone import prepares exact PNG resources before returning a fresh independent project", async () => {
  const source = document(), before = serializeProjectDocument(source);
  const prepared = await prepareProjectImport(before);
  assert.notEqual(prepared.id, source.id);
  assert.deepEqual({ ...prepared, id: source.id }, source);
  assert.equal(serializeProjectDocument(source), before, "preparation leaves the currently supplied document untouched");
  const empty = await prepareProjectImport(serializeProjectDocument(document([])));
  assert.equal(empty.assets.length, 0, "projects without artwork need no canvas or browser image decoder");
});

test("valid header and recomputed fingerprint cannot import corrupt IEND or IDAT CRCs", async () => {
  const original = png();
  for (const index of [original.length - 1, 41 + original.readUInt32BE(33)]) {
    const damaged = Buffer.from(original); damaged[index] ^= 1;
    const json = serializeProjectDocument(document([asset(damaged)]));
    assert.ok(parseProjectDocument(json), "the metadata validator intentionally accepts this byte fingerprint");
    let activated = false;
    await assert.rejects(prepareProjectImport(json).then(() => { activated = true; }), /PNG.*контрольной суммы/);
    assert.equal(activated, false, "resource failure happens before the caller can activate or persist the project");
  }
});

test("complete pixel-stream verification rejects truncated raster even with valid chunk CRCs", async () => {
  const json = serializeProjectDocument(document([asset(png(0, Buffer.alloc(8)))]));
  assert.ok(parseProjectDocument(json));
  await assert.rejects(prepareProjectImport(json), /PNG.*неполные строки/);
});

test("imports verify one PNG at a time and cancelled preparation never returns an activatable project", async () => {
  const source = document([asset(png()), asset(png(1), "другой.png")]), first = deferred(), calls = [];
  let current = true, activated = false;
  const pending = prepareProjectImport(serializeProjectDocument(source), {
    isCurrent: () => current,
    assertAsset: async dataUrl => { calls.push(dataUrl); await first.promise; },
  }).then(() => { activated = true; });
  assert.equal(calls.length, 1, "a second decompression does not start while the first is pending");
  current = false; first.resolve();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls.length, 1); assert.equal(activated, false);
  await assert.rejects(prepareProjectImport("{broken", { assertAsset: async () => { throw new Error("not reached"); } }), /JSON проекта/);
});

test("legacy migration rejects corrupt PNG before committing its one-time marker and can retry the retained source", async t => {
  const factory = new IDBFactory(), databaseName = "legacy-png-verification";
  const repository = createIndexedDbProjectRepository({ indexedDB: factory, databaseName });
  t.after(() => repository.close());
  const valid = png(), damaged = Buffer.from(valid); damaged[damaged.length - 1] ^= 1;
  const legacy = initialScene(); legacy.assets = [asset(damaged)];
  let json = serializeScene(legacy);
  const storage = { getItem: () => json, removeItem: () => assert.fail("original JSON must be retained") };
  await assert.rejects(migrateLegacyLocalStorage(repository, storage), /PNG.*контрольной суммы/);
  assert.equal(json, serializeScene(legacy));
  await assert.rejects(repository.importLegacy(document([asset(damaged)]), "another-source"), /PNG.*контрольной суммы/);
  assert.deepEqual(await repository.list(), []);
  const readRequest = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const database = await readRequest(factory.open(databaseName));
  try {
    const stores = [PROJECT_STORE, RESOURCE_STORE, METADATA_STORE], transaction = database.transaction(stores);
    const contents = await Promise.all(stores.map(name => readRequest(transaction.objectStore(name).getAll())));
    assert.deepEqual(contents, [[], [], []], "no partial resource, manifest or marker can block a future valid migration");
  } finally { database.close(); }
  legacy.assets = [asset(valid)]; json = serializeScene(legacy);
  const restored = await migrateLegacyLocalStorage(repository, storage);
  assert.equal(restored.migrated, true); assert.equal(restored.document.assets[0].dataUrl, legacy.assets[0].dataUrl);
  assert.equal((await repository.list()).length, 1);
});
