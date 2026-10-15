import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:activity-ui-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-activity-ui-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "activity-ui-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let frames = new Map(), slots, cursor = 0, effects = [], dirty = false;
      export function reset() { for (const frame of frames.values()) for (const slot of frame) if (slot.current?.effect) slot.current.cleanup?.(); frames.clear(); }
      export function render(key) { slots = frames.get(key) ?? []; frames.set(key, slots); cursor = 0; effects = []; dirty = false; }
      export function flush() { for (const effect of effects) effect(); }
      export function needsRender() { return dirty; }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { const next = typeof value === 'function' ? value(slot.current) : value; if (!Object.is(next, slot.current)) { slot.current = next; dirty = true; } }]; }
      export function useId() { return useRef('activity-ui-' + cursor).current; }
      export function useMemo(factory, dependencies) { const prior = useRef(null); if (!prior.current || dependencies.some((value, i) => !Object.is(value, prior.current.dependencies[i]))) prior.current = { dependencies, value: factory() }; return prior.current.value; }
      export function useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) { return typeof document === 'undefined' ? getServerSnapshot() : getSnapshot(); }
      export function useEffect(effect, dependencies = []) { const prior = useRef(null); if (!prior.current || dependencies.some((value, i) => !Object.is(value, prior.current.dependencies[i]))) { const previous = prior.current, next = { effect: true, dependencies, cleanup: undefined }; prior.current = next; effects.push(() => { previous?.cleanup?.(); next.cleanup = effect(); }); } }
      export function useLayoutEffect(effect) { effect(); }
    `; },
    transform(source, id) { if (["/features/activity/activity-gate.tsx", "/features/activity/connection-status.tsx"].some(suffix => id.endsWith(suffix))) return source.replace('from "react";', `from "${hooksId}";`); },
  }] });
after(() => { hooks.reset(); return vite.close(); });
const hooks = await vite.ssrLoadModule(hooksId);
const { ActivityGate } = await vite.ssrLoadModule("/features/activity/activity-gate.tsx");
const { ConnectionStatus, CONNECTION_PENDING_DELAY_MS, connectConnectionStatusHost } = await vite.ssrLoadModule("/features/activity/connection-status.tsx");
function nodes(tree) { const found = []; const visit = node => { if (node?.$$typeof === Symbol.for("react.portal")) Children.forEach(node.children, visit); else if (isValidElement(node)) { found.push(node); Children.forEach(node.props.children, visit); } }; visit(tree); return found; }
function render(component, props, beforeEffects) { let tree, passes = 0; do { hooks.render(component.name); tree = component(props); beforeEffects?.(tree); hooks.flush(); assert.ok(++passes < 10, "state settles after derived display reset"); } while (hooks.needsRender()); return { tree, nodes: nodes(tree) }; }
const text = node => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement(node) ? text(node.props.children) : "";
const button = view => view.nodes.find(node => node.type === "button" && !node.props["data-connection-toggle"] && node.props["aria-label"] !== "Закрыть состояние связи");
const attr = (view, name) => view.nodes.find(node => node.props[name] !== undefined);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function activity(patch = {}) { return { mode: "away", online: true, active: false, resumeRequired: false, retrySeconds: 0, error: null, resume() { assert.fail("opening a pause notice must not resume"); }, retry() { assert.fail("opening a pause notice must not retry"); }, ...patch }; }

function connectionDOM({ observer = true } = {}) {
  const observers = [], document = {};
  class Element {
    constructor(attributes = {}) { this.nodeType = 1; this.ownerDocument = document; this.attributes = new Map(Object.entries(attributes)); this.children = []; this.parentElement = null; this.rects = [{}]; this.visibility = "visible"; this.listeners = new Map(); }
    get isConnected() { return document.body.contains(this); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    removeAttribute(key) { this.attributes.delete(key); }
    getClientRects() { return this.rects; }
    matches(selector) { return selector.split(",").some(part => [...part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) => this.attributes.has(name) && (value === undefined || this.attributes.get(name) === value))); }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    addEventListener(name, callback, capture) { this.listeners.set(name, { callback, capture }); }
    removeEventListener(name, callback, capture) { const entry = this.listeners.get(name); if (entry?.callback === callback && entry.capture === capture) this.listeners.delete(name); }
  }
  document.body = new Element(); document.createElement = () => new Element();
  document.querySelectorAll = selector => { const result = []; const visit = node => { if (node.matches(selector)) result.push(node); node.children.forEach(visit); }; document.body.children.forEach(visit); return result; };
  document.defaultView = { getComputedStyle: element => ({ visibility: element.visibility }), MutationObserver: observer ? class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
    deliver() { this.callback([]); }
  } : undefined };
  const append = (attributes = {}, parent = document.body) => parent.appendChild(new Element(attributes));
  const dialog = (attributes = {}) => append({ "data-slot": "dialog-content", role: "dialog", "aria-modal": "true", "data-state": "open", ...attributes });
  return { document, observers, append, dialog };
}


test("retained AFK is a compact modal layer whose outside and Escape cannot restart the scene", () => {
  hooks.reset(); const view = render(ActivityGate, { activity: activity(), retained: true });
  assert.equal(view.tree.props.modal, true); assert.equal(view.tree.props.open, true);
  const content = attr(view, "data-activity-gate"); assert.equal(content.props["data-retained-world"], true);
  assert.equal(view.nodes.some(node => node.type === "main"), false);
  assert.match(text(view.tree), /Начатые работы продолжаются/); assert.equal(text(button(view)), "Продолжить");
  let prevented = 0; content.props.onEscapeKeyDown({ preventDefault() { prevented++; } }); content.props.onInteractOutside({ preventDefault() { prevented++; } }); assert.equal(prevented, 2);
});

test("retained network/hidden states yield to the connection icon while initial startup stays honest", () => {
  for (const mode of ["offline", "hidden", "active"]) {
    hooks.reset(); assert.equal(render(ActivityGate, { activity: activity({ mode, online: mode !== "offline", active: mode === "active" }), retained: true }).tree, null);
  }
  hooks.reset(); const initial = render(ActivityGate, { activity: activity({ mode: "offline", online: false }) });
  assert.ok(attr(initial, "data-activity-startup")); assert.match(text(initial.tree), /Подключись к сети, чтобы загрузить игру/);
  assert.doesNotMatch(text(initial.tree), /Ваш профиль и ресурсы сохранены/); assert.equal(button(initial).props.disabled, true);
  hooks.reset(); const checking = render(ActivityGate, { activity: activity({ mode: "connecting" }), retained: true });
  assert.equal(button(checking), undefined); assert.equal(attr(checking, "data-activity-gate").props["aria-busy"], true);
});

test("an AFK return that loses its connection keeps a compact waiting layer over the paused scene", () => {
  hooks.reset(); const view = render(ActivityGate, { retained: true, activity: activity({ mode: "offline", online: false, resumeRequired: true }) });
  assert.ok(attr(view, "data-activity-gate")); assert.equal(view.nodes.some(node => node.type === "main"), false);
  assert.match(text(view.tree), /Ждём сеть.*Игра остаётся на паузе.*чтобы продолжить/);
  assert.doesNotMatch(text(view.tree), /загрузить игру/); assert.equal(button(view).props.disabled, true);
  button(view).props.onClick();
  assert.equal(render(ActivityGate, { retained: true, activity: activity({ mode: "hidden", online: false, resumeRequired: true }) }).tree, null);
  assert.equal(render(ActivityGate, { activity: activity({ mode: "hidden", online: false, resumeRequired: true }) }).tree, null);
});

test("the pause action resumes explicitly once and stale modes, offline state or retry deadlines refuse captured clicks", async () => {
  hooks.reset(); const pending = deferred(), calls = [], props = { retained: true, activity: activity({ resume() { calls.push("resume"); return pending.promise; } }) };
  const view = render(ActivityGate, props), resume = button(view); resume.props.onClick(); resume.props.onClick(); assert.deepEqual(calls, ["resume"]);
  pending.resolve(); await tick();
  for (const patch of [{ mode: "connecting" }, { mode: "active", active: true }, { online: false }, { retrySeconds: 3 }]) {
    hooks.reset(); const blockedCalls = [], previous = activity({ resume() { blockedCalls.push("resume"); }, retry() { blockedCalls.push("retry"); } });
    const old = button(render(ActivityGate, { retained: true, activity: previous }));
    render(ActivityGate, { retained: true, activity: { ...previous, ...patch } }); old.props.onClick(); assert.deepEqual(blockedCalls, []);
  }
});

test("pause focus returns only to a connected interactive retained target", () => {
  const savedDocument = globalThis.document, savedElement = globalThis.HTMLElement;
  try {
    class Element { constructor() { this.isConnected = true; this.inert = false; this.focuses = 0; } focus() { this.focuses++; } closest() { return this.inert ? {} : null; } }
    globalThis.HTMLElement = Element;
    for (const invalid of ["valid", "detached", "inert"]) {
      hooks.reset(); const target = new Element(); globalThis.document = { activeElement: target };
      const view = render(ActivityGate, { activity: activity(), retained: true }), content = attr(view, "data-activity-gate");
      const heading = view.nodes.find(node => node.props.ref && node.props.tabIndex === -1); let headingFocus = 0; heading.props.ref.current = { focus() { headingFocus++; } };
      content.props.onOpenAutoFocus({ preventDefault() {} }); assert.equal(headingFocus, 1);
      if (invalid === "detached") target.isConnected = false;
      if (invalid === "inert") target.inert = true;
      content.props.onCloseAutoFocus({ preventDefault() {} }); assert.equal(target.focuses, invalid === "valid" ? 1 : 0);
    }
  } finally { globalThis.document = savedDocument; globalThis.HTMLElement = savedElement; }
});

test("connection problems appear immediately as an icon without opening their details", () => {
  hooks.reset(); assert.equal(render(ConnectionStatus, { online: true }).tree, null);
  for (const props of [{ online: false }, { online: true, reconnecting: true }, { online: false, queuedCount: 13 }, { online: true, pending: true, error: "Сервер недоступен" }, { online: true, error: "Сервер недоступен" }]) {
    hooks.reset(); const view = render(ConnectionStatus, props); assert.equal(view.tree.props.open, false);
    assert.ok(attr(view, "data-connection-toggle")); assert.equal(attr(view, "data-connection-details"), undefined);
    assert.doesNotMatch(attr(view, "data-connection-toggle").props["aria-label"], /Подключено|Сохранено/);
    if (props.queuedCount) assert.match(text(view.tree), /9\+/);
    if (props.pending || props.queuedCount) assert.equal(attr(view, "data-connection-status").props["data-connection-pending"], true);
  }
});

test("healthy production acknowledgements under the pending delay never flash a connection indicator", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); hooks.reset();
  const props = { online: true, pending: true, queuedCount: 1 };
  assert.equal(render(ConnectionStatus, props).tree, null);
  t.mock.timers.tick(CONNECTION_PENDING_DELAY_MS - 1); assert.equal(render(ConnectionStatus, props).tree, null);
  props.pending = false; props.queuedCount = 0; assert.equal(render(ConnectionStatus, props).tree, null);
  t.mock.timers.tick(CONNECTION_PENDING_DELAY_MS * 2); assert.equal(render(ConnectionStatus, props).tree, null);
});

test("real unconfirmed work becomes visible after its delay and growing the same queue does not restart that delay", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); hooks.reset();
  const props = { online: true, pending: true, queuedCount: 1 };
  assert.equal(render(ConnectionStatus, props).tree, null); t.mock.timers.tick(CONNECTION_PENDING_DELAY_MS - 100);
  props.queuedCount = 13; assert.equal(render(ConnectionStatus, props).tree, null);
  t.mock.timers.tick(100); const view = render(ConnectionStatus, props);
  assert.equal(view.tree.props.open, false); assert.match(attr(view, "data-connection-toggle").props["aria-label"], /13/);
  assert.match(text(view.tree), /9\+/); assert.equal(attr(view, "data-connection-status").props["data-connection-pending"], true);
  assert.equal(attr(view, "data-connection-toggle").props["data-unstable"], undefined);
});

test("a later pending batch gets a fresh delay while offline pending remains visible after connection recovery", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); hooks.reset();
  const props = { online: true, pending: true };
  render(ConnectionStatus, props); t.mock.timers.tick(CONNECTION_PENDING_DELAY_MS - 100);
  props.pending = false; render(ConnectionStatus, props); props.pending = true; render(ConnectionStatus, props);
  t.mock.timers.tick(100); assert.equal(render(ConnectionStatus, props).tree, null, "previous batch timer cannot reveal a new batch");
  t.mock.timers.tick(CONNECTION_PENDING_DELAY_MS - 100); assert.ok(attr(render(ConnectionStatus, props), "data-connection-toggle"));
  hooks.reset(); props.online = false;
  assert.ok(attr(render(ConnectionStatus, props), "data-connection-toggle")); props.online = true;
  assert.ok(attr(render(ConnectionStatus, props), "data-connection-toggle"), "transport recovery still has unconfirmed work");
  props.pending = false; assert.equal(render(ConnectionStatus, props).tree, null);
});

test("connection details report unconfirmed queue truthfully and opening, closing or cancellation sends nothing", () => {
  hooks.reset(); const calls = [], props = { online: false, queuedCount: 2, pending: true, onRetry() { calls.push("retry"); } };
  let view = render(ConnectionStatus, props); view.tree.props.onOpenChange(true); view = render(ConnectionStatus, props);
  assert.match(text(view.tree), /В очереди: 2.*ещё не подтверждены сервером/); assert.equal(button(view).props.disabled, true);
  button(view).props.onClick(); assert.deepEqual(calls, []);
  let stopped = 0; attr(view, "data-connection-details").props.onEscapeKeyDown({ stopPropagation() { stopped++; } }); assert.equal(stopped, 1);
  view.tree.props.onOpenChange(false); view = render(ConnectionStatus, props); assert.equal(attr(view, "data-connection-details"), undefined); assert.deepEqual(calls, []);
});

test("connection retry honors the latest network/transport state, cooldown and in-flight latch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const patch of [{ online: false }, { reconnecting: true }, { busy: true }, { retrySeconds: 4 }, { pending: false }]) {
    hooks.reset(); const calls = [], props = { online: true, pending: true, onRetry() { calls.push("retry"); } };
    render(ConnectionStatus, props); t.mock.timers.tick(CONNECTION_PENDING_DELAY_MS);
    let view = render(ConnectionStatus, props); view.tree.props.onOpenChange(true); view = render(ConnectionStatus, props); const oldButton = button(view);
    Object.assign(props, patch); render(ConnectionStatus, props); oldButton.props.onClick(); assert.deepEqual(calls, [], JSON.stringify(patch));
  }
  hooks.reset(); const pending = deferred(), calls = [], props = { online: true, pending: true, onRetry() { calls.push("retry"); return pending.promise; } };
  render(ConnectionStatus, props); t.mock.timers.tick(CONNECTION_PENDING_DELAY_MS);
  let view = render(ConnectionStatus, props); view.tree.props.onOpenChange(true); view = render(ConnectionStatus, props);
  button(view).props.onClick(); button(view).props.onClick(); assert.deepEqual(calls, ["retry"]);
  pending.resolve(); await tick();
  view = render(ConnectionStatus, props); button(view).props.onClick(); assert.deepEqual(calls, ["retry", "retry"]); await tick();
});

test("resolved connections remove their details without reopening them on the next outage", () => {
  hooks.reset(); const props = { online: false }; let view = render(ConnectionStatus, props);
  view.tree.props.onOpenChange(true); view = render(ConnectionStatus, props); assert.ok(attr(view, "data-connection-details"));
  props.online = true; assert.equal(render(ConnectionStatus, props).tree, null);
  props.online = false; view = render(ConnectionStatus, props); assert.equal(view.tree.props.open, false); assert.equal(attr(view, "data-connection-details"), undefined);
});

test("compact overlays leave the scene visible and network animations honor reduced motion", async () => {
  const gate = await readFile(new URL("../features/activity/activity.module.css", import.meta.url), "utf8");
  const status = await readFile(new URL("../features/activity/connection-status.module.css", import.meta.url), "utf8");
  assert.match(gate, /width:min\(320px/); assert.doesNotMatch(gate, /blur\(/); assert.match(gate, /background:rgb\(8 18 12 \/ 14%\)/);
  assert.match(status, /safe-area-inset-top/); assert.match(status, /connection-pulse/);
  assert.match(status, /prefers-reduced-motion:reduce[^}]*animation:none/);
  assert.match(gate, /prefers-reduced-motion:reduce[^}]*animation:none/);
});


test("closing connection details restores its button only while no higher layer owns focus", () => {
  for (const blocked of [false, true]) {
    hooks.reset(); const props = { online: false }; let view = render(ConnectionStatus, props);
    const trigger = attr(view, "data-connection-toggle"); let focuses = 0;
    trigger.props.ref.current = { isConnected: true, closest() { return blocked ? {} : null; }, focus() { focuses++; } };
    view.tree.props.onOpenChange(true); view = render(ConnectionStatus, props);
    attr(view, "data-connection-details").props.onCloseAutoFocus({ preventDefault() {} });
    assert.equal(focuses, blocked ? 0 : 1);
  }
});

test("one network host follows the top visible modal and ignores its own portaled details", () => {
  const dom = connectionDOM(), fallback = dom.append(), host = dom.document.createElement("span"), outer = dom.dialog();
  const orders = dom.dialog({ "aria-hidden": "true" }); let moves = 0;
  const stop = connectConnectionStatusHost(host, fallback, () => { moves++; });
  assert.equal(host.parentElement, outer); assert.equal(moves, 0);
  assert.equal(dom.observers[0].target, dom.document.body); assert.equal(dom.observers[0].options.subtree, true);
  outer.setAttribute("aria-hidden", "true"); orders.removeAttribute("aria-hidden"); dom.observers[0].deliver();
  assert.equal(host.parentElement, orders); assert.equal(moves, 1);
  dom.append({ "data-slot": "dialog-content", role: "dialog", "aria-modal": "true", "data-connection-details": "" }, host);
  dom.observers[0].deliver(); assert.equal(host.parentElement, orders); assert.equal(moves, 1);
  orders.remove(); outer.removeAttribute("aria-hidden"); dom.observers[0].deliver();
  assert.equal(host.parentElement, outer); assert.equal(moves, 2, "closing the nested dialog returns the same host to the scene dialog");
  stop(); assert.equal(host.parentElement, null); assert.equal(dom.observers[0].disconnected, true);
  dom.observers[0].deliver(); assert.equal(host.parentElement, null, "a queued observer callback cannot reattach after unmount");
});

test("closed, inert, hidden and zero-size dialog remnants cannot capture the connection indicator", () => {
  const dom = connectionDOM(), fallback = dom.append(), host = dom.document.createElement("span"), outer = dom.dialog();
  dom.dialog({ "data-state": "closed" }); dom.dialog({ inert: "" }); dom.dialog({ hidden: "" }); dom.dialog({ "aria-hidden": "true" });
  dom.dialog().rects = []; dom.dialog().visibility = "hidden";
  const stop = connectConnectionStatusHost(host, fallback, () => assert.fail("ignored dialogs must not move the host"));
  assert.equal(host.parentElement, outer); dom.observers[0].deliver(); assert.equal(host.parentElement, outer); stop();
});

test("the network indicator does not enter AFK or another-device gates and missing observers still clean up", () => {
  for (const attribute of ["data-activity-gate", "data-forest-session-notice"]) {
    const dom = connectionDOM(), fallback = dom.append(), host = dom.document.createElement("span"), outer = dom.dialog(), gate = dom.dialog({ [attribute]: "" });
    outer.setAttribute("aria-hidden", "true"); const stop = connectConnectionStatusHost(host, fallback, () => {});
    assert.equal(host.parentElement, fallback); assert.notEqual(host.parentElement, gate);
    gate.remove(); outer.removeAttribute("aria-hidden"); dom.observers[0].deliver(); assert.equal(host.parentElement, outer); stop();
  }
  const dom = connectionDOM({ observer: false }), fallback = dom.append(), host = dom.document.createElement("span");
  const stop = connectConnectionStatusHost(host, fallback, () => {}); assert.equal(host.parentElement, fallback); stop(); assert.equal(host.parentElement, null);
});

test("Radix outside events from the moved indicator cannot dismiss its modal while unrelated or blocked events stay untouched", () => {
  const dom = connectionDOM(), fallback = dom.append(), host = dom.document.createElement("span"), outer = dom.dialog();
  const stop = connectConnectionStatusHost(host, fallback, () => {}), control = dom.append({}, host), unrelated = dom.append();
  const pointer = host.listeners.get("dismissableLayer.pointerDownOutside"), focus = host.listeners.get("dismissableLayer.focusOutside");
  const event = target => ({ target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  for (const entry of [pointer, focus]) {
    assert.equal(entry.capture, true, "Radix outside custom events do not bubble");
    const own = event(control); entry.callback(own); assert.equal(own.defaultPrevented, true);
    const outside = event(unrelated); entry.callback(outside); assert.equal(outside.defaultPrevented, false);
  }
  const nested = dom.dialog(); outer.setAttribute("aria-hidden", "true"); dom.observers[0].deliver(); assert.equal(host.parentElement, nested);
  for (const entry of [pointer, focus]) { const own = event(control); entry.callback(own); assert.equal(own.defaultPrevented, true); }
  for (const attribute of ["data-activity-gate", "data-forest-session-notice"]) {
    const gate = dom.dialog({ [attribute]: "" }); dom.observers[0].deliver(); assert.equal(host.parentElement, fallback);
    for (const entry of [pointer, focus]) { const own = event(control); entry.callback(own); assert.equal(own.defaultPrevented, false); }
    gate.remove(); dom.observers[0].deliver();
  }
  host.setAttribute("inert", ""); for (const entry of [pointer, focus]) { const own = event(control); entry.callback(own); assert.equal(own.defaultPrevented, false); } host.removeAttribute("inert");
  stop(); assert.equal(host.listeners.size, 0);
  for (const entry of [pointer, focus]) { const stale = event(control); entry.callback(stale); assert.equal(stale.defaultPrevented, false); }
});

test("indicator and details share one browser host; modal moves close details without retry or later automatic reopening", () => {
  hooks.reset(); const previous = globalThis.document, dom = connectionDOM(), fallback = dom.append(), outer = dom.dialog(), calls = [];
  globalThis.document = dom.document;
  try {
    const props = { online: false, onRetry() { calls.push("retry"); } };
    const draw = () => render(ConnectionStatus, props, tree => { attr({ nodes: nodes(tree) }, "data-connection-placement").props.ref.current = fallback; });
    let view = draw(); assert.equal(view.nodes.filter(node => node.props["data-connection-status"]).length, 1);
    const host = outer.children[0]; assert.equal(host.attributes.has("data-connection-status-host"), true);
    view.tree.props.onOpenChange(true); view = draw(); assert.ok(attr(view, "data-connection-details"));
    assert.ok(view.nodes.some(node => node.props.container === host), "details stay within the same accessible modal host");
    const closingDetails = attr(view, "data-connection-details"); let focuses = 0;
    attr(view, "data-connection-toggle").props.ref.current = { isConnected: true, closest() { return null; }, focus() { focuses++; } };
    const nested = dom.dialog(); outer.setAttribute("aria-hidden", "true"); dom.observers[0].deliver();
    view = draw(); assert.equal(host.parentElement, nested); assert.equal(view.tree.props.open, false); assert.equal(attr(view, "data-connection-details"), undefined);
    closingDetails.props.onCloseAutoFocus({ preventDefault() {} }); assert.equal(focuses, 0, "a new modal keeps its own focus when network details close during a move");
    assert.deepEqual(calls, []); props.online = true; assert.equal(render(ConnectionStatus, props).tree, null);
    assert.equal(host.parentElement, null); assert.equal(dom.observers[0].disconnected, true);
    props.online = false; view = draw(); assert.equal(view.tree.props.open, false); assert.equal(attr(view, "data-connection-details"), undefined); assert.deepEqual(calls, []);
  } finally { hooks.reset(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});
