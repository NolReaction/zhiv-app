import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:earth-editor-action-hooks";
// Use the real editor handlers and store. Only scheduling/mount effects are
// adapted: these tests do not claim to exercise native pointer or keyboard DOM.
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-editor-action-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) {
      if (id === `\0${hooksId}`) return `
        let current, cursor;
        function slot(create) { const index = cursor++; if (!(index in current)) current[index] = create(); return current[index]; }
        export function begin(state) { current = state; cursor = 0; }
        export function useState(initial) { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, next => { state.value = typeof next === 'function' ? next(state.value) : next; }]; }
        export function useRef(value) { return slot(() => ({ current: value })); }
        export function useId() { return slot(() => 'editor-test-id'); }
        export function useCallback(callback) { return callback; }
        export function useEffect() {}
        export function useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot(); }
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/earth/dev/earth-model-editor.tsx")) return source.replace('from "react";', `from "${hooksId}";`);
    },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { EarthModelEditor } = await vite.ssrLoadModule("/features/earth/dev/earth-model-editor.tsx");
const store = await vite.ssrLoadModule("/features/earth/model-placement.ts");
function nodes(tree) {
  const all = [];
  const visit = node => { if (isValidElement(node)) { all.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return all;
}
const text = node => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : isValidElement(node) ? text(node.props.children) : "";
function editor() {
  const state = [];
  const props = { map: {}, visible: true, open: true, onOpenChange() {} };
  const render = () => { hooks.begin(state); return nodes(EarthModelEditor(props)); };
  const button = (all, label) => all.find(node => node.type === "button" && text(node) === label);
  return { render, button,
    select(id) { render().find(node => node.type === "select").props.onChange({ currentTarget: { value: id } }); },
  };
}

test("switching models uses their own physical baseline for percentages, resize and reset", () => {
  store.resetEarthModelPlacements();
  const initial = JSON.parse(store.exportEarthModelPlacements()), app = editor();
  try {
    assert.equal(app.render().filter(node => node.type === "option").length, 9);
    for (const [id, base] of [["christ-redeemer", 38], ["great-wall-badaling", 20], ["giza-pyramids", 146.6]]) {
      app.select(id);
      let all = app.render();
      assert.equal(text(all.find(node => node.type === "output")), "100%");
      app.button(all, "Больше").props.onClick();
      all = app.render();
      assert.ok(Math.abs(store.getEarthModelPlacements().find(row => row.id === id).heightMeters - base * 1.1) < 1e-9);
      assert.equal(text(all.find(node => node.type === "output")), "110%");
      assert.equal(app.button(all, "100%").props.title, `Исходный размер: ${base} м`);
      app.button(all, "100%").props.onClick();
      assert.equal(store.getEarthModelPlacements().find(row => row.id === id).heightMeters, base);
    }
    assert.deepEqual(store.getEarthModelPlacements()[0], initial.placements[0], "editing other objects preserves the user's Eiffel settings");
  } finally { store.resetEarthModelPlacements(); }
});

test("saving after independent model edits sends a validated full catalogue and retains all rows", async () => {
  store.resetEarthModelPlacements();
  const originalFetch = globalThis.fetch, app = editor(), requests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/dev/earth-models");
    requests.push(options ?? {});
    return Response.json({ revision: (options?.method === "POST" ? "b" : "a").repeat(64) });
  };
  try {
    app.select("statue-of-liberty");
    app.button(app.render(), "Больше").props.onClick();
    app.select("sydney-opera");
    app.button(app.render(), "Больше").props.onClick();
    app.button(app.render(), "Сохранить в проект").props.onClick();
    for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2, "save obtains the revision before its atomic project write");
    const saved = JSON.parse(requests[1].body);
    assert.equal(saved.revision, "a".repeat(64));
    assert.equal(saved.document.placements.length, 9);
    assert.deepEqual(saved.document, JSON.parse(store.exportEarthModelPlacements()));
    assert.ok(Math.abs(saved.document.placements.find(row => row.id === "statue-of-liberty").heightMeters - 102.3) < 1e-9);
    assert.equal(saved.document.placements.find(row => row.id === "sydney-opera").heightMeters, 71.5);
    assert.deepEqual(saved.document.placements[0], store.getEarthModelPlacementDefaults()[0]);
    assert.match(text(app.render()), /Настройки записаны в проект/);
  } finally { globalThis.fetch = originalFetch; store.resetEarthModelPlacements(); }
});
