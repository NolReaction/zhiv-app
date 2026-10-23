import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hookModule = "virtual:neighbor-admin-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "neighbor-admin-state", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots=[],cursor=0,effects=[];
      export function reset(){for(const slot of slots)slot?.cleanup?.();slots=[];cursor=0;effects=[];}
      export function begin(){cursor=0;effects=[];}
      export function useState(initial){const i=cursor++;if(!(i in slots))slots[i]={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;}];}
      export function useRef(initial){const i=cursor++;return slots[i]??={current:initial};}
      export function useEffect(callback,deps){const i=cursor++,prior=slots[i]?.deps;if(!prior||deps.some((v,j)=>!Object.is(v,prior[j])))effects.push({i,callback,deps});}
      export const useLayoutEffect=useEffect;
      export function commit(){const pending=effects;effects=[];for(const{i,callback,deps}of pending){slots[i]?.cleanup?.();slots[i]={deps,cleanup:callback()};}}
    `; },
    transform(source, id) { if (id.endsWith("/features/admin/admin-neighbor-panel.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }] });
after(() => vite.close());
const { AdminNeighborPanel } = await vite.ssrLoadModule("/features/admin/admin-neighbor-panel.tsx");
const { loadAdminNeighbor, writeAdminNeighbor, definitiveNeighborFailure } = await vite.ssrLoadModule("/features/admin/admin-neighbor-api.ts");
const { readNeighborAttempt, saveNeighborAttempt } = await vite.ssrLoadModule("/features/admin/admin-neighbor-journal.ts");
const { neighborDefaultSettings } = await vite.ssrLoadModule("/features/economy/domain/neighbor-model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const { getAdminAudit } = await vite.ssrLoadModule("/features/admin/admin-api.ts");
const { adminActionName, adminActionDetails } = await vite.ssrLoadModule("/features/admin/admin-audit-details.ts");
const hooks = await vite.ssrLoadModule(hookModule);
const original = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
afterEach(() => { hooks.reset(); Object.assign(globalThis, original); });
const actor = "7K3P-2Q9M-W8ZR", target = "7K3P-2Q9M-W8ZS", other = "7K3P-2Q9M-W8ZT";
const requestId = "9a272b65-8ada-4b0d-aad8-6a6ef845f41b", listingId = "8a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const serverTime = "2026-10-23T12:00:00Z";
const lot = { id: listingId, sellerPublicId: target, sellerName: "Игрок", itemId: "wood", quantity: 1, totalPrice: 20,
  proceedsCoins: 10, createdAt: serverTime, eligible: true, reason: null };
const view = (selected = false) => ({ serverTime, settings: structuredClone(neighborDefaultSettings), version: 7, pausedReason: null,
  player: selected ? { publicId: target, name: "Игрок" } : null, usage: { usedLots: 0, spentCoins: 0, globalSpentCoins: 0 },
  pending: selected ? [lot] : [], history: [], receipt: null });
const attempt = () => ({ kind: "buy", body: { requestId, listingId, playerPublicId: target, expectedTotalPrice: 20, reason: "Проверка первой продажи" }, selection: lot });
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
function nodes(tree) { const result = []; function walk(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, walk); } walk(tree); return result; }
const text = value => typeof value === "string" ? value : Array.isArray(value) ? value.map(text).join("") : "";
const button = (tree, label) => nodes(tree).find(node => node.type === "button" && text(node.props.children) === label);
function setup(data = new Map()) {
  const state = { actor, denied: [], sent: [], post: body => Response.json({ ...view(true), receipt: { requestId: body.requestId, replayed: false } }), reads: 0 };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, sessionStorage: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key),
  } };
  globalThis.document = { activeElement: null }; globalThis.HTMLElement = class {};
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/access")) return Response.json({ publicId: state.actor, displayName: "Админ", serverTime });
    if (options.method === "POST") { const body = JSON.parse(options.body); state.sent.push(body); return state.post(body); }
    state.reads++;
    return Response.json(view(url.includes("publicId=")));
  };
  const props = { actorPublicId: actor, onAccessLost: error => state.denied.push(error) };
  const render = () => { hooks.begin(); const tree = AdminNeighborPanel(props); hooks.commit(); return tree; };
  return { state, data, render };
}

test("production GET with explicit receipt:null is accepted; wrong player snapshot is rejected", async () => {
  setup();
  assert.equal((await loadAdminNeighbor(actor, "", new AbortController().signal)).receipt, null);
  assert.equal((await loadAdminNeighbor(actor, target, new AbortController().signal)).player.publicId, target);
  await assert.rejects(loadAdminNeighbor(actor, other, new AbortController().signal), error => error.status === 502);
});

test("actor verification rejects a late snapshot and prevents writes by another administrator", async () => {
  const app = setup(); let access = 0;
  globalThis.fetch = async url => url.endsWith("/access")
    ? Response.json({ publicId: ++access === 1 ? actor : other, displayName: "Админ", serverTime }) : Response.json(view());
  await assert.rejects(loadAdminNeighbor(actor, "", new AbortController().signal), error => error.status === 403);
  app.state.actor = other;
  await assert.rejects(writeAdminNeighbor(actor, "buy", attempt().body, new AbortController().signal), error => error.status === 403);
  assert.equal(app.state.sent.length, 0);
});

test("journal binds the exact visible seller, lot and price to one actor across reload", () => {
  const app = setup();
  assert.equal(saveNeighborAttempt(actor, attempt()), true);
  assert.equal(readNeighborAttempt(actor).body.expectedTotalPrice, 20);
  assert.equal(readNeighborAttempt(other), null);
  const key = [...app.data.keys()][0];
  app.data.set(key, JSON.stringify({ ...attempt(), body: { ...attempt().body, playerPublicId: other } }));
  assert.equal(readNeighborAttempt(actor), null);
  app.data.set(key, JSON.stringify({ ...attempt(), selection: { ...lot, totalPrice: 30 } }));
  assert.equal(readNeighborAttempt(actor), null);
});

test("lost reply and rate limit preserve identical payload; receipt must match request", async () => {
  const app = setup(), body = attempt().body;
  app.state.post = () => { throw new TypeError("Lost acknowledgement after commit"); };
  await assert.rejects(writeAdminNeighbor(actor, "buy", body, new AbortController().signal));
  app.state.post = () => Response.json({ code: "RATE_LIMITED", message: "Позже" }, { status: 429 });
  await assert.rejects(writeAdminNeighbor(actor, "buy", body, new AbortController().signal), error => error.status === 429);
  app.state.post = () => Response.json({ ...view(true), receipt: { requestId, replayed: true } });
  assert.equal((await writeAdminNeighbor(actor, "buy", body, new AbortController().signal)).receipt.replayed, true);
  assert.deepEqual(app.state.sent, [body, body, body]);
  app.state.post = () => Response.json({ ...view(true), receipt: { requestId: listingId, replayed: true } });
  await assert.rejects(writeAdminNeighbor(actor, "buy", body, new AbortController().signal), error => error.status === 502);
});

test("only explicit precommit rejection codes clear the pending request", () => {
  for (const code of ["NEIGHBOR_QUOTE_CHANGED", "NEIGHBOR_PLAYER_NOT_FOUND", "NEIGHBOR_LISTING_UNAVAILABLE", "NEIGHBOR_VERSION_CONFLICT", "INVALID_NEIGHBOR_SETTINGS"])
    assert.equal(definitiveNeighborFailure(new ApiError("Отказ", 409, { code, message: "Отказ" })), true, code);
  for (const [status, code] of [[409, "ADMIN_REQUEST_CONFLICT"], [409, "UNKNOWN"], [429, "RATE_LIMITED"], [503, "NEIGHBOR_VERSION_CONFLICT"]])
    assert.equal(definitiveNeighborFailure(new ApiError("Сбой", status, { code, message: "Сбой" })), false, code);
});

test("neighbor audit actions keep the general audit page readable", async () => {
  globalThis.fetch = async () => Response.json({ serverTime, total: 2, offset: 0, limit: 25, events: ["neighbor_settings", "neighbor_buy"].map(action => ({
    requestId, actorPublicId: actor, targetPublicId: target, action, reason: "Проверка настроек", affectedSessions: 0, createdAt: serverTime,
  })) });
  const result = await getAdminAudit({ offset: 0, limit: 25 });
  assert.equal(result.events.length, 2);
  assert.equal(adminActionName("neighbor_settings"), "Настройки лесного соседа");
  assert.equal(adminActionName("neighbor_buy"), "Выкуп лесным соседом");
  assert.match(adminActionDetails(JSON.stringify({ request: { expectedVersion: 7, settings: { ...neighborDefaultSettings, autoBuyEnabled: false } } })), /на паузе/);
  assert.match(adminActionDetails(JSON.stringify({ request: attempt().body })), /20 монет · Персонаж мира/);
});

test("restored operation stays private until actor check, never autosubmits, and ignores double click", async () => {
  const app = setup(); saveNeighborAttempt(actor, attempt());
  assert.equal(button(app.render(), "Проверить тот же запрос"), undefined);
  await tick(); let tree = app.render();
  assert.ok(button(tree, "Проверить тот же запрос")); assert.equal(app.state.sent.length, 0);
  button(tree, "Проверить тот же запрос").props.onClick(); tree = app.render();
  const confirm = nodes(tree).find(node => node.type === "input" && node.props.type === "checkbox");
  confirm.props.onChange({ target: { checked: true } }); tree = app.render();
  let resolve; app.state.post = () => new Promise(done => { resolve = done; });
  const send = button(tree, "Повторить тот же запрос").props.onClick;
  send(); send(); await tick(); assert.equal(app.state.sent.length, 1);
  resolve(Response.json({ ...view(true), receipt: { requestId, replayed: true } })); await tick();
  app.render(); assert.equal(readNeighborAttempt(actor), null);
  assert.equal(button(app.render(), "Проверить тот же запрос"), undefined);
});

test("uncertain reply keeps journal on explicit retry and account switch hides private data", async () => {
  const app = setup(); saveNeighborAttempt(actor, attempt()); app.render(); await tick();
  let tree = app.render(); button(tree, "Проверить тот же запрос").props.onClick(); tree = app.render();
  nodes(tree).find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
  tree = app.render(); app.state.post = () => { throw new TypeError("Network lost"); };
  button(tree, "Повторить тот же запрос").props.onClick(); await tick();
  assert.equal(readNeighborAttempt(actor).body.requestId, requestId);
  tree = app.render(); app.state.post = () => { app.state.actor = other; return Response.json({ ...view(true), receipt: { requestId, replayed: true } }); };
  button(tree, "Повторить тот же запрос").props.onClick(); await tick(); tree = app.render();
  assert.equal(app.state.denied.length, 1);
  assert.equal(button(tree, "Проверить тот же запрос"), undefined);
  assert.equal(readNeighborAttempt(actor).body.requestId, requestId);
  assert.equal(readNeighborAttempt(other), null);
});
