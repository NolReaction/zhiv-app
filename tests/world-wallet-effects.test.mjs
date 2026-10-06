import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:wallet-effect-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "wallet-effect-handlers", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function flush() { effects.forEach(callback => callback()); }
      export function dispose() { slots.forEach(slot => slot?.cleanup?.()); }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useLayoutEffect(callback, deps) {
        const index = cursor++, old = slots[index];
        if (!old || deps.some((value, i) => value !== old.deps[i])) effects.push(() => {
          old?.cleanup?.(); slots[index] = { deps, cleanup: callback() };
        });
      }
    `; },
    transform(source, id) { if (id.endsWith("/features/world/world-wallet.tsx")) return source.replace('from "react";', `from "${hookModule}";`).replace("function Currency(", "export function Currency("); },
  }],
});
after(() => vite.close());
const { Currency } = await vite.ssrLoadModule("/features/world/world-wallet.tsx");
const hooks = await vite.ssrLoadModule(hookModule);

test("wallet animation halves pearl counts and deltas through gains, spending and reduced motion", context => {
  const previous = Object.fromEntries(["window", "document", "requestAnimationFrame", "cancelAnimationFrame"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map(), motion = { matches: false, addEventListener() {}, removeEventListener() {} };
  let nextFrame = 0, animations = 0;
  Object.assign(globalThis, { window: { matchMedia: () => motion }, document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id) });
  context.mock.method(performance, "now", () => 0);
  hooks.reset();
  const render = amount => {
    hooks.render(); const nodes = [];
    function visit(element) { if (!isValidElement(element)) return; nodes.push(element); Children.forEach(element.props.children, visit); }
    visit(Currency({ kind: "pearls", amount }));
    for (const node of nodes) if (node.props.ref) {
      node.props.ref.current ??= { textContent: "", hidden: true, dataset: {}, getAnimations: () => [], animate: () => { animations++; return { cancel() {} }; } };
      if (typeof node.props.children === "string") node.props.ref.current.textContent = node.props.children;
    }
    hooks.flush();
    const refs = nodes.filter(node => node.props.ref).map(node => node.props.ref.current);
    return { count: refs[0], effect: refs[1], delta: refs[2] };
  };
  const finish = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(650)); };
  try {
    let ui = render(7); assert.equal(ui.count.textContent, "3,5"); assert.equal(animations, 0);
    ui = render(108); assert.equal(ui.count.textContent, "3,5"); assert.equal(ui.delta.textContent, "+50,5");
    assert.equal(ui.effect.dataset.direction, "gain"); finish(); assert.equal(ui.count.textContent, "54");
    ui = render(7); assert.equal(ui.delta.textContent, "−50,5"); assert.equal(ui.effect.dataset.direction, "spend");
    finish(); assert.equal(ui.count.textContent, "3,5"); assert.equal(animations, 2);
    render(7); assert.equal(animations, 2, "polling the same balance creates no new effect");
    motion.matches = true; ui = render(8); assert.equal(ui.count.textContent, "4"); assert.equal(ui.effect.hidden, true); assert.equal(animations, 2);
  } finally {
    hooks.dispose();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
