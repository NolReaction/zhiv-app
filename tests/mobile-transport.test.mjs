import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { createMobileApiTransport, mobileApiPath } = await vite.ssrLoadModule("/apps/mobile/src/mobile-api-transport.ts");
const { parseMobileConnect, restoreMobileConnect, verifiedMobileCallback } = await vite.ssrLoadModule("/features/account/mobile-connect-state.ts");
after(() => vite.close());

const origin = "https://im-alive.ru";
const encoded = value => Buffer.from(value).toString("base64");
const reply = (status = 200, body = '{"ok":true}') => ({ status, body: encoded(body), headers: { "content-type": "application/json" } });
function setup(overrides = {}, options = {}) {
  const requests = [], cancelled = [];
  const port = { getState: async () => ({ authenticated: true, userId: "owner-a" }),
    request: async value => { requests.push(value); return reply(); },
    cancelRequest: async value => { cancelled.push(value); }, ...overrides };
  return { requests, cancelled, fetch: createMobileApiTransport(port, { origin, uuid: () => "request-1", ...options }) };
}

test("mobile transport preserves JSON bytes, game headers and owner while stripping browser secrets", async () => {
  const { fetch, requests } = setup();
  const response = await fetch("/api/v1/world/commands", { method: "POST", headers: { "Content-Type": "application/json", "X-Game-Generation": "3", Authorization: "browser-secret", Cookie: "session=wrong" }, body: JSON.stringify({ label: "Мохлик 🌲" }) });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.path, "/api/v1/world/commands");
  assert.equal(request.expectedUserId, "owner-a");
  assert.equal(request.headers["x-game-generation"], "3");
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers.cookie, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(request.body, "base64").toString()), { label: "Мохлик 🌲" });
});

test("only canonical same-server API URLs reach the native bridge", () => {
  assert.equal(mobileApiPath("/api/v1/earth/weather?lat=1&lng=2", origin), "/api/v1/earth/weather?lat=1&lng=2");
  assert.equal(mobileApiPath(`${origin}/api/v1/me`, origin), "/api/v1/me");
  for (const path of ["https://evil.test/api/v1/me", "/api/v1/../../admin", "/api/v1/%2e%2e/admin", "/api/v1/%2Fadmin", "/api/v1/%252e%252e/admin", "/api/v1/me%0d", "/api/v1/auth/mobile/exchange", "/api/v1/me#secret", "/api/v1/me\\x", "/api/dev/boat-garage", "https://user:password@im-alive.ru/api/v1/me"]) {
    assert.throws(() => mobileApiPath(path, origin), TypeError, path);
  }
});

test("native transport awaits durable preparation and acknowledgement", async () => {
  const order = [];
  const { fetch } = setup({ request: async () => { order.push("network"); return reply(); } }, {
    prepare: async request => {
      assert.equal(request.userId, "owner-a"); order.push("persist");
      return { settle: async status => { assert.equal(status, 200); order.push("ack"); } };
    },
  });
  await fetch("/api/v1/economy/commands", { method: "POST", body: "{}" });
  assert.deepEqual(order, ["persist", "network", "ack"]);
});

test("durability failure prevents dispatch; lost responses leave receipt for reconciliation", async () => {
  const failed = setup({}, { prepare: async () => { throw new Error("disk full"); } });
  await assert.rejects(failed.fetch("/api/v1/economy/commands", { method: "POST", body: "{}" }), /disk full/);
  assert.equal(failed.requests.length, 0);
  let acknowledged = false;
  const lost = setup({ request: async () => { throw new Error("offline"); } }, {
    prepare: async () => ({ settle: async () => { acknowledged = true; } }),
  });
  await assert.rejects(lost.fetch("/api/v1/economy/commands"), /offline/);
  assert.equal(acknowledged, false);
});

test("failed local receipt deletion cannot overwrite successful server outcome", async () => {
  const { fetch } = setup({}, { prepare: async () => ({ settle: async () => { throw new Error("disk"); } }) });
  assert.equal((await fetch("/api/v1/me")).status, 200);
});

test("abort cancels native task and late completion cannot settle request", async () => {
  let complete, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { fetch, cancelled } = setup({ request: () => { started(); return new Promise(resolve => { complete = resolve; }); } });
  const controller = new AbortController();
  const pending = fetch("/api/v1/me", { signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  complete(reply());
  assert.deepEqual(cancelled, [{ id: "request-1" }]);
});

test("already-aborted requests never enter native storage or transport", async () => {
  const controller = new AbortController(); controller.abort();
  const { fetch, requests } = setup({ getState: async () => { throw new Error("must not read session"); } });
  await assert.rejects(fetch("/api/v1/me", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(requests.length, 0);
});

test("account switch while native state or durable preparation is pending cannot send old action", async () => {
  for (const phase of ["state", "storage"]) {
    let snapshot = { phase: "authenticated", userId: "owner-a", generation: 1 };
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const { fetch, requests } = setup({ getState: async () => {
      if (phase === "state") await wait();
      return { authenticated: true, userId: "owner-a" };
    } }, { session: () => snapshot, prepare: async () => {
      if (phase === "storage") await wait();
      return { settle: async () => {} };
    } });
    const result = fetch("/api/v1/economy/commands", { method: "POST", body: "{}" });
    await ready;
    snapshot = { phase: "authenticated", userId: "owner-b", generation: 2 };
    release();
    await assert.rejects(result, { name: "AbortError" });
    assert.equal(requests.length, 0);
  }
});

test("204 and error statuses preserve HTTP behavior and discard cookie headers", async () => {
  for (const status of [204, 401, 429, 503]) {
    const { fetch } = setup({ request: async () => ({ ...reply(status), headers: { "set-cookie": "secret", "retry-after": "15" } }) });
    const result = await fetch("/api/v1/me");
    assert.equal(result.status, status); assert.equal(result.headers.has("set-cookie"), false);
    assert.equal(result.headers.get("retry-after"), "15");
    if (status === 204) assert.equal(await result.text(), "");
  }
});

test("multipart uploads preserve boundary and binary bytes", async () => {
  const { fetch, requests } = setup();
  const form = new FormData(); form.append("file", new Blob([new Uint8Array([0, 1, 128, 255])]), "sample.bin");
  await fetch("/api/v1/feedback", { method: "POST", body: form });
  const request = requests[0];
  assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
  const parsed = await new Response(Buffer.from(request.body, "base64"), { headers: request.headers }).formData();
  assert.deepEqual(new Uint8Array(await parsed.get("file").arrayBuffer()), new Uint8Array([0, 1, 128, 255]));
});

test("supported WebViews without randomUUID use cryptographic UUID fallback", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const original = globalThis.crypto;
  let request;
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: original.getRandomValues.bind(original) } });
    const fetch = createMobileApiTransport({ getState: async () => ({ authenticated: false }),
      request: async value => { request = value; return reply(); }, cancelRequest: async () => {} }, { origin });
    await fetch("/api/v1/me");
    assert.match(request.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { Object.defineProperty(globalThis, "crypto", descriptor); }
});

const state = "s".repeat(43), challenge = "c".repeat(43), code = "a".repeat(43);
const query = `?challenge=${challenge}&state=${state}&platform=ios`;
test("web handoff restoration accepts only recent local valid attempts", () => {
  assert.deepEqual(parseMobileConnect(query), { challenge, state, platform: "ios" });
  assert.equal(parseMobileConnect(`${query}&state=${state}`), null);
  assert.equal(parseMobileConnect(query.replace("platform=ios", "platform=web")), null);
  const record = { at: 1_000, path: `/mobile/connect${query}` };
  assert.equal(restoreMobileConnect(JSON.stringify(record), 2_000), record.path);
  assert.equal(restoreMobileConnect(JSON.stringify(record), 1_000_000), null);
  assert.equal(restoreMobileConnect(JSON.stringify(record), 0), null);
  assert.equal(restoreMobileConnect(JSON.stringify({ ...record, path: `https://evil.test${record.path}` }), 2_000), null);
});

test("callback URL must match exact native scheme, host, path, state and single code", () => {
  const callback = `ru.zhiv.mochlik.lab://auth/callback?code=${code}&state=${state}`;
  assert.equal(verifiedMobileCallback(callback, state), callback);
  for (const value of [callback.replace("auth/callback", "evil/callback"), callback.replace("lab:", "lab-evil:"), `${callback}&code=${code}`, `${callback}#x`, callback.replace(code, "short"), `${callback}&redirect=https://evil.test`]) {
    assert.equal(verifiedMobileCallback(value, state), null, value);
  }
  assert.equal(verifiedMobileCallback(callback, "other"), null);
});
