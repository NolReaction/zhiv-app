import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:api-usage-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "api-usage-state-runtime", enforce: "pre",
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
    transform(source, id) { if (id.endsWith("/features/admin/admin-api-usage-panel.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());
const api = await vite.ssrLoadModule("/features/admin/admin-api-usage-api.ts");
const { AdminApiUsageContent, AdminApiUsagePanel } = await vite.ssrLoadModule("/features/admin/admin-api-usage-panel.tsx");
const hooks = await vite.ssrLoadModule(hookModule);
const originalFetch = globalThis.fetch, originalWindow = globalThis.window, originalDocument = globalThis.document;
let clean = () => {};
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
afterEach(async () => { hooks.reset(); clean(); await tick(); globalThis.fetch = originalFetch; globalThis.window = originalWindow; globalThis.document = originalDocument; });
const actor = "7K3P-2Q9M-W8ZR", otherActor = "7K3P-2Q9M-W8ZT";
const serverTime = "2026-10-21T12:00:00Z";
const period = "past_30_days";
const snapshot = () => ({
  actorPublicId: actor, serverTime,
  api: { startedAt: "2026-10-21T10:00:00Z", requests: 300, errors: 5, throttled: 2 },
  maptiler: { configured: true, available: true, error: null, period, scope: "account",
    since: "2026-09-21", until: "2026-10-21", updatedAt: "2026-10-21T11:59:00Z",
    groups: [{ group: "request", total: 250, daily: [{ date: "2026-10-20", value: 250 }], estimated: [{ date: "2026-10-21", value: 42 }] }],
  },
});
const access = publicId => Response.json({ publicId, displayName: "Админ", serverTime });

test("usage reads are bound to the same administrator before and after the provider snapshot", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.cache, "no-store"); assert.equal(options.credentials, "same-origin");
    assert.ok(options.signal instanceof AbortSignal);
    return url.endsWith("/access") ? access(actor) : Response.json(snapshot());
  };
  const data = await api.loadAdminApiUsage(actor, period, new AbortController().signal);
  assert.equal(data.maptiler.groups[0].total, 250, "estimates must not become actual usage");
  assert.deepEqual(calls, ["/api/v1/admin/access", `/api/v1/admin/api-usage?period=${period}`, "/api/v1/admin/access"]);
});

test("a switched administrator cannot retrieve or publish another actor's snapshot", async () => {
  for (const stage of ["before", "snapshot", "after"]) {
    let accesses = 0;
    globalThis.fetch = async url => {
      if (url.endsWith("/access")) return access(stage === "before" || stage === "after" && accesses++ > 0 ? otherActor : actor);
      const data = snapshot(); if (stage === "snapshot") data.actorPublicId = otherActor;
      return Response.json(data);
    };
    await assert.rejects(api.loadAdminApiUsage(actor, period, new AbortController().signal), error => error.status === 403);
  }
});

test("negative, unsafe, inconsistent and duplicate usage metrics cannot enter the admin view", async () => {
  for (const change of [
    value => { value.api.requests = -1; },
    value => { value.api.errors = 301; },
    value => { value.api.throttled = 301; },
    value => { value.api.startedAt = "2026-10-22T00:00:00Z"; },
    value => { value.maptiler.period = "past_90_days"; },
    value => { value.maptiler.scope = "one-key"; },
    value => { value.maptiler.groups[0].total = Infinity; },
    value => { value.maptiler.groups[0].total = 292; },
    value => { value.maptiler.groups[0].daily[0].value = -1; },
    value => { value.maptiler.groups[0].daily[0].date = "2026-02-30"; },
    value => { value.maptiler.groups[0].estimated[0].value = -1; },
    value => { value.maptiler.groups.push({ ...value.maptiler.groups[0] }); },
    value => { value.maptiler.groups[0].daily.push({ ...value.maptiler.groups[0].daily[0] }); },
  ]) {
    const data = snapshot(); change(data);
    globalThis.fetch = async url => url.endsWith("/access") ? access(actor) : Response.json(data);
    await assert.rejects(api.loadAdminApiUsage(actor, period, new AbortController().signal), error => error.status === 502);
  }
});

test("official provider number values may be fractional without leaking estimates into totals", async () => {
  const data = snapshot(); data.maptiler.groups[0].daily[0].value = 0.25; data.maptiler.groups[0].total = 0.25;
  data.maptiler.groups[0].estimated[0].value = 1.5;
  globalThis.fetch = async url => url.endsWith("/access") ? access(actor) : Response.json(data);
  const result = await api.loadAdminApiUsage(actor, period, new AbortController().signal);
  assert.equal(result.maptiler.groups[0].total, 0.25);
});

test("an estimate without completed days has no actual total", async () => {
  const data = snapshot(); data.maptiler.groups[0].daily = []; data.maptiler.groups[0].total = null;
  globalThis.fetch = async url => url.endsWith("/access") ? access(actor) : Response.json(data);
  const result = await api.loadAdminApiUsage(actor, period, new AbortController().signal);
  assert.equal(result.maptiler.groups[0].total, null); assert.equal(result.maptiler.groups[0].estimated[0].value, 42);
  data.maptiler.groups[0].total = 0;
  await assert.rejects(api.loadAdminApiUsage(actor, period, new AbortController().signal), error => error.status === 502);
});

test("provider unavailable remains distinct from real zero usage while application totals remain available", async () => {
  const data = snapshot();
  Object.assign(data.maptiler, { configured: false, available: false, error: "MAPTILER_DISABLED", since: null, until: null, updatedAt: null, groups: [] });
  globalThis.fetch = async url => url.endsWith("/access") ? access(actor) : Response.json(data);
  const result = await api.loadAdminApiUsage(actor, period, new AbortController().signal);
  assert.equal(result.api.requests, 300); assert.equal(result.maptiler.available, false);
  const zero = snapshot(); zero.maptiler.groups[0] = { group: "request", total: 0, daily: [{ date: "2026-10-20", value: 0 }], estimated: [] };
  globalThis.fetch = async url => url.endsWith("/access") ? access(actor) : Response.json(zero);
  assert.equal((await api.loadAdminApiUsage(actor, period, new AbortController().signal)).maptiler.groups[0].total, 0);
});

test("authorization errors and an aborted preflight do not start a provider snapshot read", async () => {
  for (const status of [401, 403]) {
    globalThis.fetch = async () => Response.json({ code: "ACCESS_DENIED", message: "Нет доступа" }, { status });
    await assert.rejects(api.loadAdminApiUsage(actor, period, new AbortController().signal), error => error.status === status);
  }
  const controller = new AbortController(), calls = [];
  globalThis.fetch = async url => { calls.push(url); controller.abort(); return access(actor); };
  await assert.rejects(api.loadAdminApiUsage(actor, period, controller.signal), error => error.name === "AbortError");
  assert.deepEqual(calls, ["/api/v1/admin/access"]);
});

test("usage presentation separates providers, units and estimates instead of inventing a bill or quota", () => {
  const data = snapshot();
  data.maptiler.groups.push({ group: "session", total: 3, daily: [{ date: "2026-10-20", value: 3 }], estimated: [] });
  const html = renderToStaticMarkup(createElement(AdminApiUsageContent, { data }));
  assert.match(html, /300/); assert.match(html, /250/); assert.match(html, /42/);
  assert.match(html, /MapTiler/); assert.match(html, /аккаунт/);
  assert.match(html, /[Пп]редвар|[Оо]цен/);
  assert.doesNotMatch(html, /292|253|руб\.|₽|остаток: 0/i);
});

function elements(tree) {
  const result = [];
  function walk(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, walk); }
  walk(tree); return result;
}
function setup() {
  hooks.reset();
  const requests = [], errors = [], timers = new Map(), windowEvents = new Map(), documentEvents = new Map();
  let currentActor = actor, timerId = 0;
  globalThis.document = { visibilityState: "visible", addEventListener: (name, cb) => documentEvents.set(name, cb), removeEventListener: name => documentEvents.delete(name) };
  globalThis.window = { setInterval: cb => { timers.set(++timerId, cb); return timerId; }, clearInterval: id => timers.delete(id),
    addEventListener: (name, cb) => windowEvents.set(name, cb), removeEventListener: name => windowEvents.delete(name) };
  globalThis.fetch = (url, options) => url.endsWith("/access") ? Promise.resolve(access(currentActor))
    : new Promise((resolve, reject) => requests.push({ options, url, resolve: (value = snapshot(), status = 200) => resolve(Response.json(value, { status })), reject }));
  clean = () => requests.forEach(request => request.reject(new DOMException("Cleanup", "AbortError")));
  const props = { actorPublicId: actor, onAccessLost: error => errors.push(error) };
  function render() {
    hooks.begin(); const tree = AdminApiUsagePanel(props); hooks.commit(); const nodes = elements(tree);
    return { content: nodes.find(node => node.type === AdminApiUsageContent), refresh: nodes.find(node => node.type === "button"),
      select: nodes.find(node => node.type === "select"), tree };
  }
  return { requests, errors, props, timers, windowEvents, documentEvents, render, setActor(value) { currentActor = value; } };
}
const panelSnapshot = (selected = "current_billing_period", owner = actor) => {
  const data = snapshot(); data.maptiler.period = selected; data.actorPublicId = owner; return data;
};

test("period and actor changes clear old data immediately and ignore late requests", async () => {
  const state = setup(); state.render(); await tick();
  state.requests[0].resolve(panelSnapshot()); await tick();
  const loaded = state.render(); assert.ok(loaded.content);
  loaded.select.props.onChange({ target: { value: period } });
  assert.equal(state.render().content, undefined); await tick();
  assert.match(state.requests[1].url, /past_30_days/);
  state.props.actorPublicId = otherActor; state.setActor(otherActor);
  assert.equal(state.render().content, undefined); assert.equal(state.requests[1].options.signal.aborted, true);
  state.requests[1].resolve(panelSnapshot(period)); await tick();
  assert.equal(state.render().content, undefined);
  state.requests[2].resolve(panelSnapshot(period, otherActor)); await tick();
  assert.equal(state.render().content.props.data.actorPublicId, otherActor);
});

test("hidden pages cancel pending work and resume without overlapping reads or publishing late data", async () => {
  const state = setup(); state.render(); await tick();
  globalThis.document.visibilityState = "hidden"; state.documentEvents.get("visibilitychange")();
  assert.equal(state.requests[0].options.signal.aborted, true);
  for (const poll of state.timers.values()) poll(); await tick(); assert.equal(state.requests.length, 1);
  globalThis.document.visibilityState = "visible"; state.documentEvents.get("visibilitychange")(); await tick();
  state.requests[0].resolve(panelSnapshot()); await tick(); assert.equal(state.render().content, undefined);
  state.requests[1].resolve(panelSnapshot()); await tick(); assert.ok(state.render().content);
  state.windowEvents.get("focus")(); state.windowEvents.get("focus")(); await tick(); assert.equal(state.requests.length, 3);
  hooks.reset(); assert.equal(state.requests[2].options.signal.aborted, true); assert.equal(state.timers.size, 0);
});

test("losing access removes private usage data and stops refreshes", async () => {
  const state = setup(); state.render(); await tick(); state.requests[0].resolve(panelSnapshot()); await tick();
  state.render().refresh.props.onClick(); await tick();
  state.requests[1].resolve({ code: "ACCESS_DENIED", message: "Нет доступа" }, 403); await tick();
  const closed = state.render(); assert.equal(closed.content, undefined); assert.equal(closed.refresh.props.disabled, true);
  assert.equal(state.errors.length, 1);
  for (const poll of state.timers.values()) poll(); await tick(); assert.equal(state.requests.length, 2);
});
