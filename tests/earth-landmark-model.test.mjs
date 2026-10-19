import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { decodeEarthModel, validateEarthModelAssets, createEarthModelLoader, EARTH_MODEL_MAX_BYTES } = await vite.ssrLoadModule("/features/earth/landmark-model.ts");
const { isEarthEiffelNearBounds } = await vite.ssrLoadModule("/features/earth/landmark-model-view.ts");
const digest = bytes => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixtureModel() {
  const buffer = new ArrayBuffer(16 + 3 * 24 + 3 * 4), header = new DataView(buffer);
  header.setUint32(0, 0x314d4c45, true); header.setUint32(4, 1, true); header.setUint32(8, 3, true); header.setUint32(12, 3, true);
  new Float32Array(buffer, 16, 18).set([-.2, -.2, 0, .4, .4, .4, .2, -.2, 0, .5, .5, .5, 0, .2, 1, .6, .6, .6]);
  new Uint32Array(buffer, 88, 3).set([0, 1, 2]);
  const asset = lod => ({ url: `/earth/models/eiffel-tower/${lod}.elm`, bytes: buffer.byteLength, sha256: digest(buffer), vertexCount: 3, indexCount: 3 });
  return { buffer, assets: { version: 1, overview: asset("overview"), detail: asset("detail") } };
}
function fixture() {
  const { buffer, assets } = fixtureModel(), requests = [], timers = new Map(); let nextTimer = 0, changes = 0;
  const environment = {
    fetch(url, init) { const pending = deferred(); requests.push({ url, init, ...pending }); return pending.promise; },
    sha256: async bytes => digest(bytes),
    schedule(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, cancel(id) { timers.delete(id); },
  };
  const loader = createEarthModelLoader(assets, () => { changes++; }, environment);
  return { loader, buffer, assets, requests, timers, get changes() { return changes; },
    response(index, bytes = buffer.slice(0), headers) { requests[index].resolve(new Response(bytes, { headers })); } };
}

test("prepared meshes decode into shared bounded views and reject corrupt geometry or oversized manifests", () => {
  const { buffer, assets } = fixtureModel(); const model = decodeEarthModel(buffer, assets.overview);
  assert.equal(model.vertices.buffer, buffer); assert.equal(model.indices.buffer, buffer); assert.equal(model.bytes, buffer.byteLength);
  assert.equal(validateEarthModelAssets(assets), assets);
  for (const mutate of [
    value => new DataView(value).setUint32(0, 0, true),
    value => new DataView(value).setUint32(4, 2, true),
    value => new DataView(value).setUint32(8, 100_001, true),
    value => new Float32Array(value, 16, 18)[0] = NaN,
    value => new Float32Array(value, 16, 18)[0] = 2,
    value => new Float32Array(value, 16, 18)[2] = -.1,
    value => new Float32Array(value, 16, 18)[3] = 1.5,
    value => new Float32Array(value, 16, 18)[14] = .9,
    value => new Uint32Array(value, 88, 3)[0] = 3,
  ]) { const corrupt = buffer.slice(0); mutate(corrupt); assert.throws(() => decodeEarthModel(corrupt, assets.overview)); }
  assert.throws(() => decodeEarthModel(buffer.slice(1), assets.overview));
  for (const patch of [{ url: "https://example.invalid/model.elm" }, { bytes: EARTH_MODEL_MAX_BYTES + 1 }, { vertexCount: 100_001 }, { indexCount: 4 }, { sha256: "wrong" }]) {
    assert.throws(() => validateEarthModelAssets({ ...assets, overview: { ...assets.overview, ...patch } }));
  }
});

test("both shipped Eiffel LODs match the preparation digest and the actual runtime decoder", async () => {
  const manifest = validateEarthModelAssets(JSON.parse(await readFile(new URL("../features/earth/data/eiffel-model.json", import.meta.url), "utf8")));
  for (const lod of ["overview", "detail"]) {
    const bytes = await readFile(new URL(`../public${manifest[lod].url}`, import.meta.url));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    assert.equal(digest(buffer), manifest[lod].sha256);
    const model = decodeEarthModel(buffer, manifest[lod]);
    assert.equal(model.vertices.length, manifest[lod].vertexCount * 6);
    assert.equal(model.indices.length, manifest[lod].indexCount);
    assert.ok(model.bytes <= EARTH_MODEL_MAX_BYTES);
  }
});

test("only a visible requested LOD fetches; two known levels serialize and already decoded levels never refetch", async () => {
  const f = fixture(); assert.equal(f.changes, 0); assert.equal(f.requests.length, 0);
  f.loader.request("overview"); f.loader.request("overview");
  assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 1);
  assert.equal(f.requests[0].url, `${f.assets.overview.url}?v=${f.assets.overview.sha256}`);
  assert.equal(f.requests[0].init.credentials, "omit"); assert.equal(f.requests[0].init.redirect, "error");
  f.loader.request("detail"); assert.equal(f.requests.length, 1, "a visible LOD change never starts a second concurrent body");
  f.response(0); await flush();
  assert.ok(f.loader.get("overview")); assert.equal(f.requests.length, 2);
  f.response(1); await flush(); assert.ok(f.loader.get("detail")); assert.equal(f.timers.size, 0);
  assert.equal(f.loader.getSnapshot().bytes, f.buffer.byteLength * 2);
  for (const lod of [null, "overview", "detail", null, "detail"]) f.loader.request(lod);
  assert.equal(f.requests.length, 2);
  f.loader.dispose(); assert.equal(f.loader.getSnapshot().bytes, 0);
});

test("compressed transfer length does not reject a correctly decoded versioned model body", async () => {
  const f = fixture(); f.loader.request("detail");
  f.response(0, f.buffer, { "content-length": "40", "content-encoding": "gzip" });
  await flush(); assert.equal(f.loader.getSnapshot().detail, "ready");
  assert.equal(f.loader.get("detail").bytes, f.assets.detail.bytes); f.loader.dispose();
});

test("hide and disposal abort immediately and old HTTP or digest completion cannot populate a retired model", async () => {
  const f = fixture(); f.loader.request("detail"); f.loader.request(null);
  assert.equal(f.requests[0].init.signal.aborted, true); assert.equal(f.timers.size, 0);
  f.loader.request("detail"); assert.equal(f.requests.length, 2);
  f.response(0); await flush(); assert.equal(f.loader.get("detail"), null);
  f.response(1); await flush(); assert.ok(f.loader.get("detail"));
  const retired = fixture(); retired.loader.request("overview"); retired.loader.dispose();
  retired.response(0); await flush(); assert.equal(retired.loader.get("overview"), null); assert.equal(retired.timers.size, 0);
  const { buffer, assets } = fixtureModel(), hash = deferred();
  const loader = createEarthModelLoader(assets, () => {}, { fetch: async () => new Response(buffer), sha256: () => hash.promise, schedule: () => 1, cancel() {} });
  loader.request("detail"); await flush(); loader.request(null); hash.resolve(assets.detail.sha256); await flush();
  assert.equal(loader.get("detail"), null); loader.dispose();
});

test("stream overflow, truncation, mismatched length and integrity fail closed without an automatic retry loop", async () => {
  for (const kind of ["overflow", "truncated", "length", "digest"]) {
    const f = fixture(); f.loader.request("overview");
    if (kind === "overflow") f.response(0, new Uint8Array(f.buffer.byteLength + 1));
    if (kind === "truncated") f.response(0, f.buffer.slice(0, -1));
    if (kind === "length") f.response(0, f.buffer, { "content-length": String(f.buffer.byteLength + 1) });
    if (kind === "digest") { const changed = f.buffer.slice(0); new Float32Array(changed, 16, 18)[3] = .25; f.response(0, changed); }
    await flush(); assert.equal(f.loader.getSnapshot().overview, "error"); assert.equal(f.loader.get("overview"), null);
    f.loader.request("overview"); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
    f.loader.dispose();
  }
});

test("deadline releases a stalled reader and retries remain bounded across visibility changes", async () => {
  const f = fixture(); f.loader.request("detail");
  for (const callback of [...f.timers.values()]) callback();
  assert.equal(f.requests[0].init.signal.aborted, true); assert.equal(f.timers.size, 0);
  assert.equal(f.loader.getSnapshot().detail, "error");
  f.loader.request(null); f.loader.request("detail"); assert.equal(f.requests.length, 2);
  for (const callback of [...f.timers.values()]) callback();
  f.loader.request(null); f.loader.request("detail"); assert.equal(f.requests.length, 2, "two failed attempts are the map-session ceiling");
  f.response(0); f.response(1); await flush(); assert.equal(f.loader.get("detail"), null); f.loader.dispose();
});

test("street geographic loading bounds handle wrapping and reject invalid or distant camera bounds", () => {
  const camera = { width: 390, height: 844, pitch: 60, verticalFieldOfView: 36.87 };
  const location = [2.2945, 48.85826];
  const bounds = { west: 2.29, east: 2.3, south: 48.861, north: 48.88 };
  assert.equal(isEarthEiffelNearBounds(location, bounds, camera), true);
  assert.equal(isEarthEiffelNearBounds(location, { ...bounds, west: 362.29, east: 362.3 }, camera), true);
  assert.equal(isEarthEiffelNearBounds(location, { ...bounds, west: 3.29, east: 3.3 }, camera), false);
  assert.equal(isEarthEiffelNearBounds(location, { ...bounds, south: 49, north: 50 }, camera), false);
  assert.equal(isEarthEiffelNearBounds([179.99, 0], { west: 179.98, east: -179.98, south: -.01, north: .01 }, camera), true);
  for (const patch of [{ west: NaN }, { north: 40 }, { east: Infinity }]) assert.equal(isEarthEiffelNearBounds(location, { ...bounds, ...patch }, camera), false);
  for (const patch of [{ width: 0 }, { height: NaN }, { pitch: Infinity }, { verticalFieldOfView: NaN }]) assert.equal(isEarthEiffelNearBounds(location, bounds, { ...camera, ...patch }), false);
});
