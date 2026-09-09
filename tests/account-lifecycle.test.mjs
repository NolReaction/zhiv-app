import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const api = await vite.ssrLoadModule("/lib/account-lifecycle.ts");
const { AccountLifecycle } = await vite.ssrLoadModule("/features/account/account-lifecycle.tsx");
after(() => vite.close());

test("account proofs explicitly bind the action and profile role; they never request registration", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options });
    return Response.json({ flow: "opaque", url: null });
  });
  await api.startAccountProof("email", "merge", "other", "other@example.com");
  await api.startAccountProof("vk", "delete", "current");
  assert.deepEqual(JSON.parse(requests[0].body), { intent: "account", action: "merge", role: "other", email: "other@example.com" });
  assert.deepEqual(JSON.parse(requests[1].body), { intent: "account", action: "delete", role: "current" });
  assert.equal(requests[0].credentials, "same-origin");
  assert.equal(requests[0].cache, "no-store");
});

test("OTP failure cannot be mistaken for success from an already-open account", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => { requests.push(url); throw new TypeError("Connection lost"); });
  await assert.rejects(api.verifyAccountProof("flow", "123456"), /Connection lost/);
  assert.deepEqual(requests, ["/api/v1/auth/email/verify"]);
});

test("a regular login or registration result is rejected as account proof", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "ok" }));
  await assert.rejects(api.verifyAccountProof("flow", "123456"));
});

test("email and deletion retries retain the same operation key and explicit confirmation", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options });
    return Response.json({ status: "ok" });
  });
  const key = "fb77266e-996a-4c0b-99d4-6e9e72a6d6ad";
  await api.changeAccountEmail(key);
  await api.changeAccountEmail(key);
  await api.deleteAccountProfile(key);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(JSON.parse(requests[2].body), { confirm: true, idempotencyKey: key });
  assert.equal(requests[2].method, "DELETE");
  assert.equal(requests[2].url, "/api/v1/auth/account/profile");
});

test("merge commits the server preview, with no client-supplied target profile or audience", async t => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    request = { url, ...options }; return Response.json({ status: "ok" });
  });
  await api.confirmAccountMerge("server-preview-token");
  assert.deepEqual(JSON.parse(request.body), { preview: "server-preview-token", confirm: true });
});

test("confirmation of one action does not authorize a different action", () => {
  const state = { ...api.emptyLifecycle, currentEmail: true };
  assert.equal(api.currentAccountProved(state, "email"), true);
  assert.equal(api.currentAccountProved(state, "merge"), false);
  assert.equal(api.currentAccountProved(state, "delete"), false);
});

test("offline account management is visible but disabled", () => {
  const html = renderToStaticMarkup(React.createElement(AccountLifecycle, {
    access: { methods: [{ provider: "email", label: "m•••@example.com" }], sessions: [] },
    options: { email: true, vk: true, telegram: false, legacy: false },
    isOnline: false, onChanged: async () => {}, onDeleted: () => {},
  }));
  assert.match(html, /Сменить почту/); assert.match(html, /Объединить профили/); assert.match(html, /Удалить профиль/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
});
