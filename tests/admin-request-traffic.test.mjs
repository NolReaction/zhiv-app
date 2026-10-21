import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:request-traffic-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "request-traffic-state-runtime", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { for (const slot of slots) slot?.cleanup?.(); slots = []; cursor = 0; effects = []; }
      export function begin() { cursor = 0; effects = []; }
      export function useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; }
      export function useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { ref: { current: value } }; return slots[i].ref; }
      export function useEffect(callback, deps) { const i = cursor++, previous = slots[i]?.deps; if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) effects.push({ i, callback, deps }); }
      export function commit() { const pending = effects; effects = []; for (const { i, callback, deps } of pending) { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; } }
    `; },
    transform(source, id) { if (id.endsWith("/features/admin/admin-request-traffic-panel.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
const api = await vite.ssrLoadModule("/features/admin/admin-request-traffic-api.ts");
const { AdminRequestTrafficPanel, AdminRequestTrafficContent } = await vite.ssrLoadModule("/features/admin/admin-request-traffic-panel.tsx");
const hooks = await vite.ssrLoadModule(hookModule);
const originalFetch = globalThis.fetch, originalWindow = globalThis.window, originalDocument = globalThis.document;
let clean = () => {};
afterEach(async () => { hooks.reset(); clean(); await tick(); globalThis.fetch = originalFetch; globalThis.window = originalWindow; globalThis.document = originalDocument; });
after(() => vite.close());
const actor = "7K3P-2Q9M-W8ZR", player = "7K3P-2Q9M-W8ZS", otherActor = "7K3P-2Q9M-W8ZT";
const serverTime = "2026-10-18T01:00:30Z";
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const snapshot = () => ({ actorPublicId: actor, serverTime, startedAt: "2026-10-18T00:10:00Z", retentionSeconds: 900, capacity: 4096, evicted: 0,
  signals: [{ publicId: player, displayName: "Игрок", operation: "game/rewards", method: "GET",
    windowStartedAt: "2026-10-18T01:00:00Z", lastAt: serverTime, requests: 300, denied: 2, throttled: 1, serverErrors: 3, reasons: ["REQUEST_BURST"] }] });
function reply(body, status = 200) { return Response.json(body, { status }); }
function access(publicId = actor) { return reply({ publicId, displayName: "Админ", serverTime }); }

test("traffic reads verify the administrator before and after a private no-store GET and strip unknown fields", async () => {
  const calls = [], value = snapshot();
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET"); assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
    assert.equal(options.body, undefined); assert.equal(options.headers.Authorization, undefined);
    return url.endsWith("/access") ? access() : reply({ ...value, secret: "hidden", signals: [{ ...value.signals[0], ip: "hidden" }] });
  };
  assert.deepEqual(await api.loadAdminRequestTraffic(actor, new AbortController().signal), value);
  assert.deepEqual(calls, ["/api/v1/admin/access", "/api/v1/admin/request-traffic", "/api/v1/admin/access"]);
});

test("another administrator before, during or after the read cannot publish the snapshot", async () => {
  for (const stage of ["before", "response", "after"]) {
    const calls = [];
    globalThis.fetch = async url => {
      calls.push(url);
      if (url.endsWith("/access")) return access(stage === "before" || stage === "after" && calls.length === 3 ? otherActor : actor);
      return reply({ ...snapshot(), actorPublicId: stage === "response" ? otherActor : actor });
    };
    await assert.rejects(api.loadAdminRequestTraffic(actor, new AbortController().signal), error => error.status === 403);
    assert.equal(calls.length, stage === "before" ? 1 : stage === "response" ? 2 : 3);
  }
});

test("invalid counts, duplicates, unrecognised reasons and anonymous identities are rejected", async () => {
  for (const change of [
    value => { value.signals[0].requests = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.signals[0].denied = 301; },
    value => { value.signals[0].throttled = -1; },
    value => { value.signals[0].serverErrors = 0.5; },
    value => { value.signals[0].reasons = ["BOT_CONFIRMED"]; },
    value => { value.signals[0].reasons = ["REQUEST_BURST", "REQUEST_BURST"]; },
    value => { value.signals[0].publicId = null; },
    value => { value.signals.push({ ...value.signals[0] }); },
    value => { value.signals[0].lastAt = "2026-10-19T01:00:00Z"; },
    value => { value.signals[0].windowStartedAt = "2026-10-19T01:00:00Z"; },
    value => { value.startedAt = "2026-10-19T01:00:00Z"; },
    value => { value.retentionSeconds = 0; },
  ]) {
    const value = snapshot(); change(value);
    globalThis.fetch = async url => url.endsWith("/access") ? access() : reply(value);
    await assert.rejects(api.loadAdminRequestTraffic(actor, new AbortController().signal), error => error.status === 502);
  }
});

test("401, 403 and cancellation retain their meaning", async () => {
  for (const status of [401, 403]) {
    globalThis.fetch = async url => url.endsWith("/access") ? access() : reply({ code: "ACCESS_DENIED", message: "Нет доступа" }, status);
    await assert.rejects(api.loadAdminRequestTraffic(actor, new AbortController().signal), error => error.status === status);
  }
  let pendingSignal;
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    pendingSignal = options.signal;
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
  const controller = new AbortController(), pending = api.loadAdminRequestTraffic(actor, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal(pendingSignal.aborted, true);
});

test("rendering distinguishes anonymous aggregates, escapes names and explains limited coverage without accusing players", () => {
  const data = snapshot(); data.signals[0].displayName = '<img src=x onerror="alert(1)">'; data.evicted = 2;
  data.signals.push({ ...data.signals[0], publicId: null, displayName: null, reasons: ["ACCESS_DENIED_BURST", "THROTTLED_BURST"] });
  const markup = renderToStaticMarkup(AdminRequestTrafficContent({ data }));
  assert.match(markup, /&lt;img src=x/); assert.doesNotMatch(markup, /<img/);
  for (const text of ["Без авторизации", "Общий поток разных посетителей, не один игрок", "не доказательство нарушения", "Автоматических блокировок нет", "сбрасываются при его перезапуске", "История неполная", "Повторные отказы в доступе", "Повторные ответы 429", "В этих наблюдениях нет IP-адресов", "минутном окне"]) assert.ok(markup.includes(text), text);
  data.signals = [];
  assert.match(renderToStaticMarkup(AdminRequestTrafficContent({ data })), /нет всплесков запросов/);
});

function elements(tree) { const result = []; function walk(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, walk); } walk(tree); return result; }
function setup() {
  hooks.reset();
  const requests = [], errors = [], timers = new Map(), windowEvents = new Map(), documentEvents = new Map();
  let currentActor = actor, timerId = 0;
  globalThis.document = { visibilityState: "visible", addEventListener: (name, cb) => documentEvents.set(name, cb), removeEventListener: name => documentEvents.delete(name) };
  globalThis.window = { setInterval: cb => { timers.set(++timerId, cb); return timerId; }, clearInterval: id => timers.delete(id),
    addEventListener: (name, cb) => windowEvents.set(name, cb), removeEventListener: name => windowEvents.delete(name) };
  globalThis.fetch = (url, options) => url.endsWith("/access") ? Promise.resolve(access(currentActor))
    : new Promise((resolve, reject) => requests.push({ options, resolve: (value = snapshot(), status = 200) => resolve(reply(value, status)), reject }));
  clean = () => requests.forEach(request => request.reject(new DOMException("Cleanup", "AbortError")));
  const props = { actorPublicId: actor, onAccessLost: error => errors.push(error) };
  function render() { hooks.begin(); const tree = AdminRequestTrafficPanel(props); hooks.commit(); const nodes = elements(tree); return {
    content: nodes.find(node => node.type === AdminRequestTrafficContent), refresh: nodes.find(node => node.type === "button"), tree,
  }; }
  return { requests, errors, props, timers, windowEvents, documentEvents, render, setActor(value) { currentActor = value; } };
}

test("rerenders, focus, timer and repeated refreshes share one pending read", async () => {
  const app = setup(); app.render(); await tick(); assert.equal(app.requests.length, 1);
  for (let i = 0; i < 20; i++) {
    app.props.onAccessLost = error => app.errors.push(error);
    app.render().refresh.props.onClick();
    app.windowEvents.get("focus")();
    for (const timer of app.timers.values()) timer();
  }
  await tick(); assert.equal(app.requests.length, 1); assert.equal(app.timers.size, 1);
  app.requests[0].resolve(); await tick(); assert.ok(app.render().content);
  for (const timer of app.timers.values()) timer(); await tick(); assert.equal(app.requests.length, 2);
  app.requests[1].resolve(); await tick(); assert.equal(app.render().refresh.props.disabled, false);
});

test("changing actors immediately hides old content, aborts the old read and ignores late responses", async () => {
  const app = setup(); app.render(); await tick(); app.requests[0].resolve(); await tick(); assert.ok(app.render().content);
  app.render().refresh.props.onClick(); await tick();
  app.setActor(otherActor); app.props.actorPublicId = otherActor;
  assert.equal(app.render().content, undefined); assert.equal(app.requests[1].options.signal.aborted, true);
  await tick(); assert.equal(app.requests.length, 3);
  app.requests[2].resolve({ ...snapshot(), actorPublicId: otherActor, signals: [] }); await tick();
  assert.equal(app.render().content.props.data.actorPublicId, otherActor);
  app.requests[1].resolve(); await tick();
  assert.equal(app.render().content.props.data.actorPublicId, otherActor);
  assert.deepEqual(app.errors, []);
});

test("authorization loss clears retained data and stops polling even if the parent retains the panel", async () => {
  for (const status of [401, 403]) {
    const app = setup(); app.render(); await tick(); app.requests[0].resolve(); await tick(); assert.ok(app.render().content);
    app.render().refresh.props.onClick(); await tick();
    app.requests[1].resolve({ code: "ACCESS_DENIED", message: "Нет доступа" }, status); await tick();
    assert.equal(app.errors[0].status, status); assert.equal(app.render().content, undefined); assert.equal(app.render().refresh.props.disabled, true);
    for (const timer of app.timers.values()) timer(); app.windowEvents.get("focus")(); app.render().refresh.props.onClick();
    await tick(); assert.equal(app.requests.length, 2);
    hooks.reset(); clean(); await tick();
  }
});

test("hidden tabs do not poll and unmount aborts pending reads and removes every listener", async () => {
  const app = setup(); globalThis.document.visibilityState = "hidden"; app.render(); await tick();
  for (const timer of app.timers.values()) timer(); app.windowEvents.get("focus")(); await tick(); assert.equal(app.requests.length, 0);
  globalThis.document.visibilityState = "visible"; app.documentEvents.get("visibilitychange")(); await tick(); assert.equal(app.requests.length, 1);
  hooks.reset(); assert.equal(app.requests[0].options.signal.aborted, true);
  assert.equal(app.timers.size, 0); assert.equal(app.documentEvents.size, 0); assert.equal(app.windowEvents.size, 0);
});
