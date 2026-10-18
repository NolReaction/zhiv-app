import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), virtual = "virtual:leaftail-arrival-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "arrival-hook-lifecycle", enforce: "pre",
    resolveId(id) { if (id === virtual) return `\0${id}`; },
    load(id) { if (id === `\0${virtual}`) return `
      let slots = [], cursor = 0, effects = [], cleanup = [];
      export function reset() { cleanup.forEach(fn => fn()); slots = []; cursor = 0; effects = []; cleanup = []; }
      export function render() { cursor = 0; }
      export function useMemo(make, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i])))
          slots[index] = { value: make(), dependencies };
        return slots[index].value;
      }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
        return [slots[index], value => { slots[index] = value; }]; }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useLayoutEffect(callback, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
          slots[index] = dependencies; effects.push(() => { const result = callback(); if (result) cleanup.push(result); });
        }
      }
      export const useEffect = useLayoutEffect;
      export function useCallback(callback, dependencies) { return useMemo(() => callback, dependencies); }
      export function useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }
      export function flushEffects() { const pending = effects; effects = []; pending.forEach(callback => callback()); }
    `; },
    transform(source, id) { if (id.endsWith("/features/world/state/use-leaftail-arrival.ts"))
      return source.replace('from "react";', `from "${virtual}";`); },
  }] });
after(() => vite.close());
const hooks = await vite.ssrLoadModule(virtual);
const { useLeaftailArrival } = await vite.ssrLoadModule("/features/world/state/use-leaftail-arrival.ts");
const opts = { unlocked: true, enabled: true, onboarding: { loaded: true, isPaused: false, progress: { version: 2, status: "completed" } } };
function browser(run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window"), data = new Map(), listeners = new Map();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) },
    addEventListener(type, callback) { listeners.set(callback, type); }, removeEventListener(_type, callback) { listeners.delete(callback); },
  } });
  function useArrivalRender(owner, options = opts) { hooks.render(); const value = useLeaftailArrival(owner, options); hooks.flushEffects(); return value; }
  hooks.reset();
  try { run({ render: useArrivalRender, data }); }
  finally { hooks.reset(); if (original) Object.defineProperty(globalThis, "window", original); else delete globalThis.window; }
}

test("closing the sailing coach still permits one completion message, while reload restores its dismissal", () => browser(({ render }) => {
  render("hook-arrival-one"); let value = render("hook-arrival-one");
  assert.equal(value.open, true); value.dismiss(); value = render("hook-arrival-one");
  assert.equal(value.open, false); assert.equal(value.seen, false); assert.equal(value.enabled, true);
  value.complete(); value = render("hook-arrival-one");
  assert.equal(value.seen, true); assert.equal(value.open, true); assert.equal(value.enabled, false);
  value.dismiss(); value = render("hook-arrival-one"); assert.equal(value.open, false);
  hooks.reset(); render("hook-arrival-one"); value = render("hook-arrival-one");
  assert.equal(value.seen, true); assert.equal(value.open, false, "restoring seen progress does not report a fresh return");
}));

test("late arrival callbacks and completion messages stay with the account that owned the boat", () => browser(({ render, data }) => {
  render("hook-arrival-old"); const old = render("hook-arrival-old"); old.dismiss();
  render("hook-arrival-new"); let current = render("hook-arrival-new");
  old.complete(); old.dismiss(); current = render("hook-arrival-new");
  assert.equal(current.seen, false); assert.equal(current.open, true);
  assert.equal(JSON.parse(data.get("zhiv.leaftail-arrival.v1:hook-arrival-old")).arrived, false);
  current.dismiss(); current.complete(); current = render("hook-arrival-new"); assert.equal(current.open, true);
  render("hook-arrival-third"); current = render("hook-arrival-third", { ...opts, enabled: false });
  assert.equal(current.open, false); assert.equal(current.seen, false);
}));
