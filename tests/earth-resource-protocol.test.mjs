import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { createEarthResourceCache } = await vite.ssrLoadModule("/features/earth/resource-cache.ts");
const { createEarthResourceProtocol } = await vite.ssrLoadModule("/features/earth/resource-protocol.ts");
const { createEarthRuntimeLoader, EARTH_RUNTIME_VERSION, EARTH_RUNTIME_DIRECTORY, EARTH_RUNTIME_MANIFEST_URL } = await vite.ssrLoadModule("/features/earth/runtime-loader.ts");
const { EARTH_TILE_BASE_LAYER } = await vite.ssrLoadModule("/features/earth/tile-base.ts");
after(() => vite.close());

const base = "https://tiles.openfreemap.org";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const request = (url, type = "arrayBuffer") => ({ url, type });
const cancelled = promise => assert.rejects(promise, { name: "AbortError" });
function fixture(fetcher, options = {}) {
  const cache = createEarthResourceCache({ cacheStorage: null, storageManager: null, origin: "https://zhiv.test", fetcher, attempts: 1, timeoutMs: 1000, ...options });
  const map = new AbortController();
  return { cache, map, protocol: createEarthResourceProtocol(cache.protocol, map.signal) };
}
function assertReleased(...controllers) {
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, "abort").length, 0);
}

test("removing a map cancels running and queued requests even when the SDK never aborts them", async () => {
  const fetched = [];
  const signals = [];
  const s = fixture((url, init) => {
    fetched.push(url); signals.push(init.signal);
    return fetched.length === 1 ? new Promise(() => {}) : Promise.resolve(new Response("fresh"));
  }, { concurrency: 1 });
  const oldSdk = new AbortController(), queuedSdk = new AbortController();
  const old = cancelled(s.protocol(request(`${base}/tile`, "string"), oldSdk));
  const queued = cancelled(s.protocol(request(`${base}/queued-old`, "string"), queuedSdk));
  await tick();
  assert.deepEqual(fetched, [`${base}/tile`]);
  assert.equal(s.cache.getSnapshot().pending, 2);
  s.map.abort();
  const nextMap = new AbortController();
  const nextProtocol = createEarthResourceProtocol(s.cache.protocol, nextMap.signal);
  const nextSdk = new AbortController();
  const next = nextProtocol(request(`${base}/tile`, "string"), nextSdk);
  await Promise.all([old, queued]);
  assert.equal((await next).data, "fresh");
  await tick();
  assert.equal(signals[0].aborted, true, "the old network slot is released immediately");
  assert.deepEqual(fetched, [`${base}/tile`, `${base}/tile`], "old queued requests never start");
  assert.equal(oldSdk.signal.aborted, false, "SDK cleanup is not required for map cancellation");
  assert.equal(queuedSdk.signal.aborted, false);
  assert.equal(s.cache.getSnapshot().pending, 0);
  assert.equal(s.cache.getSnapshot().failed, 0);
  assertReleased(s.map, oldSdk, queuedSdk, nextMap, nextSdk);
});

test("an SDK request cancellation leaves its map and another shared cache consumer alive", async () => {
  let finish, networkSignal, calls = 0;
  const s = fixture((_url, init) => { calls += 1; networkSignal = init.signal; return new Promise(resolve => { finish = resolve; }); });
  const first = new AbortController(), second = new AbortController();
  const removed = cancelled(s.protocol(request(`${base}/shared`, "string"), first));
  const retained = s.protocol(request(`${base}/shared`, "string"), second);
  await tick();
  first.abort();
  await removed;
  assert.equal(s.map.signal.aborted, false);
  assert.equal(networkSignal.aborted, false);
  finish(new Response("shared"));
  assert.equal((await retained).data, "shared");
  assert.equal(calls, 1);
  assert.equal(s.cache.getSnapshot().pending, 0);
  assertReleased(s.map, first, second);
});

test("map cancellation leaves a separate map's in-flight consumer usable", async () => {
  let finish, networkSignal;
  const s = fixture((_url, init) => { networkSignal = init.signal; return new Promise(resolve => { finish = resolve; }); });
  const otherMap = new AbortController(), otherSdk = new AbortController();
  const otherProtocol = createEarthResourceProtocol(s.cache.protocol, otherMap.signal);
  const firstSdk = new AbortController();
  const removed = cancelled(s.protocol(request(`${base}/shared`, "string"), firstSdk));
  const retained = otherProtocol(request(`${base}/shared`, "string"), otherSdk);
  await tick();
  s.map.abort();
  await removed;
  assert.equal(networkSignal.aborted, false);
  finish(new Response("other map"));
  assert.equal((await retained).data, "other map");
  assertReleased(s.map, firstSdk, otherMap, otherSdk);
});

test("already cancelled lifetimes never create cache work and settled failures release listeners", async () => {
  let calls = 0;
  const s = fixture(async () => { calls += 1; return new Response("unavailable", { status: 503 }); });
  const removed = new AbortController(); removed.abort();
  await cancelled(s.protocol(request(`${base}/already-removed`), removed));
  assert.equal(calls, 0);
  assert.equal(s.cache.getSnapshot().pending, 0);
  const failed = new AbortController();
  await assert.rejects(s.protocol(request(`${base}/failed`), failed), /HTTP 503/);
  assertReleased(s.map, removed, failed);
  s.map.abort();
  const late = new AbortController();
  await cancelled(s.protocol(request(`${base}/late`), late));
  assert.equal(calls, 1);
  assertReleased(s.map, late);
});

test("a synchronous progress observer can remove a map before network work starts", async () => {
  let calls = 0;
  const s = fixture(async () => { calls += 1; return new Response("unused"); });
  const stop = s.cache.subscribe(() => { if (s.cache.getSnapshot().pending > 0) s.map.abort(); });
  const sdk = new AbortController();
  await cancelled(s.protocol(request(`${base}/synchronous`), sdk));
  await tick();
  stop();
  assert.equal(calls, 0);
  assert.equal(s.cache.getSnapshot().pending, 0);
  assert.equal(s.cache.getSnapshot().failed, 0);
  assertReleased(s.map, sdk);
});

test("the protocol decorates only worker TileJSON/MVT copies and preserves cached provider bytes", async () => {
  const bytes = new Uint8Array([10, 1, 0]);
  const index = { tiles: [`${base}/planet/dated/{z}/{x}/{y}.pbf`], vector_layers: [{ id: "water" }], maxzoom: 14 };
  const s = fixture(async url => new Response(url.endsWith("/planet") ? JSON.stringify(index) : bytes));
  const indexUrl = s.cache.transformRequest(`${base}/planet`).url;
  const tileUrl = s.cache.transformRequest(`${base}/planet/dated/3/2/1.pbf`).url;
  const indexSdk = new AbortController(), tileSdk = new AbortController(), otherSdk = new AbortController();
  const prepared = await s.protocol(request(indexUrl, "json"), indexSdk);
  assert.ok(prepared.data.vector_layers.some(layer => layer.id === EARTH_TILE_BASE_LAYER));
  assert.deepEqual((await s.cache.readResource(indexUrl, "json")).data, index);
  const decorated = await s.protocol(request(tileUrl), tileSdk);
  assert.ok(decorated.data.byteLength > bytes.byteLength);
  assert.deepEqual([...new Uint8Array((await s.cache.readResource(tileUrl)).data)], [...bytes]);
  const untouched = await s.protocol(request(`${base}/fonts/font/0-255.pbf`), otherSdk);
  assert.deepEqual([...new Uint8Array(untouched.data)], [...bytes]);
  assertReleased(s.map, indexSdk, tileSdk, otherSdk);
});

test("removing a map cancels its protocol queue without cancelling the shared runtime installation", async () => {
  const encode = text => new TextEncoder().encode(text).buffer;
  const hash = data => createHash("sha256").update(new Uint8Array(data)).digest("hex");
  const assets = new Map([
    ["maplibre-gl.mjs", encode("sdk")], ["maplibre-gl-worker.mjs", encode("worker")],
    ["maplibre-gl-shared.mjs", new ArrayBuffer(0)], ["LICENSE.txt", encode("BSD")],
  ]);
  const manifest = { schemaVersion: 1, version: EARTH_RUNTIME_VERSION, files: [...assets].map(([name, data]) => ({ name, bytes: data.byteLength, sha256: hash(data) })) };
  let releaseManifest, manifestSignal, manifestReads = 0, imports = 0;
  const fetched = [];
  const s = fixture((url, init) => {
    fetched.push(url);
    if (url.endsWith("/manifest.json")) {
      manifestReads += 1; manifestSignal = init.signal;
      return new Promise(resolve => { releaseManifest = () => resolve(new Response(JSON.stringify(manifest))); });
    }
    return Promise.resolve(new Response(assets.get(url.split("/").at(-1))));
  }, { concurrency: 1 });
  const sdk = { getVersion: () => EARTH_RUNTIME_VERSION, setWorkerUrl() {}, setWorkerCount() {} };
  const loadRuntime = createEarthRuntimeLoader({
    cache: s.cache, sha256: async data => hash(data), importModule: async () => { imports += 1; return sdk; },
    createModuleUrl: () => "blob:runtime", revokeModuleUrl() {},
  });
  const firstRuntime = cancelled(loadRuntime({ signal: s.map.signal }));
  await tick();
  const oldSdk = new AbortController();
  const oldTile = cancelled(s.protocol(request(`${base}/old-tile`), oldSdk));
  await tick();
  s.map.abort();
  await Promise.all([firstRuntime, oldTile]);
  assert.equal(manifestSignal.aborted, false, "runtime requests are page-owned, not map-owned");
  const nextRuntime = loadRuntime();
  releaseManifest();
  assert.equal(await nextRuntime, sdk);
  assert.equal(await loadRuntime(), sdk);
  assert.equal(manifestReads, 1);
  assert.equal(imports, 1);
  assert.ok(fetched.includes(`https://zhiv.test${EARTH_RUNTIME_MANIFEST_URL}`));
  assert.ok(fetched.includes(`https://zhiv.test${EARTH_RUNTIME_DIRECTORY}/maplibre-gl-worker.mjs`));
  assert.ok(!fetched.includes(`${base}/old-tile`));
  assert.equal(s.cache.getSnapshot().pending, 0);
  assert.equal(s.cache.getSnapshot().failed, 0);
  assertReleased(s.map, oldSdk);
});
