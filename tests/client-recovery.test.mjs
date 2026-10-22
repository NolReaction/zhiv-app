import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const origin = "https://zhiv.example";
const validStatus = { schemaVersion: 1, maintenance: false, buildId: "release-123" };
const privateIdentity = "PRIVATE-ID-DO-NOT-DISPLAY";
const privateName = "PRIVATE-NAME-DO-NOT-DISPLAY";
const requestId = "10000000-0000-4000-8000-000000000001";
const now = "2026-10-22T03:00:00Z";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...headers },
});
const flush = () => new Promise(resolve => setImmediate(resolve));

async function harness(options = {}) {
  const source = await readFile(new URL("../public/recover.js", import.meta.url), "utf8");
  const calls = { fetch: [], cacheKeys: 0, deleted: [], update: 0, registration: [], navigated: [] };
  const elements = new Map();
  for (const id of ["recover-button", "diagnostics-button", "recovery-status", "diagnostics-output"]) {
    const listeners = new Map();
    elements.set(id, { textContent: "", disabled: false, hidden: false, listeners,
      addEventListener(type, listener) { listeners.set(type, listener); },
      setAttribute() {}, removeAttribute() {}, focus() {},
    });
  }
  const document = { getElementById: id => elements.get(id) };
  Object.defineProperty(document, "cookie", { get() { assert.fail("Recovery must not read cookies"); },
    set() { assert.fail("Recovery must not modify cookies"); } });
  const input = new URL(options.url ?? `${origin}/recover.html?invite=kept&owner=kept&__zhiv_recovery=old#kept`);
  const location = { href: input.href, origin: input.origin, search: input.search, hash: input.hash,
    replace(value) { calls.navigated.push(String(value)); },
  };
  const timers = new Map(); let timerId = 0;
  const registration = {
    async update() { calls.update++; return options.update ? options.update() : undefined; },
    unregister() { assert.fail("Recovery must retain the push/service-worker registration"); },
  };
  const navigator = { onLine: options.online ?? true,
    ...(options.noServiceWorker ? {} : { serviceWorker: { async getRegistration(scope) {
      calls.registration.push(scope);
      return options.getRegistration ? options.getRegistration() : registration;
    } } }),
  };
  const caches = options.noCaches ? undefined : {
    async keys() { calls.cacheKeys++; if (options.keysError) throw options.keysError;
      if (options.keys) return options.keys();
      return options.cacheNames ?? ["zhiv-shell-old", "zhiv-shell-current", "zhiv-assets-v1", "zhiv-meta-v1", "other-app", "zhiv-assets-v2", "other-zhiv-shell-x"]; },
    async delete(name) { calls.deleted.push(name); if (options.deleteError) throw options.deleteError; return true; },
  };
  const context = { document, navigator, location, caches, URL, AbortController, Response, Headers,
    fetch: async (request, init) => {
      const url = new URL(typeof request === "string" ? request : request.url, origin);
      calls.fetch.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      if (url.pathname === "/app-status.json") return json(validStatus);
      throw new Error(`Unexpected request ${url.pathname}`);
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  for (const key of ["localStorage", "sessionStorage", "indexedDB"]) Object.defineProperty(context, key, {
    get() { assert.fail(`Recovery must not access ${key}`); },
  });
  context.window = context;
  vm.runInNewContext(source, context, { filename: "recover.js" });
  return { calls, elements, timers,
    async click(id = "recover-button") {
      const handler = elements.get(id).listeners.get("click");
      assert.ok(handler, `${id} should have a click handler`);
      const result = handler({ preventDefault() {} });
      await result; await flush();
    },
    async expireNextTimer() {
      await flush();
      const entry = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
      assert.ok(entry, "Expected a bounded operation timer");
      timers.delete(entry[0]); entry[1].callback(); await flush();
    },
  };
}

test("standalone recovery waits for a user action and retains cookies and all account/game storage", async () => {
  const f = await harness();
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.cacheKeys, 0);
  assert.equal(f.calls.update, 0);
  assert.equal(f.calls.navigated.length, 0);
  await f.click();
  assert.deepEqual(f.calls.deleted.sort(), ["zhiv-assets-v1", "zhiv-meta-v1", "zhiv-shell-current", "zhiv-shell-old"]);
  assert.deepEqual(f.calls.registration, ["/"]);
  assert.equal(f.calls.update, 1);
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.calls.fetch[0].url.pathname, "/app-status.json");
  assert.equal(f.calls.fetch[0].init.cache, "no-store");
  assert.equal(f.calls.fetch[0].init.credentials, "same-origin");
  assert.equal(f.calls.navigated.length, 1);
  const target = new URL(f.calls.navigated[0]);
  assert.equal(target.origin, origin);
  assert.equal(target.pathname, "/");
  assert.equal(target.searchParams.get("owner"), "kept");
  assert.equal(target.searchParams.get("invite"), "kept");
  assert.equal(target.hash, "#kept");
  assert.equal(target.searchParams.getAll("__zhiv_recovery").length, 1);
  assert.notEqual(target.searchParams.get("__zhiv_recovery"), "old");
});

for (const [name, fetch] of [
  ["offline", async () => { throw new TypeError("offline"); }],
  ["maintenance", async () => json({ ...validStatus, maintenance: true })],
  ["invalid JSON shape", async () => json({})],
  ["HTTP failure", async () => json({ code: "UNAVAILABLE" }, 503)],
]) test(`recovery does not erase the offline cache or navigate on ${name}`, async () => {
  const f = await harness({ fetch }); await f.click();
  assert.equal(f.calls.cacheKeys, 0);
  assert.deepEqual(f.calls.deleted, []);
  assert.deepEqual(f.calls.navigated, []);
  assert.equal(f.elements.get("recover-button").disabled, false);
  assert.ok(f.elements.get("recovery-status").textContent.length > 0);
});

test("missing CacheStorage and service-worker support still permits a fresh network navigation", async () => {
  const f = await harness({ noCaches: true, noServiceWorker: true }); await f.click();
  assert.equal(f.calls.navigated.length, 1);
  assert.equal(f.calls.cacheKeys, 0);
  assert.equal(f.calls.update, 0);
});

for (const failure of ["keysError", "deleteError"]) test(`cache ${failure} is recoverable and cannot clear unrelated data`, async () => {
  const f = await harness({ [failure]: new Error("storage denied") }); await f.click();
  assert.deepEqual(f.calls.navigated, []);
  assert.equal(f.elements.get("recover-button").disabled, false);
  assert.ok(f.calls.deleted.every(name => name.startsWith("zhiv-shell-") || ["zhiv-assets-v1", "zhiv-meta-v1"].includes(name)));
});

test("service-worker update rejection is optional and preserves the registration", async () => {
  const f = await harness({ update: async () => { throw new Error("update failed"); } }); await f.click();
  assert.equal(f.calls.update, 1);
  assert.equal(f.calls.navigated.length, 1);
});

test("a hanging status request is bounded and leaves offline caches intact", async () => {
  const f = await harness({ fetch: () => new Promise(() => {}) });
  const pending = f.click(); await f.expireNextTimer(); await pending;
  assert.equal(f.calls.cacheKeys, 0);
  assert.deepEqual(f.calls.navigated, []);
  assert.equal(f.elements.get("recover-button").disabled, false);
});

test("a hanging service-worker update cannot hold recovery indefinitely", async () => {
  const f = await harness({ update: () => new Promise(() => {}) });
  const pending = f.click(); await f.expireNextTimer(); await pending;
  assert.equal(f.calls.update, 1);
  assert.equal(f.calls.navigated.length, 1);
});

test("a late CacheStorage listing cannot delete files after the operation timed out", async () => {
  let resolveKeys;
  const f = await harness({ keys: () => new Promise(resolve => { resolveKeys = resolve; }) });
  const pending = f.click(); await f.expireNextTimer(); await pending;
  assert.equal(f.calls.cacheKeys, 1);
  assert.deepEqual(f.calls.deleted, []);
  assert.deepEqual(f.calls.navigated, []);
  resolveKeys(["zhiv-shell-old", "zhiv-assets-v1"]); await flush();
  assert.deepEqual(f.calls.deleted, []);
  assert.equal(f.calls.update, 0);
  assert.deepEqual(f.calls.navigated, []);
});

test("a late service-worker lookup cannot begin an update after timeout and navigation", async () => {
  let resolveRegistration, updates = 0;
  const f = await harness({ getRegistration: () => new Promise(resolve => { resolveRegistration = resolve; }) });
  const pending = f.click(); await f.expireNextTimer(); await pending;
  assert.equal(f.calls.navigated.length, 1);
  resolveRegistration({ async update() { updates++; } }); await flush();
  assert.equal(updates, 0);
  assert.equal(f.calls.navigated.length, 1);
});

test("read-only diagnostics expose statuses, safe codes and request IDs without identity or response bodies", async () => {
  const f = await harness({ fetch: async url => {
    if (url.pathname === "/readyz") return json({ status: "ready" });
    if (url.pathname === "/app-status.json") return json(validStatus);
    if (url.pathname === "/api/v1/me") return json({ user: { publicId: privateIdentity, displayName: privateName },
      gameplayGeneration: 1, profile: {}, streak: {}, checkInCount: 0, serverTime: now });
    if (url.pathname === "/api/v1/world") return json({ ownerPublicId: privateIdentity, revision: 1, serverTime: now,
      state: { schemaVersion: 1, resources: {} }, catalogVersion: 1 });
    if (url.pathname === "/api/v1/economy") return json({ code: "DATABASE_BUSY", message: privateName }, 503, { "X-Request-ID": requestId });
    throw new Error("Unexpected endpoint");
  } });
  await f.click("diagnostics-button");
  assert.deepEqual(f.calls.fetch.map(call => call.url.pathname).sort(), ["/api/v1/economy", "/api/v1/me", "/api/v1/world", "/app-status.json", "/readyz"]);
  for (const call of f.calls.fetch) {
    assert.ok(!call.init.method || call.init.method === "GET");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.credentials, "same-origin");
    if (call.url.pathname.startsWith("/api/")) assert.equal(call.url.search, "", "API routes reject unexpected query parameters");
  }
  const output = f.elements.get("diagnostics-output").textContent;
  assert.ok(output.includes("503"));
  assert.ok(output.includes("DATABASE_BUSY"));
  assert.ok(output.includes(requestId));
  assert.ok(!output.includes(privateIdentity));
  assert.ok(!output.includes(privateName));
  assert.equal(f.calls.cacheKeys, 0);
  assert.equal(f.calls.update, 0);
  assert.deepEqual(f.calls.navigated, []);
});

test("diagnostics do not call a 200 response healthy when JSON is missing or malformed", async () => {
  const f = await harness({ fetch: async url => url.pathname === "/app-status.json" ? json(validStatus)
    : url.pathname === "/api/v1/world" ? new Response("not json", { headers: { "Content-Type": "application/json" } }) : json({}) });
  await f.click("diagnostics-button");
  const output = f.elements.get("diagnostics-output").textContent;
  const meLine = output.split("\n").find(line => line.includes("/api/v1/me"));
  assert.ok(meLine?.includes("200"));
  assert.match(meLine, /НЕВЕРНЫЙ/);
  assert.match(output.split("\n").find(line => line.includes("/api/v1/world")), /HTTP 200.*НЕВЕРНЫЙ/);
  assert.deepEqual(f.calls.navigated, []);
});

test("recovery HTML loads a separate script and provides accessible mobile controls without the game bundle", async () => {
  const html = await readFile(new URL("../public/recover.html", import.meta.url), "utf8");
  assert.match(html, /<html[^>]+lang="ru"/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<script[^>]+src="\/recover\.js(?:\?[^\"]*)?"/);
  assert.match(html, /id="recovery-status"[^>]+(?:aria-live|role)=/);
  assert.match(html, /id="diagnostics-output"/);
  assert.ok(!html.includes("/_next/"));
  assert.ok(!html.includes("localStorage.clear"));
});
