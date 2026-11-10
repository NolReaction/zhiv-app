import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:branch-access-ui-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "branch-access-lifecycle", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      import { createElement } from 'react'; export { Suspense } from 'react';
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots.forEach(slot => slot?.cleanup?.()); slots = []; effects = []; cursor = 0; }
      export function begin() { cursor = 0; }
      export function useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: initial };
        const slot = slots[i]; return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }]; }
      export function useEffect(callback, deps) { const i = cursor++, previous = slots[i];
        if (!previous || deps.some((value, n) => !Object.is(value, previous.deps[n]))) effects.push({ i, callback, deps }); }
      export function commit() { const pending = effects; effects = []; for (const { i, callback, deps } of pending) {
        slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; } }
      export function WorkspaceSentinel() { return createElement('input', { 'data-workspace': true, defaultValue: 'typed filter' }); }
      export const lazy = () => WorkspaceSentinel;
    `; },
    transform(source, id) { if (id.endsWith("/features/progression/access/branch-access-gate.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }] });
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { BranchAccessGate } = await vite.ssrLoadModule("/features/progression/access/branch-access-gate.tsx");
const actor = "7K3P-2Q9M-W8ZR", other = "7K3P-2Q9M-W8ZT", allowed = { status: "allowed", publicId: actor };
const originalFetch = globalThis.fetch, originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
afterEach(async () => {
  hooks.reset(); await tick(); globalThis.fetch = originalFetch;
  for (const [name, descriptor] of [["window", originalWindow], ["document", originalDocument]]) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }
});
function setup(initial = allowed) {
  hooks.reset(); const requests = [], documentEvents = new Map(), windowEvents = new Map(), timers = new Map(); let timerId = 0;
  const document = { visibilityState: "visible", addEventListener: (type, fn) => documentEvents.set(type, fn), removeEventListener: type => documentEvents.delete(type) };
  const window = { addEventListener: (type, fn) => windowEvents.set(type, fn), removeEventListener: type => windowEvents.delete(type),
    setInterval(fn) { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id) };
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    assert.equal(url, "/api/v1/admin/access"); assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    requests.push({ resolve, reject, signal: options.signal });
  });
  return { requests, documentEvents, windowEvents, timers,
    render(commit = true) { hooks.begin(); const tree = BranchAccessGate({ initial }); if (commit) hooks.commit(); return tree; },
    visibility(value) { document.visibilityState = value; documentEvents.get("visibilitychange")?.(); },
    restore(persisted = true) { windowEvents.get("pageshow")?.({ persisted }); },
    poll() { for (const fn of timers.values()) fn(); },
  };
}
function workspace(tree) {
  let result;
  function walk(node, path, ancestors) {
    if (!isValidElement(node)) return;
    const next = [...path, [node.type, node.key]];
    if (node.type === hooks.WorkspaceSentinel) result = { path: next, wrapper: ancestors.at(-2) };
    Children.forEach(node.props.children, (child, index) => walk(child, [...next, index], [...ancestors, node]));
  }
  walk(tree, [], []); return result;
}
async function ready(app) { app.render(); app.requests.at(-1).resolve(Response.json({ publicId: actor })); await tick(); return app.render(); }

for (const event of ["visibility", "bfcache"]) test(`${event} return retains workspace identity while hidden and inert until the same actor is confirmed`, async () => {
  const app = setup(), before = workspace(await ready(app)); assert.ok(before);
  if (event === "visibility") { app.visibility("hidden"); app.poll(); assert.equal(app.requests.length, 1); app.visibility("visible"); }
  else app.restore();
  const pending = workspace(app.render()); assert.deepEqual(pending.path, before.path, "React must retain the same component identity and form state");
  assert.equal(pending.wrapper.props.hidden, true); assert.equal(pending.wrapper.props.inert, true); assert.equal(pending.wrapper.props.style.display, "none");
  assert.match(renderToStaticMarkup(app.render()), /Проверяем доступ/); assert.equal(app.requests.length, 2);
  app.requests[1].resolve(Response.json({ publicId: actor })); await tick();
  const restored = workspace(app.render()); assert.deepEqual(restored.path, before.path); assert.equal(restored.wrapper.props.hidden, false); assert.equal(restored.wrapper.props.inert, false);
});

for (const outcome of [401, 403, 503, "network", "different-actor", "malformed"]) test(`access ${outcome} removes the retained workspace instead of keeping its form or report in the DOM`, async () => {
  const app = setup(); await ready(app); app.visibility("visible"); assert.ok(workspace(app.render()));
  const pending = app.requests.at(-1);
  if (outcome === "network") pending.reject(new TypeError("Connection lost"));
  else pending.resolve(typeof outcome === "number" ? new Response(null, { status: outcome }) : Response.json(outcome === "different-actor" ? { publicId: other } : {}));
  await tick(); const tree = app.render(); assert.equal(workspace(tree), undefined);
  assert.doesNotMatch(renderToStaticMarkup(tree), /data-workspace|typed filter/);
  assert.match(renderToStaticMarkup(tree), /Войдите в аккаунт администратора|Доступ закрыт|Не удалось проверить доступ/);
});

test("a second restore shares the pending verification and cleanup aborts it and removes listeners", async () => {
  const app = setup(); await ready(app); app.visibility("visible"); app.restore(); app.poll();
  assert.equal(app.requests.length, 2); assert.equal(workspace(app.render()).wrapper.props.hidden, true);
  const request = app.requests.at(-1); hooks.reset(); assert.equal(request.signal.aborted, true);
  assert.equal(app.documentEvents.size, 0); assert.equal(app.windowEvents.size, 0); assert.equal(app.timers.size, 0);
  request.resolve(Response.json({ publicId: actor })); await tick();
  const denied = setup({ status: "forbidden" }); assert.equal(workspace(denied.render()), undefined); assert.equal(denied.requests.length, 0);
});

test("denied SSR contains no workspace or Suspense report and starts no client verification", () => {
  for (const status of ["signed-out", "forbidden", "unavailable"]) {
    const app = setup({ status }), tree = app.render(false), html = renderToStaticMarkup(tree);
    assert.equal(workspace(tree), undefined); assert.doesNotMatch(html, /data-workspace|typed filter|Загружаем рабочие разделы/);
    assert.match(html, /Открыть управление/); hooks.commit(); assert.equal(app.requests.length, 0); assert.equal(app.timers.size, 0);
  }
});
