import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const origin = "https://zhiv.example";
const payload = { title: "Мохлик вернулся", body: "Пора разобрать находки", tag: "ready", url: "/?notification=world&section=activities&owner=AAAA-0000-0001", ownerPublicId: "AAAA-0000-0001" };
function harness(windows = []) {
  const listeners = new Map(), shown = [], opened = [], calls = [];
  const self = { location: new URL(origin), addEventListener: (type, callback) => listeners.set(type, callback),
    registration: { showNotification: async (...args) => shown.push(args) },
    clients: { matchAll: async () => windows, openWindow: async url => opened.push(url) },
  };
  vm.runInNewContext(source, { self, URL, Map });
  async function dispatch(type, properties) {
    const pending = [];
    listeners.get(type)({ ...properties, waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
  }
  return { listeners, shown, opened, calls, dispatch };
}

test("valid push shows one quiet notification with safe same-origin read-only data", async () => {
  const h = harness(); await h.dispatch("push", { data: { json: () => payload } });
  assert.equal(h.shown.length, 1); const [title, options] = h.shown[0];
  assert.equal(title, payload.title); assert.equal(options.renotify, false); assert.equal(options.requireInteraction, false);
  assert.equal(new URL(options.data.url).origin, origin); assert.equal(options.data.ownerPublicId, payload.ownerPublicId);
});

test("malformed, external, missing-owner and economic-action push targets never show", async () => {
  const h = harness();
  for (const patch of [{ url: "https://evil.example/" }, { url: "/api/v1/economy/command" }, { url: "/?notification=world&section=sell&owner=AAAA-0000-0001" }, { ownerPublicId: "someoneelse" }, { ownerPublicId: undefined }, { body: {} }, { title: "" }, { tag: "x".repeat(129) }]) await h.dispatch("push", { data: { json: () => ({ ...payload, ...patch }) } });
  await h.dispatch("push", { data: { json: () => { throw new Error("bad json"); } } });
  assert.equal(h.shown.length, 0);
});

test("click focuses existing app and posts a target without reload or duplicate window", async () => {
  const calls = [];
  const h = harness([{ url: `${origin}/`, focus: async () => calls.push("focus"), postMessage: value => calls.push(value) }]);
  await h.dispatch("notificationclick", { notification: { data: { url: payload.url, ownerPublicId: payload.ownerPublicId }, close: () => calls.push("close") } });
  assert.equal(calls[0], "close"); assert.equal(calls[1], "focus"); assert.equal(calls[2].type, "zhiv:notification-open"); assert.equal(h.opened.length, 0);
});

test("cold click opens sanitized app URL retaining owner, never arbitrary extra commands", async () => {
  const h = harness([{ url: "https://foreign.example/" }]);
  await h.dispatch("notificationclick", { notification: { data: { url: `${payload.url}&claim=everything`, ownerPublicId: payload.ownerPublicId }, close() {} } });
  const url = new URL(h.opened[0]); assert.equal(url.origin, origin); assert.equal(url.searchParams.get("owner"), payload.ownerPublicId); assert.equal(url.searchParams.has("claim"), false);
});

test("old window disappearing during focus falls back to a safe new window", async () => {
  const h = harness([{ url: `${origin}/`, focus: async () => { throw new Error("closed"); } }]);
  await h.dispatch("notificationclick", { notification: { data: { url: payload.url, ownerPublicId: payload.ownerPublicId }, close() {} } });
  assert.equal(h.opened.length, 1);
});

test("offline cache lifecycle remains registered alongside push", () => {
  const h = harness(); for (const type of ["install", "activate", "fetch", "push", "notificationclick"]) assert.equal(typeof h.listeners.get(type), "function");
});
