import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const incidents = await vite.ssrLoadModule("/lib/client-incidents.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let records;
const key = owner => `zhiv:incidents:v1:${owner}`;
const owner = () => crypto.randomUUID();
const stored = id => JSON.parse(records.get(key(id)) ?? "[]");
beforeEach(async () => {
  records = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: id => records.get(id) ?? null,
    setItem: (id, value) => records.set(id, value),
  } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
  await incidents.resolveStartupIncidents(null);
});
after(async () => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else delete globalThis.localStorage;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete globalThis.navigator;
  await vite.close();
});
const collect = t => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/v1/client-incidents");
    assert.equal(options.credentials, "same-origin");
    sent.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  });
  return sent;
};

test("caught startup failures wait for verified identity and preserve occurrence time without private payload", async t => {
  const sent = collect(t);
  const started = Date.now();
  incidents.reportStartupIncident(new TypeError("private URL, cookie and response contents"));
  incidents.reportStartupIncident(new TypeError("another private detail"));
  assert.equal(sent.length, 0);
  assert.equal(records.size, 0, "unknown-owner failures never persist");
  const id = owner();
  await incidents.resolveStartupIncidents(id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ownerPublicId, id);
  assert.equal(sent[0].operation, "page");
  assert.equal(sent[0].code, "NETWORK_ERROR");
  assert.equal(sent[0].occurrences, 2);
  assert.ok(Date.parse(sent[0].occurredAt) >= started);
  assert.doesNotMatch(JSON.stringify(sent), /private|cookie|response contents/);
  assert.deepEqual(stored(id), []);
});

test("confirmed signed-out response discards startup failures before another account signs in", async t => {
  const sent = collect(t);
  incidents.reportStartupIncident(new TypeError("unavailable"));
  await incidents.resolveStartupIncidents(null);
  await incidents.resolveStartupIncidents(owner());
  assert.equal(sent.length, 0);
});

test("request deadlines classify both AbortError and TimeoutError; server-only codes map to accepted client codes", () => {
  assert.equal(incidents.incidentCode(new DOMException("deadline", "TimeoutError")), "TIMEOUT");
  assert.equal(incidents.incidentCode(new DOMException("deadline", "AbortError")), "TIMEOUT");
  for (const code of ["DATABASE_BUSY", "INTERNAL_ERROR"])
    assert.equal(incidents.incidentCode(new ApiError("unavailable", 503, { code, message: "unavailable" })), "SERVER_ERROR");
});

test("old server-only codes and unsafe stored fields cannot poison the queue or leak payloads", async t => {
  const sent = collect(t), id = owner();
  records.set(key(id), JSON.stringify([null, 3, { code: "constructor" }, {
    eventId: crypto.randomUUID(), ownerPublicId: id, operation: "page", code: "DATABASE_BUSY",
    occurredAt: new Date().toISOString(), pendingTaps: -2, occurrences: null,
    requestId: "https://private.example/?token=secret", httpStatus: 0,
    message: "private user response", token: "secret",
  }]));
  await incidents.flushIncidents(id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].code, "SERVER_ERROR");
  assert.equal(sent[0].pendingTaps, 0);
  assert.equal(sent[0].occurrences, 1);
  assert.doesNotMatch(JSON.stringify(sent), /secret|private|requestId|httpStatus|message/);
});

test("denied storage retains current-tab diagnostics until delivery", async t => {
  const sent = collect(t), id = owner();
  t.mock.method(localStorage, "getItem", () => { throw new DOMException("denied", "SecurityError"); });
  t.mock.method(localStorage, "setItem", () => { throw new DOMException("denied", "SecurityError"); });
  incidents.reportIncident(id, "page", "NETWORK_ERROR");
  await incidents.flushIncidents(id);
  await incidents.flushIncidents(id);
  assert.equal(sent.length, 1, "successful reports are removed even without localStorage");
});

test("storage quota failures do not replace the new in-memory event with an older persisted snapshot", async t => {
  const sent = collect(t), id = owner();
  incidents.reportIncident(id, "page", "NETWORK_ERROR");
  t.mock.method(localStorage, "setItem", () => { throw new DOMException("full", "QuotaExceededError"); });
  incidents.reportIncident(id, "world", "TIMEOUT");
  await incidents.flushIncidents(id);
  assert.deepEqual(sent.map(item => item.code), ["NETWORK_ERROR", "TIMEOUT"]);
});

test("known permanent INVALID_INCIDENT rejection skips only that record and lets later reports through", async t => {
  const sent = [], id = owner();
  incidents.reportIncident(id, "page", "NETWORK_ERROR");
  incidents.reportIncident(id, "world", "TIMEOUT");
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return sent.length === 1 ? Response.json({ code: "INVALID_INCIDENT" }, { status: 400 }) : new Response(null, { status: 204 });
  });
  await incidents.flushIncidents(id);
  assert.equal(sent.length, 2);
  assert.deepEqual(stored(id), []);
});

test("auth errors, unknown 400 errors and lost responses retain reports for recovery", async t => {
  for (const response of [
    () => new Response(null, { status: 401 }),
    () => new Response(null, { status: 403 }),
    () => Response.json({ code: "OTHER_ERROR" }, { status: 400 }),
    () => { throw new TypeError("network unavailable"); },
  ]) {
    const id = owner();
    incidents.reportIncident(id, "page", "NETWORK_ERROR");
    const mock = t.mock.method(globalThis, "fetch", response);
    await incidents.flushIncidents(id);
    assert.equal(stored(id).length, 1);
    mock.mock.restore();
  }
});

test("a repeated error arriving while its predecessor is being sent survives the acknowledgement", async t => {
  const id = owner();
  incidents.reportIncident(id, "page", "NETWORK_ERROR");
  let finish;
  const sent = [];
  t.mock.method(globalThis, "fetch", (_url, options) => {
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) return new Promise(resolve => { finish = () => resolve(new Response(null, { status: 204 })); });
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const flushing = incidents.flushIncidents(id);
  incidents.reportIncident(id, "page", "NETWORK_ERROR");
  finish();
  await flushing;
  assert.equal(stored(id).length, 1);
  await incidents.flushIncidents(id);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].eventId, sent[1].eventId);
});

test("offline recovery preserves reports and never crosses the selected owner boundary", async t => {
  const sent = collect(t), first = owner(), second = owner();
  navigator.onLine = false;
  incidents.reportIncident(first, "page", "NETWORK_ERROR");
  await incidents.flushIncidents(first);
  navigator.onLine = true;
  await incidents.flushIncidents(second);
  assert.equal(sent.length, 0);
  await incidents.flushIncidents(first);
  assert.equal(sent[0].ownerPublicId, first);
});
