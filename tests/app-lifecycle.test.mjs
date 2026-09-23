import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { AppLifecycleController, parseAppStatus, APP_RELOAD_NOTICE_MS, APP_STATUS_TIMEOUT_MS, APP_STATUS_POLL_MS } = await vite.ssrLoadModule("/features/updates/app-lifecycle.ts");
const { AppLifecycle, AppLifecycleContent, AppReloadDeferred } = await vite.ssrLoadModule("/features/updates/app-lifecycle-view.tsx");
const status = (buildId = "build-a", maintenance = false) => ({ schemaVersion: 1, buildId, maintenance });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function harness(buildId = "build-a") {
  const timers = new Map(), requests = [], reloads = [], attempts = new Set();
  let nextTimer = 0, online = true, visible = true, durable = true, resume, pause;
  const env = {
    fetchStatus: signal => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })),
    online: () => online, visible: () => visible,
    attempted: target => attempts.has(target), prepareReload: () => durable,
    reload: target => { attempts.add(target); reloads.push(target); },
    subscribe: (onResume, onPause) => { resume = onResume; pause = onPause; return () => { resume = undefined; pause = undefined; }; },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay, interval: true }); return id; },
    clearInterval: id => timers.delete(id),
  };
  const controller = new AppLifecycleController(buildId, env);
  const fire = delay => {
    const entry = [...timers].find(([, value]) => value.delay === delay);
    assert.ok(entry, `timer ${delay} is scheduled`);
    if (!entry[1].interval) timers.delete(entry[0]);
    entry[1].callback();
  };
  return { controller, env, timers, requests, reloads, attempts, fire,
    online: value => { online = value; if (value) resume?.(); else pause?.(); },
    visible: value => { visible = value; if (value) resume?.(); else pause?.(); },
    durable: value => { durable = value; },
    answer: async value => { requests.at(-1).resolve(value); await flush(); },
  };
}

test("status protocol rejects malformed values and never guesses maintenance from an HTTP error", async () => {
  for (const value of [null, {}, { ...status(), schemaVersion: 2 }, { ...status(), buildId: "" }, { ...status(), buildId: "../bad" }, { ...status(), maintenance: "yes" }, { ...status(), message: "x".repeat(501) }]) assert.equal(parseAppStatus(value), null);
  assert.deepEqual(parseAppStatus({ ...status(), message: "Обновляем лес" }), { ...status(), message: "Обновляем лес" });
  const { appBuildId } = await import("../scripts/app-build.mjs");
  for (const value of [appBuildId(), "build_0.6.3-alpha", "a".repeat(120)]) assert.equal(parseAppStatus(status(appBuildId(value)))?.buildId, value);
  for (const value of ["-start", ".start", "_start", "a".repeat(121)]) { assert.throws(() => appBuildId(value)); assert.equal(parseAppStatus(status(value)), null); }
});

test("the first response compares to compiled build, shows a notice and rechecks ready before reload", async () => {
  const h = harness(); h.controller.start();
  await h.answer(status("build-b"));
  assert.equal(h.controller.snapshot().phase, "updating", "first response is not used as a baseline");
  assert.deepEqual(h.reloads, []);
  h.fire(APP_RELOAD_NOTICE_MS);
  assert.equal(h.requests.length, 2);
  await h.answer(status("build-b"));
  assert.deepEqual(h.reloads, ["build-b"]);
  h.controller.refresh(); await h.answer(status("build-b"));
  assert.equal(h.controller.snapshot().phase, "retry", "an old cached bundle cannot enter a reload loop");
  assert.deepEqual(h.reloads, ["build-b"]);
  h.controller.stop(); assert.equal(h.timers.size, 0);
});

test("maintenance wins over version mismatch, remains during outages, and ends only on ready status", async () => {
  const h = harness(); h.controller.start();
  await h.answer({ ...status("build-b", true), message: "Обновляем мир" });
  assert.equal(h.controller.snapshot().phase, "maintenance");
  assert.equal(h.controller.snapshot().message, "Обновляем мир");
  assert.equal([...h.timers.values()].some(timer => timer.delay === APP_RELOAD_NOTICE_MS), false);
  h.controller.refresh(); h.requests.at(-1).reject(new Error("503")); await flush();
  assert.equal(h.controller.snapshot().phase, "maintenance");
  h.controller.refresh(); await h.answer(status("build-b")); h.fire(APP_RELOAD_NOTICE_MS);
  await h.answer(status("build-b", true));
  assert.equal(h.controller.snapshot().phase, "maintenance", "maintenance can restart during the notice");
  assert.deepEqual(h.reloads, []);
  h.controller.refresh(); await h.answer(status());
  assert.equal(h.controller.snapshot().phase, "ready"); h.controller.stop();
});

test("offline and hidden tabs pause reloads, expired requests and unmounts ignore late responses", async () => {
  const h = harness(); h.controller.start(); await h.answer(status("build-b"));
  h.online(false);
  assert.equal(h.controller.snapshot().phase, "waiting");
  h.fire(APP_STATUS_POLL_MS); assert.equal(h.requests.length, 1);
  h.online(true); await h.answer(status("build-b")); h.visible(false);
  assert.equal([...h.timers.values()].some(timer => timer.delay === APP_RELOAD_NOTICE_MS), false);
  h.visible(true); const expired = h.requests.at(-1); h.fire(APP_STATUS_TIMEOUT_MS);
  assert.equal(expired.signal.aborted, true);
  h.controller.refresh(); assert.equal(h.requests.length, 4, "timeout releases the in-flight guard");
  await h.answer(status()); expired.resolve(status("old-response", true)); await flush();
  assert.equal(h.controller.snapshot().phase, "ready");
  h.controller.refresh(); const late = h.requests.at(-1); h.controller.stop();
  assert.equal(late.signal.aborted, true); assert.equal(h.timers.size, 0);
  late.resolve(status("build-c", true)); await flush(); assert.equal(h.controller.snapshot().phase, "ready");
});

test("unsaved draft or queue vetoes reload; explicit retry succeeds after durable save", async () => {
  const h = harness(); h.durable(false); h.controller.start(); await h.answer(status("build-b"));
  h.fire(APP_RELOAD_NOTICE_MS); await h.answer(status("build-b"));
  assert.equal(h.controller.snapshot().phase, "blocked"); assert.deepEqual(h.reloads, []); assert.equal(h.attempts.size, 0);
  h.controller.refresh(); await h.answer(status("build-b")); assert.equal(h.controller.snapshot().phase, "blocked");
  h.durable(true); h.controller.retry(); await h.answer(status("build-b"));
  h.fire(APP_RELOAD_NOTICE_MS); await h.answer(status("build-b"));
  assert.deepEqual(h.reloads, ["build-b"]); h.controller.stop();
});

test("late rejection of an expired request cannot cancel a newer reload notice", async () => {
  const h = harness(); h.controller.start(); const expired = h.requests.at(-1); h.fire(APP_STATUS_TIMEOUT_MS);
  h.controller.refresh(); await h.answer(status("build-b"));
  expired.reject(new Error("Late abort")); await flush();
  assert.equal(h.controller.snapshot().phase, "updating");
  h.fire(APP_RELOAD_NOTICE_MS); await h.answer(status("build-b"));
  assert.deepEqual(h.reloads, ["build-b"]); h.controller.stop();
});

test("development does not reload on production IDs, but still supports maintenance preview", async () => {
  const h = harness("development"); h.controller.start(); await h.answer(status("production-id"));
  assert.equal(h.controller.snapshot().phase, "ready"); assert.deepEqual(h.reloads, []);
  h.controller.refresh(); await h.answer(status("production-id", true));
  assert.equal(h.controller.snapshot().phase, "maintenance"); h.controller.stop();
});

test("SSR starts no browser work and lifecycle screens explain recovery without cache clearing", () => {
  const initial = renderToStaticMarkup(createElement(AppLifecycle));
  assert.match(initial, /<dialog/); assert.doesNotMatch(initial, / open=""/);
  const maintenance = renderToStaticMarkup(createElement(AppLifecycleContent, { state: { phase: "maintenance", message: "Готовим обновление" }, onRetry() {} }));
  assert.match(maintenance, /Готовим обновление/); assert.match(maintenance, /Проверить готовность/);
  const blocked = renderToStaticMarkup(createElement(AppReloadDeferred, { onRetry() {} }));
  assert.match(blocked, /Не удалось сохранить данные/); assert.match(blocked, /Повторить/);
  assert.match(blocked, /<aside/); assert.doesNotMatch(blocked, /dialog|aria-modal/, "unsaved forms remain usable when a reload is vetoed");
});

test("actual browser adapter keeps timer receivers, cache-busts reload and guards loops without storage", async () => {
  const source = await readFile(new URL("../features/updates/app-lifecycle.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let browserGlobal;
  const timers = new Map(), events = new Map(), requests = [], replacements = [];
  const context = vm.createContext({ exports: {}, AbortController, URL, Event });
  browserGlobal = vm.runInContext("globalThis", context);
  let nextTimer = 0;
  for (const name of ["setTimeout", "setInterval", "clearTimeout", "clearInterval"]) context[name] = function (...args) {
    if (this !== browserGlobal) throw new TypeError("Illegal invocation");
    if (name.startsWith("clear")) return timers.delete(args[0]);
    const id = ++nextTimer; timers.set(id, { callback: args[0], delay: args[1] }); return id;
  };
  const target = prefix => ({ addEventListener: (name, fn) => events.set(`${prefix}:${name}`, fn), removeEventListener: name => events.delete(`${prefix}:${name}`) });
  Object.assign(context, {
    navigator: { onLine: true }, document: { hidden: false, ...target("document") },
    window: { ...target("window"), location: { href: "https://example.test/?invite=abc#home", replace: value => replacements.push(value) }, dispatchEvent: event => !event.defaultPrevented },
    sessionStorage: { getItem() { throw new Error("Unavailable"); }, setItem() { throw new Error("Unavailable"); } },
    fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => status("build-b") }; },
  });
  vm.runInContext(code, context);
  const env = context.exports.browserAppLifecycleEnvironment();
  const controller = new context.exports.AppLifecycleController("build-a", env);
  controller.start(); await flush();
  assert.equal(requests[0].url, "/app-status.json"); assert.equal(requests[0].init.cache, "no-store");
  const notice = [...timers].find(([, timer]) => timer.delay === APP_RELOAD_NOTICE_MS);
  timers.delete(notice[0]); notice[1].callback(); await flush();
  assert.equal(replacements.length, 1);
  const url = new URL(replacements[0]); assert.equal(url.searchParams.get("_appBuild"), "build-b"); assert.equal(url.searchParams.get("invite"), "abc"); assert.equal(url.hash, "#home");
  context.window.location.href = replacements[0]; assert.equal(env.attempted("build-b"), true);
  controller.stop(); assert.equal(timers.size, 0); assert.equal(events.size, 0);
});
