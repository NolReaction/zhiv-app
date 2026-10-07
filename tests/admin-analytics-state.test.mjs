import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:analytics-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "analytics-state-runtime", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { for (const slot of slots) slot?.cleanup?.(); slots = []; cursor = 0; effects = []; }
      export function begin() { cursor = 0; effects = []; }
      export function useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; }
      export function useEffect(callback, deps) { const i = cursor++, previous = slots[i]?.deps; if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) effects.push({ i, callback, deps }); }
      export function commit() { const pending = effects; effects = []; for (const { i, callback, deps } of pending) { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; } }
    `; },
    transform(source, id) { if (id.endsWith("/features/admin/admin-analytics-panel.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());
const { AdminEconomyWorkspace } = await vite.ssrLoadModule("/features/admin/admin-analytics-panel.tsx");
const hooks = await vite.ssrLoadModule(hookModule);
const originals = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window };
afterEach(() => { hooks.reset(); Object.assign(globalThis, originals); });
const owner = "7K3P-2Q9M-W8ZR", publicId = "7K3P-2Q9M-W8ZS";
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function elements(tree) { const result = []; function walk(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, walk); } walk(tree); return result; }
function response(url, extra = {}) {
  const parsed = new URL(url, "https://test.invalid"), q = parsed.searchParams;
  const now = new Date().toISOString(), from = q.get("from"), to = q.get("to");
  const endAt = q.get("at") ?? now;
  const shared = { serverTime: now, from, to, q: q.get("q"), scope: q.get("scope"), startAt: `${from}T00:00:00Z`, endAt };
  return parsed.pathname.endsWith("events") ? { ...shared, kind: q.get("kind"), resource: q.get("resource"), direction: q.get("direction"), at: q.get("at"), offset: Number(q.get("offset")), limit: Number(q.get("limit")), total: 70,
    events: [{ id: `event:${q.get("offset")}`, publicId, displayName: "Игрок", createdAt: new Date(Date.parse(endAt) - 1000).toISOString(), kind: "sell", targetId: "wood", quantity: 1, contextKnown: true, category: "gameplay", coins: 10, pearls: 0, items: { wood: -1 } }], ...extra }
    : { ...shared, summary: { activePlayers: 1, events: 1, spendingPlayers: 0, constructionStarts: 0, constructionClaims: 0, constructionPlayers: 0 }, daily: [], resources: [], flows: [], actions: [], construction: [], firstConstructions: [], buildingLevels: [], gameplay: { mealsConsumed: 0, foodPlayers: 0, ordersCompleted: 0, orderPlayers: 0, orderCoinsEarned: 0, orderReplacements: 0, paidOrderReplacements: 0, orderPearlsSpent: 0 }, meals: [], orders: [], presence: { coverageFrom: null, players: 0, onlineSeconds: 0, flaggedPlayers: 0, daily: [], reviewDays: [], reviewDaysTruncated: false }, coverage: { firstRecordedAt: null, unattributedEvents: 0, matchingPlayers: 1, initializedPlayers: 1, flowsTruncated: false, actionsTruncated: false, ordersTruncated: false }, ...extra };
}
function setup() {
  hooks.reset(); const requests = [], errors = [], timers = new Map(); let nextTimer = 0;
  const listeners = new Map();
  globalThis.document = { visibilityState: "visible", addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); } };
  globalThis.window = { setInterval: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearInterval: id => timers.delete(id) };
  globalThis.fetch = (url, options) => url.endsWith("/access") ? Promise.resolve(Response.json({ publicId: owner, displayName: "Админ", serverTime: new Date().toISOString() })) : new Promise((resolve, reject) => requests.push({ url, options, resolve: body => resolve(Response.json(body ?? response(url))), reject }));
  const props = { actorPublicId: owner, refreshVersion: 0, onAccessLost: error => errors.push(error), onOpen() {}, historyRequest: null };
  function render() { hooks.begin(); const tree = AdminEconomyWorkspace(props); hooks.commit(); return { tree, elements: elements(tree) }; }
  return { requests, errors, timers, listeners, render, props };
}
test("draft filters wait for apply; an aborted old response cannot replace a newer player snapshot", async () => {
  const app = setup(); app.render(); await tick(); assert.equal(app.requests.length, 1);
  let view = app.render(); view.elements.find(node => node.type === "input" && node.props.type === "search").props.onChange({ target: { value: "Другой" } });
  view = app.render(); await tick(); assert.equal(app.requests.length, 1, "typing does not query a partly changed filter");
  view.elements.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); app.render(); await tick();
  assert.equal(app.requests.length, 2); assert.equal(app.requests[0].options.signal.aborted, true);
  app.requests[1].resolve(); await tick(); view = app.render();
  assert.equal(view.elements.find(node => node.type.name === "AdminAnalyticsContent").props.data.q, "Другой");
  app.requests[0].resolve(); await tick(); view = app.render();
  assert.equal(view.elements.find(node => node.type.name === "AdminAnalyticsContent").props.data.q, "Другой");
});
test("same-filter refresh errors keep the snapshot, changed-filter errors never expose the previous selection", async () => {
  const app = setup(); app.render(); await tick(); app.requests[0].resolve(); await tick();
  let view = app.render(); view.elements.find(node => node.type === "button" && node.props.children?.includes?.("Обновить")).props.onClick();
  app.render(); await tick(); app.requests[1].reject(new Error("offline")); await tick(); view = app.render();
  assert.ok(view.elements.find(node => node.type.name === "AdminAnalyticsContent"));
  assert.ok(view.elements.find(node => node.props.role === "alert"));
  view.elements.find(node => node.type === "input" && node.props.type === "search").props.onChange({ target: { value: "Missing" } });
  view = app.render(); view.elements.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); app.render(); await tick();
  app.requests[2].reject(new Error("offline")); await tick(); view = app.render();
  assert.equal(view.elements.some(node => node.type.name === "AdminAnalyticsContent"), false);
});
test("journal pages retain server anchor; explicit refresh clears it and returns to page one", async () => {
  const app = setup(); let view = app.render(); view.tree.props.onValueChange("events"); app.render(); await tick();
  assert.equal(app.requests.length, 1); const first = response(app.requests[0].url); app.requests[0].resolve(first); await tick();
  view = app.render(); view.elements.find(node => node.type.name === "AdminAnalyticsEventList").props.onPage(25); app.render(); await tick();
  const second = new URL(app.requests[1].url, "https://test.invalid"); assert.equal(second.searchParams.get("at"), first.endAt); assert.equal(second.searchParams.get("offset"), "25");
  app.requests[1].resolve(); await tick(); view = app.render(); app.listeners.get("visibilitychange")(); await tick();
  assert.equal(app.requests.length, 2, "visible journal does not silently move its pages");
  view.elements.find(node => node.type === "button" && node.props.children?.includes?.("Обновить")).props.onClick(); app.render(); await tick();
  const refresh = new URL(app.requests[2].url, "https://test.invalid"); assert.equal(refresh.searchParams.get("at"), null); assert.equal(refresh.searchParams.get("offset"), "0");
  app.requests[2].resolve(); await tick();
});
test("administrator account changes clear retained analytics and stop before a new data read", async () => {
  const app = setup(); app.render(); await tick(); app.requests[0].resolve(); await tick();
  let view = app.render(); assert.ok(view.elements.find(node => node.type.name === "AdminAnalyticsContent"));
  const requests = [];
  globalThis.fetch = async url => { requests.push(url); return Response.json({ publicId, displayName: "Другой админ", serverTime: new Date().toISOString() }); };
  view.elements.find(node => node.type === "button" && node.props.children?.includes?.("Обновить")).props.onClick(); app.render(); await tick(); view = app.render();
  assert.deepEqual(requests, ["/api/v1/admin/access"]);
  assert.equal(app.errors[0].status, 403);
  assert.equal(view.elements.some(node => node.type.name === "AdminAnalyticsContent"), false);
});
