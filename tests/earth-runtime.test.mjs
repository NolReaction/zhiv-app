import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { EARTH_RUNTIME_ASSET_VERSION } from "../scripts/prepare-earth-assets.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { createEarthRuntimeLoader, EARTH_RUNTIME_VERSION, EARTH_RUNTIME_DIRECTORY, EARTH_RUNTIME_MANIFEST_URL } = await vite.ssrLoadModule("/features/earth/runtime-loader.ts");
after(() => vite.close());

function hash(bytes) { return createHash("sha256").update(new Uint8Array(bytes)).digest("hex"); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { resolve, reject, promise };
}
function fixture(overrides = {}) {
  const bytes = new Map([
    ["maplibre-gl.mjs", new TextEncoder().encode("export const sdk = true;").buffer],
    ["maplibre-gl-worker.mjs", new TextEncoder().encode("export const worker = true;").buffer],
    ["maplibre-gl-shared.mjs", new ArrayBuffer(0)],
    ["LICENSE.txt", new TextEncoder().encode("BSD license").buffer],
  ]);
  const manifest = { schemaVersion: 1, version: EARTH_RUNTIME_VERSION, files: [...bytes].map(([name, data]) => ({ name, bytes: data.byteLength, sha256: hash(data) })) };
  const reads = [], invalidated = [], imported = [], created = [], revoked = [], configured = [], verified = [];
  const sdk = {
    getVersion: () => EARTH_RUNTIME_VERSION,
    setWorkerUrl: url => configured.push(["worker", url]),
    setWorkerCount: count => configured.push(["count", count]),
  };
  const cache = {
    async readResource(url, type) {
      reads.push([url, type]);
      return { data: url === EARTH_RUNTIME_MANIFEST_URL ? manifest : bytes.get(url.split("/").at(-1)) };
    },
    async invalidate(url) { invalidated.push(url); },
  };
  const dependencies = {
    cache,
    async sha256(data) { verified.push(data); return hash(data); },
    async importModule(url) { imported.push(url); return sdk; },
    createModuleUrl(data) { const url = `blob:earth-${created.length + 1}`; created.push({ url, data }); return url; },
    revokeModuleUrl(url) { revoked.push(url); },
    ...overrides,
  };
  return { load: createEarthRuntimeLoader(dependencies), dependencies, cache, sdk, bytes, manifest, reads, invalidated, imported, created, revoked, configured, verified };
}

test("the loader shares one verified installation, configures its persistent worker, and releases only the SDK Blob", async () => {
  assert.equal(EARTH_RUNTIME_VERSION, EARTH_RUNTIME_ASSET_VERSION);
  const s = fixture();
  const [first, second] = await Promise.all([s.load(), s.load()]);
  assert.equal(first, s.sdk); assert.equal(second, first);
  assert.equal(s.reads.length, 5, "manifest and all four files are installed exactly once");
  assert.equal(s.verified.length, 4);
  assert.deepEqual(s.imported, ["blob:earth-1"]);
  assert.deepEqual(s.configured, [["worker", "blob:earth-2"], ["count", 1]]);
  assert.deepEqual(s.revoked, ["blob:earth-1"]);
  assert.equal(await s.load(), first);
  assert.equal(s.reads.length, 5, "opening another map reuses the installed SDK and worker");
});

test("a corrupt file is invalidated and downloaded once before any executable Blob is created", async () => {
  const s = fixture();
  const original = s.cache.readResource;
  let corrupted = false;
  s.cache.readResource = async (url, type) => {
    const response = await original(url, type);
    if (url.endsWith("/maplibre-gl.mjs") && !corrupted) {
      corrupted = true;
      return { data: new Uint8Array(response.data.byteLength).buffer };
    }
    return response;
  };
  assert.equal(await s.load(), s.sdk);
  assert.deepEqual(s.invalidated, [`${EARTH_RUNTIME_DIRECTORY}/maplibre-gl.mjs`]);
  assert.equal(s.reads.filter(([url]) => url.endsWith("/maplibre-gl.mjs")).length, 2);
  assert.equal(s.imported.length, 1);
});

test("persistent corruption fails closed without executing a module, and a later retry can recover", async () => {
  const s = fixture();
  const correct = s.bytes.get("maplibre-gl.mjs");
  s.bytes.set("maplibre-gl.mjs", new ArrayBuffer(1));
  await assert.rejects(s.load(), /повреждены/);
  assert.equal(s.created.length, 0);
  assert.equal(s.imported.length, 0);
  assert.equal(s.invalidated.length, 2);
  s.bytes.set("maplibre-gl.mjs", correct);
  assert.equal(await s.load(), s.sdk);
});

test("an invalid or unparsable manifest is removed and read again, never allowing extra code URLs", async () => {
  for (const invalid of [null, { version: "7.0.0", files: [] }, { schemaVersion: 1, version: EARTH_RUNTIME_VERSION, files: [{ name: "../../other.mjs", bytes: 1, sha256: "f".repeat(64) }] }]) {
    const s = fixture();
    const original = s.cache.readResource;
    let first = true;
    s.cache.readResource = async (url, type) => {
      if (url === EARTH_RUNTIME_MANIFEST_URL && first) { first = false; return { data: invalid }; }
      return original(url, type);
    };
    assert.equal(await s.load(), s.sdk);
    assert.deepEqual(s.invalidated, [EARTH_RUNTIME_MANIFEST_URL]);
  }
  const s = fixture();
  const original = s.cache.readResource;
  let first = true;
  s.cache.readResource = async (url, type) => {
    if (url === EARTH_RUNTIME_MANIFEST_URL && first) { first = false; throw new SyntaxError("broken JSON"); }
    return original(url, type);
  };
  assert.equal(await s.load(), s.sdk);
  assert.deepEqual(s.invalidated, [EARTH_RUNTIME_MANIFEST_URL]);
});

test("manifest duplicates, excessive file sizes, missing files and invalid hashes cannot execute code", async () => {
  for (const mutate of [
    value => { value.files[1] = value.files[0]; },
    value => { value.files[0].bytes = 100 * 1024 * 1024; },
    value => { value.files.pop(); },
    value => { value.files[0].sha256 = "invalid"; },
    value => { value.files[0].bytes = 0; },
  ]) {
    const s = fixture(); mutate(s.manifest);
    await assert.rejects(s.load(), /проверить установку/);
    assert.equal(s.imported.length, 0);
    assert.equal(s.created.length, 0);
    assert.deepEqual(s.invalidated, [EARTH_RUNTIME_MANIFEST_URL, EARTH_RUNTIME_MANIFEST_URL]);
  }
});

test("cancelling one consumer leaves another installation active and cleans abort listeners", async () => {
  const gate = deferred();
  const s = fixture();
  const original = s.dependencies.importModule;
  s.dependencies.importModule = async url => { await gate.promise; return original(url); };
  const controller = new AbortController();
  const cancelled = s.load({ signal: controller.signal });
  const active = s.load();
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  gate.resolve();
  assert.equal(await active, s.sdk);
  assert.equal(s.imported.length, 1);
  assert.deepEqual(s.revoked, ["blob:earth-1"]);
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  await assert.rejects(s.load({ signal: alreadyCancelled.signal }), { name: "AbortError" });
});

test("module import and configuration failures release both Blobs and reset the singleton for retry", async () => {
  for (const configurationFailure of [false, true]) {
    const s = fixture();
    let first = true;
    const importer = s.dependencies.importModule;
    if (configurationFailure) {
      s.sdk.setWorkerCount = count => { if (first) { first = false; throw new Error("configuration failed"); } s.configured.push(["count", count]); };
    } else {
      s.dependencies.importModule = url => { if (first) { first = false; return Promise.reject(new Error("import failed")); } return importer(url); };
    }
    await assert.rejects(s.load(), /failed/);
    assert.deepEqual(s.revoked, ["blob:earth-1", "blob:earth-2"]);
    assert.equal(await s.load(), s.sdk);
    assert.deepEqual(s.revoked, ["blob:earth-1", "blob:earth-2", "blob:earth-3"]);
  }
});

test("insecure LAN browsers without WebCrypto use the pinned same-origin runtime without claiming a verified Blob install", async () => {
  const s = fixture({ sha256: null });
  assert.equal(await s.load(), s.sdk);
  assert.deepEqual(s.imported, [`${EARTH_RUNTIME_DIRECTORY}/maplibre-gl.mjs`]);
  assert.deepEqual(s.configured, [["worker", `${EARTH_RUNTIME_DIRECTORY}/maplibre-gl-worker.mjs`], ["count", 1]]);
  assert.equal(s.reads.length, 0);
  assert.equal(s.created.length, 0);
});
