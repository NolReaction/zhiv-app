import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:earth-editor-view-hooks";
// Exercise the real view, hook and GPS controller; adapt only React scheduling.
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-editor-view-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) {
      if (id === `\0${hooksId}`) return `
        let current, cursor = 0;
        function slot(create) { const index = cursor++; if (!(index in current.slots)) current.slots[index] = create(); return current.slots[index]; }
        export function create() { return { slots: [], effects: new Set(), pending: new Map(), dirty: false }; }
        export function begin(root) { current = root; cursor = 0; root.dirty = false; }
        export function flush(root) { const work = [...root.pending]; root.pending.clear(); for (const [effect, callback] of work) { effect.cleanup?.(); effect.cleanup = callback(); } }
        export function destroy(root) { for (const effect of root.effects) effect.cleanup?.(); root.effects.clear(); }
        export function useRef(value) { return slot(() => ({ current: value })); }
        export function useState(initial) { const root = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { const next = typeof value === 'function' ? value(state.value) : value; if (!Object.is(next, state.value)) { state.value = next; root.dirty = true; } }]; }
        export function useMemo(create, dependencies) { const memo = slot(() => ({ dependencies: undefined, value: undefined })); if (!memo.dependencies || dependencies.some((value, index) => !Object.is(value, memo.dependencies[index]))) { memo.dependencies = dependencies; memo.value = create(); } return memo.value; }
        export function useCallback(callback, dependencies) { return useMemo(() => callback, dependencies); }
        export function useEffect(callback, dependencies) { const root = current, effect = slot(() => ({ dependencies: undefined, cleanup: undefined })); root.effects.add(effect); if (!effect.dependencies || dependencies.some((value, index) => !Object.is(value, effect.dependencies[index]))) { effect.dependencies = dependencies; root.pending.set(effect, callback); } }
        export const useLayoutEffect = useEffect;
        export function useSyncExternalStore(subscribe, getSnapshot) { const root = current; useEffect(() => subscribe(() => { root.dirty = true; }), [subscribe, getSnapshot]); return getSnapshot(); }
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/earth/earth-view.tsx") || id.endsWith("/features/earth/use-earth-location.ts"))
        return source.replace('from "react";', `from "${hooksId}";`);
    },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { EarthView } = await vite.ssrLoadModule("/features/earth/earth-view.tsx");
const { EarthMap } = await vite.ssrLoadModule("/features/earth/earth-map.tsx");
const nodes = tree => {
  const result = [];
  const visit = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return result;
};
const text = node => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : isValidElement(node) ? text(node.props.children) : "";
function setup({ rememberedOpen = false, environment = "development", online = true } = {}) {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = environment;
  const globals = new Map(["window", "document", "navigator"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const window = new EventTarget(), document = new EventTarget(), permission = new EventTarget();
  window.isSecureContext = true;
  window.sessionStorage = { getItem: () => rememberedOpen ? "1" : "0" };
  document.visibilityState = "visible"; permission.state = "prompt";
  const watches = [], cleared = [], publications = [], actions = [];
  const navigator = { permissions: { query: async () => permission }, geolocation: {
    watchPosition(success, failure) { watches.push({ success, failure }); return watches.length - 1; },
    clearWatch(id) { cleared.push(id); },
  } };
  for (const [name, value] of Object.entries({ window, document, navigator })) Object.defineProperty(globalThis, name, { value, configurable: true });
  const sharing = { settings: { mode: "SHARING", recipientCircleIds: ["friend-one"] }, pendingGhost: false, publishing: true,
    lastPublishedAt: "2026-10-19T00:00:00Z", people: [{ circleId: "friend-one", user: { displayName: "Лена" } }],
    setPosition: value => publications.push(value), stopPublishing: () => actions.push("stopPublishing"),
    ghost: () => actions.push("ghost"), off: () => actions.push("off"), refresh() {}, share: async () => true };
  const props = { ownerPublicId: "owner-test", active: true, visible: true, sharing, isOnline: online,
    people: null, peopleLoading: false, peopleError: null, onRefreshPeople() {}, onOpenPeople() {}, onOpenWorld() {} };
  const state = hooks.create();
  function render() {
    let tree, passes = 0;
    do { hooks.begin(state); tree = EarthView(props); hooks.flush(state); assert.ok(++passes < 15, "view settles"); } while (state.dirty);
    const all = nodes(tree);
    return { tree, all, map: all.find(node => node.type === EarthMap).props, text: text(tree) };
  }
  return { render, props, watches, cleared, publications, actions,
    destroy() {
      hooks.destroy(state);
      process.env.NODE_ENV = originalEnv;
      for (const [name, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
    },
  };
}
const fix = timestamp => ({ coords: { longitude: 2.29, latitude: 48.85, accuracy: 15 }, timestamp });

test("opening DEV3D removes social/GPS overlays, pauses a live private watch and resumes it on close", () => {
  const app = setup();
  try {
    let view = app.render();
    assert.match(view.text, /Близкие/);
    view.map.onLocate(); app.render();
    app.watches[0].success(fix(1000)); view = app.render();
    assert.equal(view.map.position.timestamp, 1000);
    assert.equal(view.map.friends.length, 1);
    view.map.onModelEditorOpenChange(true); view = app.render();
    assert.deepEqual(app.cleared, [0]);
    assert.equal(view.map.position, null);
    assert.equal(view.map.showLocationControl, false);
    assert.equal(view.map.locationDetails, null);
    assert.deepEqual(view.map.friends, []);
    assert.doesNotMatch(view.text, /Близкие|Ожидаем GPS|Делюсь|Только я/);
    assert.deepEqual(app.actions, [], "temporary pause does not revoke publication or consent");
    assert.equal(app.publications.at(-1), null);
    app.watches[0].failure({ code: 3 });
    view = app.render();
    assert.doesNotMatch(view.text, /слишком много времени/);
    view.map.onModelEditorOpenChange(false); view = app.render();
    assert.equal(app.watches.length, 2);
    assert.match(view.text, /Близкие/);
    assert.equal(view.map.showLocationControl, true);
    assert.equal(view.map.friends.length, 1);
    app.watches[1].success(fix(2000)); view = app.render();
    assert.equal(view.map.position.timestamp, 2000);
    assert.deepEqual(app.actions, []);
    app.watches[1].failure({ code: 3 }); view = app.render();
    assert.match(view.text, /слишком много времени/);
    assert.deepEqual(app.actions, ["stopPublishing"], "real GPS failures still stop publishing outside the editor");
  } finally { app.destroy(); }
});

test("publication expiry during editing does not discard the paused private GPS request", () => {
  const app = setup();
  try {
    let view = app.render(); view.map.onLocate(); app.render(); app.watches[0].success(fix(1000)); view = app.render();
    view.map.onModelEditorOpenChange(true); app.render();
    app.props.sharing = { ...app.props.sharing, publishing: false };
    view = app.render(); view.map.onModelEditorOpenChange(false); app.render();
    assert.equal(app.watches.length, 2);
    app.watches[1].success(fix(2000)); view = app.render();
    assert.equal(view.map.position.timestamp, 2000);
    assert.deepEqual(app.actions, []);
  } finally { app.destroy(); }
});

test("remembered development editor state is private before lazy mounting and production ignores it", () => {
  for (const environment of ["development", "production"]) {
    const app = setup({ rememberedOpen: true, environment, online: false });
    try {
      const view = app.render();
      assert.equal(view.map.showLocationControl, environment === "production");
      if (environment === "development") assert.doesNotMatch(view.text, /Близкие|Нет сети/);
      else { assert.match(view.text, /Близкие/); assert.match(view.text, /Нет сети/); }
      assert.equal(app.watches.length, 0);
    } finally { app.destroy(); }
  }
});
