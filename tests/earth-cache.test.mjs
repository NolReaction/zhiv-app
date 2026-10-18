import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { createEarthResourceCache, EARTH_CACHE_NAME } = await vite.ssrLoadModule("/features/earth/resource-cache.ts");
after(() => vite.close());
const base = "https://tiles.openfreemap.org";
const encoder = new TextEncoder();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const mapJson = name => ({ name, version: 8, sources: {}, layers: [], tiles: [`${base}/planet/dated/{z}/{x}/{y}.pbf`] });

class MemoryCache {
  records = new Map();
  writes = 0;
  deletions = [];
  writeError = null;
  deleteError = null;
  async keys() { return [...this.records.keys()].map(url => new Request(url)); }
  async match(key) { return this.records.get(typeof key === "string" ? key : key.url)?.clone(); }
  async put(key, response) {
    if (this.writeError) throw this.writeError;
    this.writes += 1;
    this.records.set(typeof key === "string" ? key : key.url, response.clone());
  }
  async delete(key) { const url = typeof key === "string" ? key : key.url; this.deletions.push(url); if (this.deleteError) throw this.deleteError; return this.records.delete(url); }
}
class MemoryLocks {
  tail = Promise.resolve();
  request(name, options, callback) {
    const result = this.tail.then(() => {
      if (options.signal.aborted) throw new DOMException("cancelled", "AbortError");
      return callback({ name });
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
function platform(overrides = {}) {
  const cache = new MemoryCache();
  const opened = [];
  const calls = [];
  const environment = {
    cacheStorage: { async open(name) { opened.push(name); return cache; } },
    storageManager: null, lockManager: new MemoryLocks(),
    fetcher: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(mapJson(url)), { headers: { "content-type": "application/json" } }); },
    attempts: 1, timeoutMs: 500, origin: "https://zhiv.test", ...overrides,
  };
  return { cache, opened, calls, environment, controller: createEarthResourceCache(environment) };
}

test("public responses survive a new controller/page and remain usable without network", async () => {
  const s = platform();
  const url = `${base}/styles/liberty`;
  const first = await s.controller.readResource(url, "json");
  assert.equal(first.data.name, url);
  assert.deepEqual(s.opened, [EARTH_CACHE_NAME]);
  assert.equal(s.cache.writes, 1);
  assert.equal(s.calls[0].init.credentials, "omit");
  assert.equal(s.calls[0].init.mode, "cors");
  const offline = createEarthResourceCache({ ...s.environment, fetcher: async () => { throw new Error("offline"); } });
  assert.deepEqual((await offline.readResource(url, "json")).data, first.data);
  assert.equal(offline.getSnapshot().cacheHits, 1);
  assert.equal(offline.getSnapshot().networkBytes, 0);
  assert.equal(offline.getSnapshot().storedEntries, 1);
  assert.equal(offline.getSnapshot().storage, "device");
});

test("protocol wraps only approved public resources and returns each SDK response type", async () => {
  const s = platform({ fetcher: async url => new Response(url.endsWith(".pbf") ? new Uint8Array([10, 1, 0]) : url.endsWith(".txt") ? "license" : '{"name":"map"}') });
  for (const url of [`${base}/styles/liberty`, `${base}/fonts/test/0-255.pbf`, "/vendor/maplibre-gl-6.15.0/maplibre-gl.mjs", "/vendor/maplibre-gl-6.15.0/manifest.json"]) {
    assert.match(s.controller.transformRequest(url).url, /^earth-cache:\/\//);
  }
  const credentialUrl = new URL(`${base}/a`);
  credentialUrl.username = "fixture"; credentialUrl.password = credentialUrl.username;
  for (const url of ["https://evil.test/tiles/0", "https://tiles.openfreemap.org.evil.test/a", "http://tiles.openfreemap.org/a", credentialUrl.href, "/api/location", "/vendor/arbitrary.mjs"]) {
    assert.equal(s.controller.transformRequest(url).url, url);
    await assert.rejects(s.controller.readResource(url), /allowlist|Unsupported/);
  }
  const buffer = await s.controller.protocol({ url: s.controller.transformRequest(`${base}/a.pbf`).url, type: "arrayBuffer" }, new AbortController());
  assert.ok(buffer.data instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(buffer.data)], [10, 1, 0]);
  assert.deepEqual((await s.controller.protocol({ url: `${base}/style.json`, type: "json" }, new AbortController())).data, { name: "map" });
  assert.equal((await s.controller.readResource("/vendor/maplibre-gl-6.15.0/LICENSE.txt", "string")).data, "license");
  const image = await s.controller.protocol({ url: `${base}/sprite`, type: "image" }, new AbortController());
  assert.ok(image.data instanceof ArrayBuffer);
});

test("concurrent consumers share a fetch but receive independently transferable buffers", async () => {
  let finish;
  let calls = 0;
  let requestSignal;
  const s = platform({ fetcher: (_url, init) => { calls += 1; requestSignal = init.signal; return new Promise(resolve => { finish = resolve; }); } });
  const cancelled = new AbortController();
  const a = s.controller.readResource(`${base}/tile`, "arrayBuffer", cancelled.signal);
  const rejected = assert.rejects(a, { name: "AbortError" });
  const b = s.controller.readResource(`${base}/tile`, "arrayBuffer");
  const c = s.controller.readResource(`${base}/tile`, "arrayBuffer");
  await tick();
  cancelled.abort();
  assert.equal(requestSignal.aborted, false);
  finish(new Response(new Uint8Array([1, 2, 3])));
  const [one, two] = await Promise.all([b, c]);
  await rejected;
  assert.equal(calls, 1);
  assert.notEqual(one.data, two.data);
  new Uint8Array(one.data)[0] = 9;
  assert.equal(new Uint8Array(two.data)[0], 1);
  assert.equal(s.controller.getSnapshot().completed, 1);
  assert.equal(s.controller.getSnapshot().pending, 0);
});

test("cancelling every consumer aborts work; a new consumer starts a fresh request", async () => {
  const signals = [];
  const s = platform({ fetcher: (_url, init) => { signals.push(init.signal); return new Promise(resolve => { if (signals.length > 1) resolve(new Response("new")); }); } });
  const cancelled = new AbortController();
  const old = s.controller.readResource(`${base}/tile`, "string", cancelled.signal);
  const rejected = assert.rejects(old, { name: "AbortError" });
  await tick();
  cancelled.abort();
  const next = s.controller.readResource(`${base}/tile`, "string");
  await rejected;
  assert.equal(signals[0].aborted, true);
  assert.equal((await next).data, "new");
  assert.equal(signals.length, 2);
  assert.equal(s.controller.getSnapshot().failed, 0);
});

test("network concurrency is bounded and aborting a queued request never fetches it", async () => {
  const releases = [];
  const fetched = [];
  let active = 0;
  let peak = 0;
  const s = platform({ concurrency: 2, fetcher: url => { fetched.push(url); active += 1; peak = Math.max(peak, active); return new Promise(resolve => { releases.push(() => { active -= 1; resolve(new Response("tile")); }); }); } });
  const abort = new AbortController();
  const jobs = [s.controller.readResource(`${base}/0`, "string"), s.controller.readResource(`${base}/1`, "string")];
  const queued = s.controller.readResource(`${base}/cancelled`, "string", abort.signal);
  const rejected = assert.rejects(queued, { name: "AbortError" });
  jobs.push(s.controller.readResource(`${base}/2`, "string"));
  await tick();
  assert.equal(fetched.length, 2);
  abort.abort();
  releases.shift()();
  await tick();
  assert.equal(fetched.length, 3);
  while (releases.length) releases.shift()();
  await Promise.all(jobs);
  await rejected;
  assert.equal(peak, 2);
  assert.ok(fetched.every(url => !url.endsWith("cancelled")));
  assert.equal(s.controller.getSnapshot().pending, 0);
});

test("partial downloads are resumed and resetting progress keeps live pending work", async () => {
  let finish;
  const s = platform({ fetcher: url => url.endsWith("good") ? Promise.resolve(new Response("saved")) : new Promise(resolve => { finish = resolve; }) });
  await s.controller.readResource(`${base}/good`, "string");
  const pending = s.controller.readResource(`${base}/next`, "string");
  await tick();
  s.controller.resetProgress();
  assert.equal(s.controller.getSnapshot().pending, 1);
  assert.equal(s.controller.getSnapshot().completed, 0);
  finish(new Response("saved too"));
  await pending;
  assert.equal(s.controller.getSnapshot().completed, 1);
  assert.equal(s.controller.getSnapshot().storedEntries, 2);
  const reloaded = createEarthResourceCache({ ...s.environment, fetcher: async () => { throw new Error("offline"); } });
  assert.equal((await reloaded.readResource(`${base}/good`, "string")).data, "saved");
  assert.equal((await reloaded.readResource(`${base}/next`, "string")).data, "saved too");
});

test("a corrupted cached body is evicted and repaired instead of poisoning every reload", async () => {
  const s = platform();
  const url = `${base}/styles/liberty`;
  await s.controller.readResource(url, "json");
  const original = s.cache.records.get(url);
  const body = await original.clone().text();
  s.cache.records.set(url, new Response("!".repeat(encoder.encode(body).length), { headers: original.headers }));
  const reloaded = createEarthResourceCache(s.environment);
  assert.equal((await reloaded.readResource(url, "json")).data.name, url);
  assert.equal(s.calls.length, 2);
  assert.ok(s.cache.deletions.includes(url));
  assert.equal(reloaded.getSnapshot().failed, 0);
});

test("JSON, PNG and protobuf validation rejects malformed network bodies; failed HTTP is not saved", async () => {
  for (const [path, type, response] of [["style.json", "json", new Response("{")], ["sprite.png", "image", new Response("not png")], ["font.pbf", "arrayBuffer", new Response(new Uint8Array([10, 12, 1]))], ["tile", "arrayBuffer", new Response("error", { status: 503 })]]) {
    const s = platform({ fetcher: async () => response.clone() });
    await assert.rejects(s.controller.readResource(`${base}/${path}`, type));
    assert.equal(s.cache.writes, 0);
    assert.equal(s.controller.getSnapshot().failed, 1);
    assert.equal(s.controller.getSnapshot().pending, 0);
  }
  const empty = platform({ fetcher: async () => new Response(new Uint8Array()) });
  assert.equal((await empty.controller.readResource(`${base}/empty.pbf`)).data.byteLength, 0);
});

test("opaque responses cannot be cached and timeouts retry only the bounded number of attempts", async () => {
  const opaque = new Response("opaque");
  Object.defineProperty(opaque, "type", { value: "opaque" });
  const s = platform({ fetcher: async () => opaque });
  await assert.rejects(s.controller.readResource(`${base}/opaque`));
  assert.equal(s.cache.writes, 0);
  let attempts = 0;
  const timeout = platform({ timeoutMs: 5, attempts: 2, fetcher: async () => { attempts += 1; return new Promise(() => {}); } });
  await assert.rejects(timeout.controller.readResource(`${base}/slow`), /timed out/);
  assert.equal(attempts, 2);
  assert.equal(timeout.controller.getSnapshot().failed, 1);
  assert.equal(timeout.controller.getSnapshot().pending, 0);
  let interruptedCalls = 0;
  const interrupted = platform({ attempts: 2, fetcher: async () => { interruptedCalls += 1; throw new DOMException("browser interrupted fetch", "AbortError"); } });
  await assert.rejects(interrupted.controller.readResource(`${base}/interrupted`), /interrupted/);
  assert.equal(interruptedCalls, 2);
  assert.equal(interrupted.controller.getSnapshot().failed, 1);
});

test("serialized writes enforce entry/byte caps and preserve the newest usable partial cache", async () => {
  const s = platform({ maxEntries: 2, maxBytes: 8, fetcher: async url => new Response(url.slice(-4)) });
  await Promise.all([0, 1, 2, 3, 4].map(index => s.controller.readResource(`${base}/000${index}`, "string")));
  assert.equal(s.cache.records.size, 2);
  assert.equal(s.controller.getSnapshot().storedEntries, 2);
  assert.equal(s.controller.getSnapshot().storedBytes, 8);
  assert.equal((await s.controller.readResource(`${base}/0004`, "string")).data, "0004");
  assert.equal(s.controller.getSnapshot().cacheHits, 1);
});

test("quota/unavailable storage degrades to bounded session caching with explicit status", async () => {
  for (const quota of [false, true]) {
    const s = platform(quota ? {} : { cacheStorage: null });
    if (quota) s.cache.writeError = new DOMException("full", "QuotaExceededError");
    const url = `${base}/styles/liberty`;
    await s.controller.readResource(url, "json");
    assert.equal((await s.controller.readResource(url, "json")).data.name, url);
    assert.equal(s.calls.length, 1);
    assert.equal(s.controller.getSnapshot().storage, "session");
    assert.equal(s.controller.getSnapshot().storageIssue, quota ? "quota" : "unavailable");
    assert.equal(s.controller.getSnapshot().storedEntries, 0);
  }
});

test("persistence is requested only by the explicit helper; subscriptions expose stable snapshots", async () => {
  let requested = 0;
  let notified = 0;
  const s = platform({ storageManager: { async persisted() { return false; }, async persist() { requested += 1; return false; }, async estimate() { return { quota: 1000, usage: 40 }; } } });
  const before = s.controller.getSnapshot();
  assert.equal(s.controller.getSnapshot(), before);
  const unsubscribe = s.controller.subscribe(() => { notified += 1; });
  await s.controller.initialize();
  assert.equal(requested, 0);
  await s.controller.requestPersistence();
  assert.equal(requested, 1);
  assert.equal(s.controller.getSnapshot().persistence, "best-effort");
  assert.equal(s.controller.getSnapshot().quotaBytes, 1000);
  assert.equal(s.controller.getSnapshot().usageBytes, 40);
  assert.ok(notified > 0);
  unsubscribe();
  const previous = notified;
  s.controller.resetProgress();
  assert.equal(notified, previous);
});

test("invalidating a resource removes both session and persistent copies before re-download", async () => {
  const s = platform();
  const url = `${base}/styles/liberty`;
  await s.controller.readResource(url, "json");
  await s.controller.invalidate(url);
  assert.equal(s.controller.getSnapshot().storedEntries, 0);
  await s.controller.readResource(url, "json");
  assert.equal(s.calls.length, 2);
  await s.controller.readResource(url, "json");
  assert.equal(s.calls.length, 2);
  assert.equal(s.controller.getSnapshot().cacheHits, 1);
});

test("successful retry counts the final resource once; no-store and session limits remain honest", async () => {
  let attempts = 0;
  const s = platform({ attempts: 2, fetcher: async () => { attempts += 1; return attempts === 1 ? new Response("busy", { status: 503 }) : new Response("ok"); } });
  assert.equal((await s.controller.readResource(`${base}/retry`, "string")).data, "ok");
  assert.equal(attempts, 2);
  assert.equal(s.controller.getSnapshot().completed, 1);
  assert.equal(s.controller.getSnapshot().failed, 0);
  const privateResponse = platform({ fetcher: async () => new Response("not stored", { headers: { "cache-control": "no-store" } }) });
  await privateResponse.controller.readResource(`${base}/no-store`, "string");
  await privateResponse.controller.readResource(`${base}/no-store`, "string");
  assert.equal(privateResponse.cache.records.size, 0);
  assert.equal(privateResponse.controller.getSnapshot().cacheHits, 0);
  const session = platform({ cacheStorage: null, maxEntries: 2, maxBytes: 8, fetcher: async url => new Response(url.slice(-4)) });
  for (const index of [0, 1, 2]) await session.controller.readResource(`${base}/000${index}`, "string");
  assert.equal((await session.controller.readResource(`${base}/0002`, "string")).data, "0002");
  assert.equal(session.controller.getSnapshot().cacheHits, 1);
  await session.controller.readResource(`${base}/0000`, "string");
  assert.equal(session.controller.getSnapshot().cacheHits, 1);
  assert.equal(session.controller.getSnapshot().storedEntries, 0);
});

test("stale mutable style and TileJSON revalidate; valid offline fallback never counts as failure", async () => {
  for (const path of ["/styles/liberty", "/planet"]) {
    const s = platform();
    const url = `${base}${path}`;
    await s.controller.readResource(url, "json");
    const prior = s.cache.records.get(url);
    const headers = new Headers(prior.headers);
    headers.set("x-zhiv-earth-saved", String(Date.now() - 25 * 60 * 60 * 1000));
    s.cache.records.set(url, new Response(await prior.arrayBuffer(), { headers }));
    let revalidated = 0;
    const offline = createEarthResourceCache({ ...s.environment, fetcher: async (_url, init) => { revalidated += 1; assert.equal(init.cache, "no-cache"); throw new Error("offline"); } });
    assert.equal((await offline.readResource(url, "json")).data.name, url);
    assert.equal(revalidated, 1);
    assert.equal(offline.getSnapshot().failed, 0);
    assert.equal(offline.getSnapshot().cacheHits, 1);
    assert.equal(offline.getSnapshot().storedEntries, 1);
    const refreshed = createEarthResourceCache({ ...s.environment, fetcher: async () => new Response(JSON.stringify(mapJson("updated"))) });
    assert.equal((await refreshed.readResource(url, "json")).data.name, "updated");
    assert.equal(refreshed.getSnapshot().cacheHits, 0);
    assert.equal(refreshed.getSnapshot().failed, 0);
    const saved = createEarthResourceCache({ ...s.environment, fetcher: async () => { throw new Error("fresh cache should not revalidate"); } });
    assert.equal((await saved.readResource(url, "json")).data.name, "updated");
  }
});

test("invalid mutable JSON cannot replace a good style/index; versioned SDK manifests do not expire", async () => {
  const s = platform({ mutableMaxAgeMs: 0 });
  for (const path of ["/styles/liberty", "/planet"]) {
    const url = `${base}${path}`;
    await s.controller.readResource(url, "json");
    const damagedRefresh = createEarthResourceCache({ ...s.environment, fetcher: async () => new Response('{"wrong":"schema"}') });
    assert.equal((await damagedRefresh.readResource(url, "json")).data.name, url);
    assert.equal(damagedRefresh.getSnapshot().failed, 0);
    assert.equal(damagedRefresh.getSnapshot().cacheHits, 1);
  }
  const url = "/vendor/maplibre-gl-6.15.0/manifest.json";
  await s.controller.readResource(url, "json");
  const offline = createEarthResourceCache({ ...s.environment, fetcher: async () => { throw new Error("immutable SDK manifest should not revalidate"); } });
  assert.equal((await offline.readResource(url, "json")).data.name, "https://zhiv.test" + url);
  assert.equal(offline.getSnapshot().cacheHits, 1);
  assert.equal(offline.getSnapshot().failed, 0);
});

test("a stale-cache refresh timeout falls back promptly without retrying a usable resource", async () => {
  const s = platform({ mutableMaxAgeMs: 0 });
  const url = `${base}/styles/liberty`;
  await s.controller.readResource(url, "json");
  let calls = 0;
  const slow = createEarthResourceCache({ ...s.environment, attempts: 2, timeoutMs: 5, fetcher: async () => { calls += 1; return new Promise(() => {}); } });
  assert.equal((await slow.readResource(url, "json")).data.name, url);
  assert.equal(calls, 1);
  assert.equal(slow.getSnapshot().failed, 0);
  assert.equal(slow.getSnapshot().completed, 1);
  assert.equal(slow.getSnapshot().cacheHits, 1);
});

test("tile churn protects the active installed SDK while keeping byte and entry limits", async () => {
  const s = platform({ maxEntries: 3, maxBytes: 12, fetcher: async () => new Response("data") });
  const sdk = "https://zhiv.test/vendor/maplibre-gl-6.15.0/";
  await s.controller.readResource(sdk + "maplibre-gl.mjs", "string");
  await s.controller.readResource(sdk + "maplibre-gl-worker.mjs", "string");
  for (const index of [0, 1, 2, 3]) await s.controller.readResource(`${base}/tile${index}`, "string");
  assert.equal(s.cache.records.size, 3);
  assert.equal(s.controller.getSnapshot().storedBytes, 12);
  assert.ok(s.cache.records.has(sdk + "maplibre-gl.mjs"));
  assert.ok(s.cache.records.has(sdk + "maplibre-gl-worker.mjs"));
  assert.ok(s.cache.records.has(`${base}/tile3`));
  const offline = createEarthResourceCache({ ...s.environment, fetcher: async () => { throw new Error("SDK should survive tile churn"); } });
  assert.equal((await offline.readResource(sdk + "maplibre-gl.mjs", "string")).data, "data");
  assert.equal((await offline.readResource(sdk + "maplibre-gl-worker.mjs", "string")).data, "data");
});

test("a full pinned SDK falls back to session tiles and a new SDK group can replace the old version", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const s = platform({ maxEntries: 2, maxBytes: 8, fetcher: async () => new Response("data") });
  const prior = "https://zhiv.test/vendor/maplibre-gl-6.14.0/maplibre-gl.mjs";
  const current = "https://zhiv.test/vendor/maplibre-gl-6.15.0/maplibre-gl.mjs";
  const worker = "https://zhiv.test/vendor/maplibre-gl-6.15.0/maplibre-gl-worker.mjs";
  await s.controller.readResource(prior, "string");
  await s.controller.readResource(current, "string");
  await s.controller.readResource(worker, "string");
  assert.equal(s.cache.records.has(prior), false);
  assert.equal(s.cache.records.has(current), true);
  assert.equal(s.cache.records.has(worker), true);
  // The session tile is newer than the pinned SDK, even on a fast test runner.
  now += 1;
  await s.controller.readResource(`${base}/overflow`, "string");
  assert.equal(s.cache.records.size, 2);
  assert.equal(s.controller.getSnapshot().storedBytes, 8);
  assert.equal(s.cache.records.has(`${base}/overflow`), false);
  assert.equal((await s.controller.readResource(`${base}/overflow`, "string")).data, "data");
  assert.equal(s.controller.getSnapshot().cacheHits, 1);
  assert.equal(s.controller.getSnapshot().storageIssue, "resource-too-large");
});

test("failed physical invalidation cannot resurrect a poisoned disk response", async () => {
  for (const explicit of [true, false]) {
    const s = platform();
    const url = `${base}/styles/liberty`;
    await s.controller.readResource(url, "json");
    const previous = s.cache.records.get(url);
    const bytes = await previous.clone().arrayBuffer();
    s.cache.records.set(url, new Response("!".repeat(bytes.byteLength), { headers: previous.headers }));
    s.cache.deleteError = new Error("disk deletion failed");
    const repaired = createEarthResourceCache(s.environment);
    await repaired.initialize();
    if (explicit) await repaired.invalidate(url);
    assert.equal((await repaired.readResource(url, "json")).data.name, url);
    assert.equal((await repaired.readResource(url, "json")).data.name, url);
    assert.equal(s.calls.length, 2);
    assert.equal(repaired.getSnapshot().cacheHits, 1);
    assert.equal(repaired.getSnapshot().storage, "session");
    assert.equal(repaired.getSnapshot().storageIssue, "write-failed");
    assert.equal(repaired.getSnapshot().failed, 0);
    assert.match(await s.cache.records.get(url).clone().text(), /^!+$/);
  }
});

test("a timed-out tile yields its network slot to other visible tiles before retrying", async () => {
  const fetched = [];
  const s = platform({ concurrency: 1, attempts: 2, timeoutMs: 10, fetcher: async url => {
    fetched.push(url);
    if (fetched.length === 1) return new Promise(() => {});
    return new Response("ready");
  } });
  const slow = s.controller.readResource(`${base}/slow`, "string");
  const visible = s.controller.readResource(`${base}/visible`, "string");
  assert.deepEqual((await Promise.all([slow, visible])).map(item => item.data), ["ready", "ready"]);
  assert.deepEqual(fetched, [`${base}/slow`, `${base}/visible`, `${base}/slow`]);
  assert.equal(s.controller.getSnapshot().failed, 0);
  assert.equal(s.controller.getSnapshot().pending, 0);
});

test("a synchronous cancellation during progress notification never fetches the abandoned tile", async () => {
  const s = platform();
  await s.controller.initialize();
  const abort = new AbortController();
  const unsubscribe = s.controller.subscribe(() => {
    if (s.controller.getSnapshot().pending) abort.abort();
  });
  await assert.rejects(s.controller.readResource(`${base}/abandoned`, "string", abort.signal), { name: "AbortError" });
  unsubscribe();
  await tick();
  assert.equal(s.calls.length, 0);
  assert.equal(s.controller.getSnapshot().pending, 0);
  assert.equal(s.controller.getSnapshot().failed, 0);
  assert.equal((await s.controller.readResource(`${base}/abandoned`, "json")).data.name, `${base}/abandoned`);
});

test("stalled cache open, inventory, lookup and body reads fall back to usable session data", async () => {
  for (const operation of ["open", "keys", "match", "body"]) {
    const s = platform({ storageTimeoutMs: 10 });
    if (operation === "open") s.environment.cacheStorage.open = async () => new Promise(() => {});
    if (operation === "keys") s.cache.keys = async () => new Promise(() => {});
    if (operation === "match" || operation === "body") {
      await s.controller.initialize();
      s.cache.match = operation === "match" ? async () => new Promise(() => {}) : async () => {
        return new Response(new ReadableStream({ start() { /* The actual body read never settles. */ } }));
      };
    }
    const url = `${base}/recovered-${operation}`;
    assert.equal((await s.controller.readResource(url, "json")).data.name, url);
    assert.equal((await s.controller.readResource(url, "json")).data.name, url);
    assert.equal(s.controller.getSnapshot().storage, "session", operation);
    assert.equal(s.controller.getSnapshot().storageIssue, "unavailable", operation);
    assert.equal(s.controller.getSnapshot().pending, 0, operation);
    assert.equal(s.controller.getSnapshot().failed, 0, operation);
    assert.equal(s.calls.length, 1, operation);
  }
});

test("a blocked disk write releases downloaded tiles and all queued writes within the storage deadline", async () => {
  const s = platform({ storageTimeoutMs: 10, fetcher: async url => new Response(url.slice(-1)) });
  let attemptedWrites = 0;
  let finishWrite;
  s.cache.put = async () => {
    attemptedWrites += 1;
    await new Promise(resolve => { finishWrite = resolve; });
  };
  const values = await Promise.all([0, 1, 2, 3, 4].map(index => s.controller.readResource(`${base}/tile${index}`, "string")));
  assert.deepEqual(values.map(value => value.data), ["0", "1", "2", "3", "4"]);
  assert.equal(attemptedWrites, 1);
  assert.equal(s.controller.getSnapshot().storage, "session");
  assert.equal(s.controller.getSnapshot().pending, 0);
  assert.equal(s.controller.getSnapshot().failed, 0);
  assert.equal(s.controller.getSnapshot().completed, 5);
  assert.equal((await s.controller.readResource(`${base}/tile0`, "string")).data, "0");
  finishWrite();
  await tick();
  assert.equal(s.controller.getSnapshot().storedEntries, 0, "late disk completion must not claim a successful installation");
});

test("optional storage policy APIs cannot indefinitely hold installation or persistence controls", async () => {
  const s = platform({ storageTimeoutMs: 5, storageManager: {
    async persisted() { return new Promise(() => {}); },
    async estimate() { return new Promise(() => {}); },
    async persist() { return new Promise(() => {}); },
  } });
  await s.controller.readResource(`${base}/saved`, "json");
  await s.controller.requestPersistence();
  assert.equal(s.controller.getSnapshot().storage, "device");
  assert.equal(s.controller.getSnapshot().persistence, "best-effort");
  assert.equal(s.controller.getSnapshot().pending, 0);
  assert.equal(s.controller.getSnapshot().storedEntries, 1);
});

test("revisited tiles use bounded memory before disk while a reload still reads persistent data", async () => {
  const s = platform();
  let lookups = 0;
  const match = s.cache.match.bind(s.cache);
  s.cache.match = async key => { lookups += 1; return match(key); };
  const url = `${base}/frequent`;
  await s.controller.readResource(url, "json");
  assert.equal(lookups, 1);
  await s.controller.readResource(url, "json");
  assert.equal(lookups, 1, "freshly saved tiles are retained in the bounded memory cache");
  const reloaded = createEarthResourceCache(s.environment);
  await reloaded.initialize();
  const beforeRead = lookups;
  await reloaded.readResource(url, "json");
  await reloaded.readResource(url, "json");
  assert.equal(lookups, beforeRead + 1, "disk-hit tiles are retained for immediate rotations back");
  assert.equal(s.calls.length, 1);
  assert.equal(reloaded.getSnapshot().cacheHits, 2);
});

test("frequent visited detail survives a scan of one-off distant tiles within disk and memory caps", async () => {
  const s = platform({ maxEntries: 2, maxBytes: 8, fetcher: async () => new Response(new Uint8Array([10, 1, 0])) });
  const frequent = `${base}/planet/dated/10/512/512.pbf`;
  for (let i = 0; i < 5; i++) await s.controller.readResource(frequent);
  for (let i = 0; i < 20; i++) {
    await s.controller.readResource(`${base}/planet/dated/14/${i}/0.pbf`);
    const snapshot = s.controller.getSnapshot();
    assert.ok(snapshot.storedEntries <= 2);
    assert.ok(snapshot.storedBytes <= 8);
    assert.ok(snapshot.memoryEntries <= 2);
    assert.ok(snapshot.memoryBytes <= 8);
    assert.equal(s.cache.records.has(frequent), true);
  }
  assert.equal(s.opened.length, 1);
});

test("current viewport admits nearby detail while unrelated once-read detail can be skipped", async () => {
  const s = platform({ maxEntries: 1, maxBytes: 8, fetcher: async () => new Response(new Uint8Array([10, 1, 0])) });
  const local = `${base}/planet/dated/10/512/512.pbf`, distant = `${base}/planet/dated/10/20/20.pbf`;
  s.controller.setView({ longitude: 0, latitude: 0, zoom: 10 });
  await s.controller.readResource(local);
  await s.controller.readResource(distant);
  assert.equal(s.cache.records.has(local), true);
  assert.equal(s.cache.records.has(distant), false);
  s.controller.setView({ longitude: -172.8, latitude: 84.3, zoom: 10 });
  await s.controller.readResource(distant);
  assert.equal(s.cache.records.has(distant), true);
  assert.equal(s.cache.records.size, 1);
  assert.equal(s.controller.getSnapshot().storageIssue, null);
});

test("slow disk keeps completed bodies inside the same global slots instead of building an unbounded write queue", async () => {
  const releases = [], fetched = [];
  const s = platform({ concurrency: 2, storageTimeoutMs: 1000, fetcher: async url => { fetched.push(url); return new Response("tile"); } });
  const put = s.cache.put.bind(s.cache);
  s.cache.put = async (...args) => { await new Promise(resolve => releases.push(resolve)); return put(...args); };
  const requests = [0, 1, 2, 3].map(i => s.controller.readResource(`${base}/slow-disk-${i}`, "string"));
  await tick(); await tick();
  assert.equal(fetched.length, 2, "only two bodies can wait for disk at once");
  while (s.controller.getSnapshot().pending) {
    for (const release of releases.splice(0)) release();
    await tick();
  }
  assert.equal((await Promise.all(requests)).length, 4);
  assert.ok(s.controller.getSnapshot().memoryBytes <= s.controller.getBudgets().memoryBytes);
});

test("pending job count is globally bounded and duplicate consumers still share a full queue", async () => {
  let finish, calls = 0;
  const s = platform({ concurrency: 1, fetcher: async () => { calls++; await new Promise(resolve => { finish = resolve; }); return new Response("ok"); } });
  const owner = new AbortController();
  const pending = Array.from({ length: s.controller.getBudgets().pendingEntries }, (_, i) => s.controller.readResource(`${base}/bounded-${i}`, "string", owner.signal));
  const settled = Promise.allSettled(pending);
  await tick();
  await assert.rejects(s.controller.readResource(`${base}/overflow`, "string"), /queue is full/);
  const shared = s.controller.readResource(`${base}/bounded-0`, "string");
  owner.abort();
  finish();
  assert.equal((await shared).data, "ok");
  await settled;
  assert.equal(calls, 1);
  assert.equal(s.controller.getSnapshot().pending, 0);
});

test("streamed bodies stop at the resource budget before aggregation even without Content-Length", async () => {
  let cancelled = false, pulled = 0;
  const s = platform({ fetcher: async () => new Response(new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(s.controller.readResource(`${base}/oversized-stream`, "string"), /size limit/);
  assert.equal(cancelled, true);
  assert.ok(pulled <= s.controller.getBudgets().resourceBytes / (1024 * 1024) + 2);
  assert.equal(s.controller.getSnapshot().memoryBytes, 0);
  assert.equal(s.cache.records.size, 0);
});

test("origin-wide cache locks reconcile concurrent controllers before enforcing shared byte and entry limits", async () => {
  class SharedLocks {
    tail = Promise.resolve();
    active = 0;
    peak = 0;
    request(name, options, callback) {
      assert.equal(name, EARTH_CACHE_NAME);
      assert.equal(options.mode, "exclusive");
      const result = this.tail.then(async () => {
        if (options.signal.aborted) throw new DOMException("cancelled", "AbortError");
        this.active++;
        this.peak = Math.max(this.peak, this.active);
        try { return await callback({ name }); }
        finally { this.active--; }
      });
      this.tail = result.catch(() => undefined);
      return result;
    }
  }
  const locks = new SharedLocks();
  const s = platform({ maxEntries: 2, maxBytes: 8, lockManager: locks, fetcher: async () => new Response("data") });
  const other = createEarthResourceCache(s.environment);
  await Promise.all([s.controller.initialize(), other.initialize()]);
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? other : s.controller).readResource(`${base}/shared-${i}`, "string")));
  assert.equal(locks.peak, 1);
  assert.ok(s.cache.records.size <= 2);
  const bytes = await Promise.all([...s.cache.records.values()].map(async value => (await value.clone().arrayBuffer()).byteLength));
  assert.ok(bytes.reduce((sum, value) => sum + value, 0) <= 8);
  assert.deepEqual(s.opened, [EARTH_CACHE_NAME, EARTH_CACHE_NAME]);
});

test("without Web Locks old device data stays readable but new resources use only bounded RAM", async () => {
  const s = platform();
  const old = `${base}/old-persistent`, added = `${base}/new-readonly`;
  await s.controller.readResource(old, "json");
  const writes = s.cache.writes;
  const readonly = createEarthResourceCache({ ...s.environment, lockManager: null });
  await readonly.readResource(old, "json");
  await readonly.readResource(added, "json");
  await readonly.readResource(added, "json");
  assert.equal(readonly.getSnapshot().storage, "session");
  assert.equal(readonly.getSnapshot().cacheHits, 2);
  assert.equal(s.cache.writes, writes);
  assert.equal(s.cache.records.has(added), false);
});

test("a canceled queued lock cannot later mutate storage even if a broken lock provider invokes it", async () => {
  let queued;
  const s = platform({ storageTimeoutMs: 5, lockManager: { request(_name, _options, callback) { queued = callback; return new Promise(() => {}); } } });
  assert.equal((await s.controller.readResource(`${base}/lock-timeout`, "json")).data.name, `${base}/lock-timeout`);
  assert.equal(s.controller.getSnapshot().storage, "session");
  await assert.rejects(queued(), /lock timed out/);
  assert.equal(s.cache.writes, 0);
});

test("a timed-out physical put retains its origin writer lock until native storage actually settles", async () => {
  let held = false, finish;
  const lockManager = { async request(_name, _options, callback) { held = true; try { return await callback(); } finally { held = false; } } };
  const s = platform({ storageTimeoutMs: 5, lockManager, fetcher: async () => new Response("body") });
  const put = s.cache.put.bind(s.cache);
  s.cache.put = async (...args) => { await new Promise(resolve => { finish = resolve; }); return put(...args); };
  assert.equal((await s.controller.readResource(`${base}/late-write`, "string")).data, "body");
  assert.equal(s.controller.getSnapshot().storage, "session");
  assert.equal(held, true, "a different tab cannot race the outstanding native commit");
  finish();
  await tick(); await tick();
  assert.equal(held, false);
  assert.equal(s.cache.records.size, 1);
  assert.equal(s.controller.getSnapshot().storedEntries, 0, "late completion must not claim installation success");
});

test("a stalled disk body still falls back to network while another timed-out physical put holds the writer lock", async () => {
  const s = platform({ concurrency: 2, storageTimeoutMs: 5, fetcher: async url => new Response(url.endsWith('b') ? 'fresh-b' : 'fresh-a') });
  await s.controller.initialize();
  const match = s.cache.match.bind(s.cache);
  s.cache.match = async key => String(key).endsWith('b') ? new Response(new ReadableStream({ start() {} })) : match(key);
  let finish;
  s.cache.put = async () => { await new Promise(resolve => { finish = resolve; }); };
  const a = s.controller.readResource(`${base}/blocked-a`, "string");
  const b = s.controller.readResource(`${base}/blocked-b`, "string");
  try {
    assert.deepEqual((await Promise.all([a, b])).map(result => result.data), ['fresh-a', 'fresh-b']);
    assert.equal(s.controller.getSnapshot().pending, 0);
    assert.equal(s.controller.getSnapshot().failed, 0);
  } finally { finish?.(); await tick(); }
});
