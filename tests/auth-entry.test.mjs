import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { LoginForm } = await vite.ssrLoadModule("/components/account-entry.tsx");
const api = await vite.ssrLoadModule("/lib/auth-api.ts");
after(() => vite.close());
const options = { vk: true, email: true, telegram: true, legacy: false };
const render = props => renderToStaticMarkup(React.createElement(LoginForm, { options, isOnline: true, onDone: async () => {}, ...props }));

test("entry offers VK and email with no separate registration choice or name field", () => {
  const html = render({});
  assert.match(html, /Войти через ВК/);
  assert.match(html, /Войти через почту/);
  assert.doesNotMatch(html, /Создать профиль|Войти через Telegram|Как вас зовут|autoComplete="name"/);
});

test("name is requested only for a pending verified registration", () => {
  const html = render({ pending: true });
  assert.match(html, /Как вас зовут/);
  assert.match(html, /Вход подтверждён/);
  assert.doesNotMatch(html, /Войти через ВК|Войти через почту/);
});

test("linking uses a separate action and does not offer a new profile", () => {
  const html = render({ link: true });
  assert.match(html, /Привязать ВК/);
  assert.match(html, /Привязать почту/);
  assert.doesNotMatch(html, /Создать профиль|Как вас зовут/);
});

test("auth failures do not recommend an unconfigured email method", () => {
  assert.doesNotMatch(api.authReturnMessage("unknown"), /почт/);
  assert.match(api.authReturnMessage("auth_expired"), /время|Время/);
  assert.match(api.authReturnMessage("vk_login_failed"), /ВК/);
  assert.equal(api.authReturnMessage("profile-required"), "");
});

test("sign-in request carries no pre-confirmation registration or display name", async t => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    request = { url, ...options };
    return Response.json({ flow: "opaque", url: null });
  });
  await api.startAuth("email", "login", "test@example.com");
  assert.equal(request.url, "/api/v1/auth/email/start");
  assert.deepEqual(JSON.parse(request.body), { intent: "login", email: "test@example.com" });
  assert.equal(request.credentials, "same-origin");
});

const me = {
  user: { publicId: "1234-5678-9ABC", displayName: "Дима" },
  lastCheckInAt: null, checkInCount: 0,
  streak: { currentDays: 0, longestDays: 0, isActive: false, renewBy: null },
  profile: { avatarUrl: null, displayNameChangedAt: null, displayNameChangeAvailableAt: null },
  serverTime: "2026-09-06T12:00:00Z",
};

test("lost OTP response recovers a verified signup ticket without resending the code", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(url);
    if (url.endsWith("email/verify")) return new Response('{"status":', { status: 200 });
    if (url.endsWith("/me")) return Response.json({ code: "UNAUTHORIZED", message: "No session" }, { status: 401 });
    if (url.endsWith("registration")) return Response.json({ pending: true });
    throw new Error(`Unexpected ${url}`);
  });
  assert.deepEqual(await api.verifyEmailLogin("once", "123456"), { status: "profile-required" });
  assert.deepEqual(requests, ["/api/v1/auth/email/verify", "/api/v1/me", "/api/v1/auth/registration"]);
});

test("lost profile response uses the issued session instead of creating another profile", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(url);
    if (url.endsWith("registration")) throw new TypeError("Connection lost after headers");
    if (url.endsWith("/me")) return Response.json(me);
    throw new Error(`Unexpected ${url}`);
  });
  assert.deepEqual(await api.completeRegistration("Дима"), { status: "ok" });
  assert.deepEqual(requests, ["/api/v1/auth/registration", "/api/v1/me"]);
});

test("linking never treats the already-open profile as proof of a successful link", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(url);
    throw new TypeError("Connection lost");
  });
  await assert.rejects(api.verifyEmailLogin("once", "123456", true), /Connection lost/);
  assert.deepEqual(requests, ["/api/v1/auth/email/verify"]);
});
