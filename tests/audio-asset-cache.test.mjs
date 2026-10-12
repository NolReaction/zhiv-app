import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createAudioAssetCache } = await vite.ssrLoadModule("/features/audio/runtime/audio-asset-cache.ts");
const { createAudioAssetTransport } = await vite.ssrLoadModule("/features/audio/runtime/audio-asset-transport.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const asset = id => ({ id, status: "ready", src: `/audio/${id}.wav`, license: null });
const buffer = (length = 100) => ({ length, numberOfChannels: 1, duration: length / 44100 });
function fixture(overrides = {}) {
  let now = 0; const requests = []; const gates = []; let active = 0; let peak = 0;
  const context = { state: "running", decodeAudioData: async () => {
    active++; peak = Math.max(peak, active); const gate = deferred(); gates.push(gate);
    try { return await gate.promise; } finally { active--; }
  } };
  const cache = createAudioAssetCache({ context: () => context, now: () => now, changed: () => {}, isInUse: () => false,
    fetchAsset: async (url, init) => { requests.push({ url, init }); return new Response(new Uint8Array([1])); }, ...overrides });
  return { cache, context, requests, gates, advance: ms => { now += ms; }, peak: () => peak };
}

test("cold burst coalesces each asset and runs only one native decoder at a time", async () => {
  const f = fixture();
  const promises = Array.from({ length: 12 }, (_, index) => f.cache.load(asset(String(index))));
  assert.equal(f.cache.load(asset("0")), promises[0]);
  await flush();
  assert.equal(f.requests.length, 2); assert.equal(f.gates.length, 1);
  assert.equal(f.cache.decodingCount(), 1); assert.equal(f.cache.queuedDecodeCount(), 11);
  for (let index = 0; index < promises.length; index++) {
    f.gates[index].resolve(buffer()); await promises[index]; await flush();
    assert.equal(f.gates.length, Math.min(index + 2, promises.length));
  }
  assert.equal(f.peak(), 1); assert.equal(f.cache.loadedCount(), 12);
  assert.equal(f.cache.loadingCount(), 0); assert.equal(f.cache.decodingCount(), 0);
  const count = f.requests.length; await f.cache.load(asset("0")); assert.equal(f.requests.length, count);
  f.cache.dispose();
});

test("queued work gets a fresh deadline; timeout retains its uncancellable decoder claim", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); const first = f.cache.load(asset("wind")); const queued = f.cache.load(asset("bush"));
  await flush(); t.mock.timers.tick(12_001); f.advance(40_000); await flush();
  assert.equal(await first, null);
  assert.equal(f.cache.load(asset("wind")), first, "retry cannot overlap a timed-out native decoder");
  assert.equal(f.gates.length, 1); assert.equal(f.cache.queuedDecodeCount(), 1);
  let queuedSettled = false; queued.then(() => { queuedSettled = true; }); await flush();
  assert.equal(queuedSettled, false, "time waiting for the decoder is not a network timeout");
  f.gates[0].resolve(buffer()); await flush();
  assert.equal(f.gates.length, 2); assert.equal(f.cache.loadedCount(), 0, "late timed-out result is discarded");
  t.mock.timers.tick(11_999); await flush(); assert.equal(queuedSettled, false);
  f.gates[1].resolve(buffer()); assert.ok(await queued); assert.equal(f.peak(), 1);
  f.cache.dispose();
});

test("disposal settles active and queued callers immediately and starts no late decode", async () => {
  const f = fixture(); const active = f.cache.load(asset("wind")); const queued = f.cache.load(asset("bird"));
  await flush(); f.cache.dispose();
  assert.equal(await active, null); assert.equal(await queued, null);
  assert.equal(f.requests[0].init.signal.aborted, true); assert.equal(f.cache.loadingCount(), 0);
  f.gates[0].resolve(buffer()); await flush();
  assert.equal(f.gates.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.cache.loadedCount(), 0);
  assert.equal(await f.cache.load(asset("new")), null);
});

test("disposal during a stalled download releases waiters without decoding its late body", async () => {
  const download = deferred();
  const f = fixture({ fetchAsset: () => download.promise }); const promise = f.cache.load(asset("wind"));
  await flush(); f.cache.dispose(); assert.equal(await promise, null);
  download.resolve(new Response(new Uint8Array([1]))); await flush(); assert.equal(f.gates.length, 0);
});

test("failed download allows the next asset through and observes retry backoff", async () => {
  const requests = []; const f = fixture({ fetchAsset: async url => { requests.push(url); return new Response("", { status: url.includes("bad") ? 503 : 200 }); } });
  const failed = f.cache.load(asset("bad")); const next = f.cache.load(asset("good"));
  assert.equal(await failed, null); await flush(); assert.equal(f.gates.length, 1);
  f.gates[0].resolve(buffer()); assert.ok(await next);
  await f.cache.load(asset("bad")); assert.equal(requests.length, 2);
  f.advance(30_001); await f.cache.load(asset("bad")); assert.equal(requests.length, 3);
  f.cache.dispose();
});

test("fallback decode is serial and pinned buffers preserve the memory budget", async () => {
  const calls = [];
  const cache = createAudioAssetCache({ context: () => ({ state: "running", decodeAudioData: async bytes => {
    calls.push(new Uint8Array(bytes)[0]); if (calls.length === 1) throw new Error("codec"); return buffer(100);
  } }), fetchAsset: async url => new Response(new Uint8Array([url.includes("fallback") ? 2 : 1])), now: () => 0,
  changed: () => {}, isInUse: id => id === "wind", maxDecodedBytes: 400 });
  assert.ok(await cache.load({ ...asset("wind"), fallbackSrc: "/audio/fallback.wav" }));
  assert.deepEqual(calls, [1, 2]);
  assert.equal(await cache.load(asset("bush")), null); assert.equal(cache.loadedCount(), 1);
  cache.dispose();
});

test("a stalled loop download does not block the second worker from decoding a small UI sound", async () => {
  const wind = deferred();
  const f = fixture({ fetchAsset: url => url.includes("wind") ? wind.promise : Promise.resolve(new Response(new Uint8Array([2]))) });
  const loop = f.cache.load(asset("wind"), 20); const tap = f.cache.load(asset("tap"), 100);
  await flush(); assert.equal(f.gates.length, 1);
  f.gates[0].resolve(buffer()); assert.ok(await tap);
  f.cache.dispose(); assert.equal(await loop, null); wind.resolve(new Response(new Uint8Array([1]))); await flush();
  assert.equal(f.gates.length, 1);
});

test("new and promoted UI jobs overtake queued warmups with FIFO inside equal priorities", async () => {
  const f = fixture();
  const first = f.cache.load(asset("first")); const second = f.cache.load(asset("second"));
  const warm = f.cache.load(asset("warm")); const promoted = f.cache.load(asset("promoted"));
  assert.equal(f.cache.load(asset("promoted"), 100), promoted);
  const ui = f.cache.load(asset("ui"), 100);
  await flush(); assert.equal(f.requests.length, 2);
  for (let index = 0; index < 5; index++) { f.gates[index].resolve(buffer()); await flush(); }
  await Promise.all([first, second, warm, promoted, ui]);
  assert.deepEqual(f.requests.map(request => request.url), ["/audio/first.wav", "/audio/second.wav", "/audio/promoted.wav", "/audio/ui.wav", "/audio/warm.wav"]);
  assert.equal(f.peak(), 1); f.cache.dispose();
});

test("rejected missing or oversized response bodies are released, so retries fetch fresh bytes", async () => {
  for (const failure of ["missing", "oversized"]) {
    let requests = 0;
    const transport = createAudioAssetTransport({ fetchAsset: async () => {
      requests++;
      if (requests === 1) return new Response(new Uint8Array([1]), failure === "missing"
        ? { status: 404 } : { headers: { "content-length": String(13 * 1024 * 1024) } });
      return new Response(new Uint8Array([2]));
    } });
    const f = fixture({ fetchAsset: transport.fetch });
    assert.equal(await f.cache.load(asset("wind")), null, failure);
    assert.equal(transport.pendingCount(), 0, "an unread failed response must not survive in-flight coalescing");
    f.advance(30_001); const retry = f.cache.load(asset("wind")); await flush();
    assert.equal(requests, 2, failure); assert.equal(f.gates.length, 1);
    f.gates[0].resolve(buffer()); assert.ok(await retry);
    f.cache.dispose(); transport.dispose();
  }
});

test("a rejected primary response is released before requesting its codec fallback", async () => {
  const requests = [];
  const transport = createAudioAssetTransport({ fetchAsset: async url => {
    requests.push(url);
    if (url.includes("fallback")) {
      assert.equal(transport.pendingCount(), 1, "only the fallback request may remain, not the rejected primary body");
      return new Response(new Uint8Array([2]));
    }
    return new Response(new Uint8Array([1]), { status: 404 });
  } });
  const f = fixture({ fetchAsset: transport.fetch });
  const ready = f.cache.load({ ...asset("wind"), fallbackSrc: "/audio/fallback.wav" });
  await flush(); assert.equal(f.gates.length, 1); f.gates[0].resolve(buffer()); assert.ok(await ready);
  assert.deepEqual(requests, ["/audio/wind.wav", "/audio/fallback.wav"]);
  assert.equal(transport.pendingCount(), 0); f.cache.dispose(); transport.dispose();
});
