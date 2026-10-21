import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:earth-diagnostic-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-diagnostic-actions", enforce: "pre",
    resolveId(id) { if (id === hooksId) return "\0" + id; },
    load(id) { if (id === "\0" + hooksId) return `
      export { lazy, Suspense } from "react";
      let current, cursor;
      function slot(create) { const index=cursor++; return current.slots[index] ??= create(); }
      export function begin(state) { current=state; cursor=0; state.dirty=false; }
      export function useRef(value) { return slot(()=>({current:value})); }
      export function useState(initial) { const owner=current, state=slot(()=>{const value=typeof initial==='function'?initial():initial;return {value:value==='loading'?'ready':value};}); return [state.value,value=>{const next=typeof value==='function'?value(state.value):value;if(!Object.is(state.value,next)){state.value=next;owner.dirty=true;}}]; }
      export const useCallback=callback=>callback;
      export function useEffect(callback,dependencies) { const state=slot(()=>({dependencies:null,cleanup:null})); if(!state.dependencies||dependencies.some((v,i)=>!Object.is(v,state.dependencies[i]))){state.dependencies=dependencies;current.pending.push(()=>{state.cleanup?.();state.cleanup=callback();});} }
      export const useLayoutEffect=useEffect;
      export const useSyncExternalStore=(subscribe,snapshot)=>snapshot();
      export function flush(state) { for(const effect of state.pending.splice(0))effect(); }
      export function dispose(state) { for(const value of state.slots)value.cleanup?.(); }
    `; },
    transform(source, id) { if (id.endsWith("/features/earth/earth-map.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId), { EarthMap } = await vite.ssrLoadModule("/features/earth/earth-map.tsx");
const { EarthMapInfo } = await vite.ssrLoadModule("/features/earth/earth-map-info.tsx");
function harness(writeText) {
  const globals = new Map(["window", "document", "navigator"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: new EventTarget(), document: { hidden: false }, navigator: { clipboard: { writeText } } }))
    Object.defineProperty(globalThis, name, { value, configurable: true });
  const state = { slots: [], pending: [], dirty: false }, focused = [], selected = [], info = [];
  const props = { position: null, active: true, visible: true, focusRequest: 0, isOnline: true, onLocate() {},
    locating: false, locationActive: false, locationStatus: "unavailable", locationDetails: null, infoOpen: true,
    onInfoOpenChange(value) { info.push(value); props.infoOpen = value; } };
  function render() {
    for (let pass = 0; pass < 10; pass++) {
      hooks.begin(state); const tree = EarthMap(props), nodes = [];
      const visit = node => { if (isValidElement(node)) { nodes.push(node); if (node.type === EarthMapInfo) visit(EarthMapInfo(node.props)); else Children.forEach(node.props.children, visit); } };
      visit(tree);
      for (const node of nodes) if (["button", "textarea", "h2"].includes(node.type) && node.props.ref)
        node.props.ref.current = { focus() { focused.push(node.props["aria-label"] ?? node.type); }, select() { selected.push(node.type); } };
      // No MapLibre host is attached: this checks real UI actions and effects,
      // not WebGL, native focus trapping or layout.
      hooks.flush(state);
      if (!state.dirty) return nodes;
    }
    throw new Error("View did not settle");
  }
  return { render, focused, selected, info, dispose() { hooks.dispose(state);
    for (const [name, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  } };
}
const button = (nodes, label) => nodes.find(node => node.type === "button" && node.props["aria-label"] === label);

test("DEV copy exports a safe report without initiating map installation or geographic requests", async () => {
  const copied = [], app = harness(async text => copied.push(text));
  try {
    await button(app.render(), "Скопировать диагностику карты").props.onClick();
    const report = JSON.parse(copied[0]);
    assert.equal(report.map.phase, "ready"); assert.equal(report.counters.created, undefined);
    assert.equal(report.map.cartographyReady, false);
    assert.equal(report.location.status, "unavailable"); assert.equal(report.location.hasPosition, false);
    assert.ok(button(app.render(), "Отчёт карты скопирован"));
    assert.equal(app.render().some(node => node.type === "textarea"), false);
    assert.deepEqual(app.info, []);
  } finally { app.dispose(); }
});

test("clipboard refusal closes info, selects the fallback report and returns focus on Escape or close", async () => {
  const app = harness(async () => { throw new DOMException("Blocked", "NotAllowedError"); });
  try {
    for (const close of ["escape", "button"]) {
      await button(app.render(), "Скопировать диагностику карты").props.onClick();
      const nodes = app.render(), field = nodes.find(node => node.type === "textarea");
      assert.equal(field.props.readOnly, true); assert.equal(JSON.parse(field.props.value).version, 1);
      assert.equal(app.focused.at(-1), "Отчёт диагностики карты"); assert.equal(app.selected.at(-1), "textarea");
      assert.equal(nodes.some(node => node.props.id === "earth-info-panel"), false);
      if (close === "escape") nodes.find(node => node.props["aria-labelledby"] === "earth-diagnostic-title").props.onKeyDown({ key: "Escape", stopPropagation() {} });
      else button(nodes, "Закрыть диагностику").props.onClick();
      assert.equal(app.focused.at(-1), "Скопировать диагностику карты");
      assert.equal(app.render().some(node => node.type === "textarea"), false);
    }
    assert.deepEqual(app.info, [false, false]);
  } finally { app.dispose(); }
});
