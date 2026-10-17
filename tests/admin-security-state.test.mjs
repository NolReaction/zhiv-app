import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:security-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "security-state-runtime", enforce: "pre",
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
    transform(source, id) { if (id.endsWith("/features/admin/admin-player-dialog.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());
const { AdminPlayerDialog } = await vite.ssrLoadModule("/features/admin/admin-player-dialog.tsx");
const { newWorldState } = await vite.ssrLoadModule("/features/world/domain/model.ts");
const hooks = await vite.ssrLoadModule(hookModule);
const originalFetch = globalThis.fetch;
let clean = () => {};
afterEach(async () => { hooks.reset(); clean(); await tick(); globalThis.fetch = originalFetch; });
const actor = "7K3P-2Q9M-W8ZR", target = "7K3P-2Q9M-W8ZS", otherActor = "7K3P-2Q9M-W8ZT";
const serverTime = "2026-10-18T01:00:00Z";
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function elements(tree) { const result = []; function walk(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, walk); } walk(tree); return result; }
function setup() {
  hooks.reset(); const requests = [], posts = [], errors = []; let currentActor = actor, changes = 0;
  let postResponse = request => Response.json({ requestId: request.requestId, action: request.action, changed: true, affectedSessions: 0, createdAt: serverTime });
  globalThis.fetch = (url, options) => {
    if (url.endsWith("/access")) return Promise.resolve(Response.json({ publicId: currentActor, displayName: "Админ", serverTime }));
    if (options.method === "POST") { const request = JSON.parse(options.body); posts.push(request); return Promise.resolve().then(() => postResponse(request)); }
    return new Promise((resolve, reject) => requests.push({ url, options, resolve: value => resolve(Response.json(value ?? response(url))), reject }));
  };
  clean = () => { for (const request of requests) request.reject(new DOMException("Test cleanup", "AbortError")); };
  const props = { target: { publicId: target, displayName: "Тестер", securitySignalAt: serverTime, tag: null, isAdmin: false },
    actorPublicId: actor, onAccessLost: error => errors.push(error), onClose() {}, onChanged: () => changes++ };
  function response(url) {
    const publicId = url.split("/").at(-2);
    return url.endsWith("/security") ? { publicId, serverTime, watchlisted: false, manualWatchReason: null, tapSignalAt: null, securitySignalAt: serverTime,
      signals: [{ code: "ECONOMY_REQUEST_TAMPER", reason: "Проверка изменённого действия", severity: "review", status: "active", count: 1, pendingCount: 1,
        threshold: 1, windowMinutes: null, firstAt: serverTime, lastAt: serverTime, lastAction: "economy:sell", lastRequestId: "00000000-0000-4000-8000-000000000001", reviewedAt: null }] }
      : { publicId, displayName: "Тестер", tag: null, tapSignalAt: null, securitySignalAt: serverTime, bannedAt: null,
        banReason: null, watchlisted: false, world: newWorldState(), revision: 0, serverTime };
  }
  function render() { hooks.begin(); const tree = AdminPlayerDialog(props); hooks.commit(); const all = elements(tree); return { tree, elements: all, security: all.find(node => node.type.name === "AdminSecurityContent") }; }
  return { requests, posts, errors, props, render, setActor: value => { currentActor = value; },
    setPost: value => { postResponse = value; }, get changes() { return changes; } };
}
async function ready(app) { app.render(); await tick(); assert.equal(app.requests.length, 2); app.requests.forEach(request => request.resolve()); await tick(); return app.render(); }
function authorize(app) {
  const view = app.render();
  view.elements.find(node => node.type === "input" && node.props.maxLength === 240).props.onChange({ target: { value: "Проверены отклонённые операции" } });
  view.elements.find(node => node.type === "input" && node.props.placeholder === target).props.onChange({ target: { value: target } });
  return app.render();
}

test("changing the administrator immediately hides retained security details until the new identity is verified", async () => {
  const app = setup(); await ready(app); assert.ok(app.render().security);
  app.setActor(otherActor); app.props.actorPublicId = otherActor;
  assert.equal(app.render().security, undefined); await tick(); assert.equal(app.requests.length, 4);
  app.requests.slice(2).forEach(request => request.resolve()); await tick(); assert.ok(app.render().security);
  app.props.target = { ...app.props.target, publicId: actor, displayName: "Другой игрок" };
  assert.equal(app.render().security, undefined); await tick();
  app.requests.slice(4).forEach(request => request.resolve()); await tick();
  assert.equal(app.render().security.props.detail.publicId, actor);
});

test("401 and 403 on moderation remove private details even when the parent retains the component", async () => {
  for (const status of [401, 403]) {
    const app = setup(); await ready(app); authorize(app);
    app.setPost(() => Response.json({ code: "ACCESS_DENIED", message: "Нет доступа" }, { status }));
    app.render().security.props.onClear(); await tick();
    assert.equal(app.errors[0].status, status); assert.equal(app.render().security, undefined);
    hooks.reset(); clean(); await tick();
  }
});

test("security review requires explicit confirmation and retains exactly the same request after a lost response", async () => {
  const app = setup(); await ready(app);
  app.render().security.props.onClear(); await tick(); assert.equal(app.posts.length, 0);
  authorize(app); let failures = 0;
  app.setPost(request => { if (!failures++) throw new TypeError("Response lost"); return Response.json({ requestId: request.requestId, action: request.action, changed: true, affectedSessions: 0, createdAt: serverTime }); });
  app.render().security.props.onClear(); await tick();
  let view = app.render(); assert.equal(app.posts.length, 1); assert.equal(view.security.props.locked, true);
  view.elements.find(node => node.type === "button" && node.props.children === "Проверить тем же запросом").props.onClick(); await tick();
  assert.equal(app.posts.length, 2); assert.deepEqual(app.posts[0], app.posts[1]); assert.equal(app.posts[0].action, "clear_signal");
  assert.equal(app.posts[0].confirmationPublicId, target); assert.equal(app.changes, 1);
  app.requests.slice(2).forEach(request => request.resolve()); await tick();
  view = app.render(); assert.equal(view.security.props.locked, false);
});

test("a late initial response from the previous player never exposes its reason in the next player's dialog", async () => {
  const app = setup(); app.render(); await tick();
  app.props.target = { ...app.props.target, publicId: otherActor, displayName: "Следующий игрок" };
  app.render(); await tick(); assert.equal(app.requests.length, 4);
  app.requests.slice(2).forEach(request => request.resolve()); await tick();
  assert.equal(app.render().security.props.detail.publicId, otherActor);
  app.requests.slice(0, 2).forEach(request => request.resolve()); await tick();
  assert.equal(app.render().security.props.detail.publicId, otherActor);
});
