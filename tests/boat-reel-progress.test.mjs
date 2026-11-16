import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hookId = "virtual:boat-progress-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "boat-progress-lifecycle", enforce: "pre",
    resolveId(id) { if (id === hookId) return `\0${id}`; },
    load(id) { if (id === `\0${hookId}`) return `
      let slots = [], cursor = 0, effects = [];
      export function begin() { cursor = 0; }
      export function useRef(value) { return slots[cursor++] ??= { current: value }; }
      export function useEffect(callback, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
          const slot = { dependencies, cleanup: previous?.cleanup }; slots[index] = slot;
          effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
        }
      }
      export function flush() { const pending = effects; effects = []; pending.forEach(run => run()); }
      export function unmount() { for (const slot of slots) slot?.cleanup?.(); slots = []; effects = []; }
    `; },
    transform(code, id) { if (id.endsWith("/boat-reel-progress.tsx")) return code.replace('from "react";', `from "${hookId}";`); },
  }] });
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hookId);
const { BoatReelProgress, createBoatProgressMilestones } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-progress.tsx");
let saved, media, document, accents;
beforeEach(() => {
  saved = ["window", "document"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  media = Object.assign(new EventTarget(), { matches: false }); document = { hidden: false }; accents = [];
  Object.assign(globalThis, { window: { matchMedia: () => media }, document });
});
afterEach(() => { hooks.unmount(); for (const [name, descriptor] of saved) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
} });

const flat = node => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(flat)];
function fixture(initial = {}) {
  const elements = new Map(), props = { value: 2500, playing: false, danger: false, ...initial };
  let tree;
  function render(patch = {}) {
    Object.assign(props, patch); hooks.begin(); tree = BoatReelProgress(props);
    for (const node of flat(tree)) if (node.props?.ref) {
      const key = node.props["data-progress-mark"] ?? "track";
      if (!elements.has(key)) elements.set(key, { animate(keyframes, options) {
        const animation = { key, keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
        accents.push(animation); return animation;
      } });
      if (typeof node.props.ref === "function") node.props.ref(elements.get(key));
      else node.props.ref.current = elements.get(key);
    }
    hooks.flush(); return tree;
  }
  render(); return { render, get tree() { return tree; } };
}

test("semantic progress and the gradient clip represent the exact bounded controller value", () => {
  const f = fixture();
  for (const value of [0, 1250, 2500, 7800, 10000]) {
    const tree = f.render({ value }), native = flat(tree).find(node => node.type === "progress");
    assert.equal(native.props.value, value); assert.equal(native.props.max, 10000);
    assert.equal(tree.props.style["--reel-progress"], `${value / 100}%`);
    assert.deepEqual(flat(tree).filter(node => node.props?.["data-progress-mark"]).map(node => node.props["data-progress-mark"]), [25, 50, 75]);
  }
  assert.equal(flat(f.render({ value: Number.NaN })).find(node => node.type === "progress").props.value, 0);
  assert.equal(flat(f.render({ value: 11000 })).find(node => node.type === "progress").props.value, 10000);
});

test("quarter accents acknowledge only new live progress and never replay a restored or regained milestone", () => {
  const f = fixture({ value: 5000 }); assert.equal(accents.length, 0);
  f.render({ playing: true }); f.render({ value: 6000 }); assert.equal(accents.length, 0);
  f.render({ value: 7500 }); assert.equal(accents.length, 1); assert.equal(accents[0].key, 75);
  f.render({ playing: false }); assert.equal(accents[0].cancelled, true);
  f.render({ playing: true }); f.render({ value: 6000 }); f.render({ value: 7500 }); assert.equal(accents.length, 1);
  f.render({ value: 10000 }); assert.equal(accents.length, 2); assert.equal(accents[1].key, "track");
  hooks.unmount(); assert.equal(accents[1].cancelled, true);
});

test("reduced motion, hidden state and risk consume crossings silently instead of playing delayed accents", () => {
  const f = fixture({ value: 0, playing: true });
  f.render({ value: 2500 }); assert.equal(accents.length, 1);
  media.matches = true; media.dispatchEvent(new Event("change")); assert.equal(accents[0].cancelled, true);
  f.render({ value: 5000 }); media.matches = false; media.dispatchEvent(new Event("change"));
  document.hidden = true; f.render({ value: 7500 }); document.hidden = false;
  f.render({ value: 10000, danger: true }); f.render({ danger: false });
  assert.equal(accents.length, 1);
});

test("progress reached behind an open panel cannot become a fresh milestone when the panel closes", () => {
  const tracker = createBoatProgressMilestones(2500);
  assert.equal(tracker.update(5000, false), null);
  assert.equal(tracker.update(5000, true), null);
  assert.equal(tracker.update(7500, true), 3);
  assert.equal(tracker.update(7000, true), null);
  assert.equal(tracker.update(7500, true), null);
});
