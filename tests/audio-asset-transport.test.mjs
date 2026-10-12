import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createAudioAssetTransport, AUDIO_ASSET_CACHE_NAME } = await vite.ssrLoadModule("/features/audio/runtime/audio-asset-transport.ts");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (size = 3, options = {}) => new Response(new Uint8Array(size).fill(7), { ...options, headers: { "content-type": "audio/wav", ...options.headers } });
const keyOf = input => typeof input === "string" ? input : `${new URL(input.url).pathname}${new URL(input.url).search}`;
function storage() {
  const entries = new Map(); const names = [];
  const cache = {
    match: async input => entries.get(keyOf(input))?.clone(),
    delete: async input => entries.delete(keyOf(input)),
    keys: async () => [...entries.keys()].map(key => new Request(`https://test.invalid${key}`)),
    put: async (input, value) => { entries.set(keyOf(input), value.clone()); },
  };
  return { entries, names, cache, open: async name => { names.push(name); return cache; } };
}

test("two cold callers share one request, receive independent bodies, and survive next launch from storage", async () => {
  const saved = storage(); const gate = deferred(); let requests = 0;
  const first = createAudioAssetTransport({ cacheStorage: saved, fetchAsset: async () => { requests++; return gate.promise; } });
  const a = first.fetch("/audio/wind-v2.wav"); const b = first.fetch("/audio/wind-v2.wav");
  await flush(); assert.equal(requests, 1); gate.resolve(response());
  assert.deepEqual([...new Uint8Array(await (await a).arrayBuffer())], [7, 7, 7]);
  assert.equal((await (await b).arrayBuffer()).byteLength, 3); await first.flushStorage(); first.dispose();
  const second = createAudioAssetTransport({ cacheStorage: saved, fetchAsset: async () => { requests++; return response(); } });
  assert.equal((await (await second.fetch("/audio/wind-v2.wav")).arrayBuffer()).byteLength, 3);
  assert.equal(requests, 1); assert.ok(saved.names.every(name => name === AUDIO_ASSET_CACHE_NAME)); second.dispose();
});

test("aborting one caller never aborts another consumer of the same cold request", async () => {
  const gate = deferred(); let networkSignal; let requests = 0;
  const transport = createAudioAssetTransport({ fetchAsset: async (_url, init) => { requests++; networkSignal = init.signal; return gate.promise; } });
  const controller = new AbortController();
  const a = transport.fetch("/audio/wind.wav", { signal: controller.signal }); const b = transport.fetch("/audio/wind.wav");
  await flush(); controller.abort(); await assert.rejects(a, { name: "AbortError" });
  assert.equal(networkSignal.aborted, false); gate.resolve(response()); assert.equal((await b).status, 200);
  assert.equal(requests, 1); transport.dispose();
});

test("last caller cancellation aborts download; a new claim can retry without inheriting the abort", async () => {
  const gates = []; const signals = [];
  const transport = createAudioAssetTransport({ fetchAsset: async (_url, init) => { const gate = deferred(); gates.push(gate); signals.push(init.signal); return gate.promise; } });
  const controller = new AbortController(); const a = transport.fetch("/audio/wind.wav", { signal: controller.signal });
  await flush(); controller.abort(); await assert.rejects(a, { name: "AbortError" }); assert.equal(signals[0].aborted, true);
  const b = transport.fetch("/audio/wind.wav"); await flush(); assert.equal(gates.length, 2);
  gates[0].resolve(response()); gates[1].resolve(response()); assert.equal((await b).status, 200); transport.dispose();
});

test("dispose releases all waiters even when the underlying fetch ignores abort", async () => {
  const gate = deferred(); const saved = storage();
  const transport = createAudioAssetTransport({ cacheStorage: saved, fetchAsset: () => gate.promise });
  const requests = [transport.fetch("/audio/wind.wav"), transport.fetch("/audio/wind.wav")];
  await flush(); transport.dispose(); await Promise.all(requests.map(value => assert.rejects(value, { name: "AbortError" })));
  gate.resolve(response()); await flush(); assert.equal(saved.entries.size, 0);
  await assert.rejects(transport.fetch("/audio/wind.wav"), { name: "AbortError" });
});

test("CacheStorage unavailable, denied, or full falls back to complete network responses", async () => {
  for (const failure of ["absent", "open", "match", "put"]) {
    const saved = storage();
    if (failure === "open") saved.open = async () => { throw new Error("denied"); };
    if (failure === "match") saved.cache.match = async () => { throw new Error("denied"); };
    if (failure === "put") saved.cache.put = async () => { throw new Error("quota"); };
    let requests = 0;
    const transport = createAudioAssetTransport({ cacheStorage: failure === "absent" ? undefined : saved, fetchAsset: async () => { requests++; return response(); } });
    assert.equal((await (await transport.fetch("/audio/wind.wav")).arrayBuffer()).byteLength, 3, failure);
    await transport.flushStorage(); assert.equal(requests, 1); transport.dispose();
  }
});

test("encoded storage respects byte and entry caps across concurrent writers", async () => {
  for (const [maxStoredBytes, maxEntries, expected] of [[10, 64, 2], [100, 2, 2]]) {
    const saved = storage();
    const transport = createAudioAssetTransport({ cacheStorage: saved, maxStoredBytes, maxEntries, fetchAsset: async () => response(4) });
    await Promise.all(Array.from({ length: 8 }, (_, index) => transport.fetch(`/audio/${index}.wav`)));
    await transport.flushStorage();
    assert.equal(saved.entries.size, expected);
    assert.ok([...saved.entries.values()].reduce((sum, entry) => sum + Number(entry.headers.get("x-zhiv-audio-bytes")), 0) <= maxStoredBytes);
    await transport.fetch("/audio/new.wav"); await transport.flushStorage();
    assert.equal(saved.entries.size, expected); assert.ok(saved.entries.has("/audio/new.wav")); transport.dispose();
  }
});

test("errors, partial/private responses, wrong content, oversized and truncated bodies are never stored", async () => {
  const cases = [
    () => response(3, { status: 503 }), () => response(3, { status: 206 }),
    () => response(3, { headers: { "content-range": "bytes 0-2/10" } }),
    () => response(3, { headers: { "cache-control": "public, private" } }),
    () => response(3, { headers: { "cache-control": "no-store" } }),
    () => response(3, { headers: { vary: "Cookie" } }),
    () => response(3, { headers: { "content-type": "text/html" } }),
    () => response(3, { headers: { "content-length": "30" } }),
    () => response(3, { headers: { "content-length": "4" } }), () => response(12),
  ];
  for (const makeResponse of cases) {
    const saved = storage(); const transport = createAudioAssetTransport({ cacheStorage: saved, maxStoredBytes: 10, fetchAsset: async () => makeResponse() });
    const result = await transport.fetch("/audio/wind.wav"); await result.arrayBuffer();
    await transport.flushStorage();
    assert.equal(saved.entries.size, 0); transport.dispose();
  }
});

test("only anonymous local public audio participates; private or range requests pass through unchanged", async () => {
  const inputs = [
    ["https://external.invalid/audio/a.wav"], ["//external.invalid/audio/a.wav"], ["/api/a.wav"], ["/audio/../api/a.wav"],
    ["/audio/a.wav?token=secret"], ["/audio/a.wav", { credentials: "include" }], ["/audio/a.wav", { method: "POST" }],
    ["/audio/a.wav", { headers: { Authorization: "<test-authorization>" } }], ["/audio/a.wav", { headers: { Range: "bytes=0-9" } }],
    ["/audio/a.wav", { cache: "no-store" }], [new Request("https://test.invalid/audio/a.wav")],
  ];
  const saved = storage(); const calls = [];
  const transport = createAudioAssetTransport({ cacheStorage: saved, fetchAsset: async (...args) => { calls.push(args); return response(); } });
  for (const args of inputs) {
    await Promise.all([transport.fetch(...args), transport.fetch(...args)]);
    assert.equal(calls.at(-1)[0], args[0]); assert.equal(calls.at(-1)[1], args[1]);
  }
  assert.equal(calls.length, inputs.length * 2); assert.equal(saved.entries.size, 0); assert.equal(saved.names.length, 0); transport.dispose();
});

test("exact version URLs remain separate and malformed stored entries are replaced", async () => {
  const saved = storage(); saved.entries.set("/audio/wind.wav?v=1", response()); let requests = 0;
  const transport = createAudioAssetTransport({ cacheStorage: saved, fetchAsset: async () => { requests++; return response(); } });
  await transport.fetch("/audio/wind.wav?v=1"); await transport.flushStorage();
  await transport.fetch("/audio/wind.wav?v=2"); await transport.flushStorage(); await transport.fetch("/audio/wind.wav?v=1");
  assert.equal(requests, 2); assert.equal(saved.entries.size, 2); transport.dispose();
});

test("stalled CacheStorage reads fall back within 200ms and disposal cannot start a late fetch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const dispose of [false, true]) {
    const gate = deferred(); const saved = storage(); saved.cache.match = () => gate.promise; let requests = 0;
    const transport = createAudioAssetTransport({ cacheStorage: saved, fetchAsset: async () => { requests++; return response(); } });
    const result = transport.fetch("/audio/wind.wav"); await flush();
    if (dispose) { transport.dispose(); await assert.rejects(result, { name: "AbortError" }); }
    else { t.mock.timers.tick(200); await flush(); assert.equal((await result).status, 200); assert.equal(requests, 1); }
    gate.resolve(undefined); await flush(); assert.equal(requests, dispose ? 0 : 1);
    transport.dispose();
  }
});

test("a blocked persistent write never delays playback and its queue is bounded by a deadline", async () => {
  const gate = deferred(); const saved = storage(); let reads = 0;
  saved.cache.keys = async () => { reads++; return gate.promise; };
  const transport = createAudioAssetTransport({ cacheStorage: saved, fetchAsset: async () => response() });
  const result = await transport.fetch("/audio/wind.wav");
  assert.equal((await result.arrayBuffer()).byteLength, 3);
  await flush(); assert.equal(reads, 1);
  await transport.flushStorage();
  transport.dispose(); gate.resolve([]); await flush(); assert.equal(saved.entries.size, 0, "late storage completion must not write after disposal");
});

test("caller abort during body download affects only its response; disposal closes the remaining body", async () => {
  let stream; let requests = 0;
  const transport = createAudioAssetTransport({ fetchAsset: async () => {
    requests++; return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "audio/wav" } });
  } });
  const abort = new AbortController();
  const first = await transport.fetch("/audio/wind.wav", { signal: abort.signal });
  const responses = [first, await transport.fetch("/audio/wind.wav")];
  assert.equal(requests, 1, "a consumer arriving after headers still shares the body download");
  const a = responses[0].arrayBuffer(); const b = responses[1].arrayBuffer();
  stream.enqueue(new Uint8Array([1])); abort.abort();
  await assert.rejects(a, { name: "AbortError" });
  let otherDone = false; b.finally(() => { otherDone = true; }).catch(() => {}); await flush(); assert.equal(otherDone, false);
  stream.enqueue(new Uint8Array([2])); stream.close();
  assert.deepEqual([...new Uint8Array(await b)], [1, 2]); transport.dispose();

  const waiting = createAudioAssetTransport({ cacheStorage: storage(), fetchAsset: async () => new Response(new ReadableStream(), { headers: { "content-type": "audio/wav" } }) });
  const result = await waiting.fetch("/audio/wind.wav"); const bytes = result.arrayBuffer();
  waiting.dispose(); await assert.rejects(bytes, { name: "AbortError" }); await waiting.flushStorage();
});
