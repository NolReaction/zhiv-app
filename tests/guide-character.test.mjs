import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:guide-character-hooks";
const vite = await createServer({
  appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{
    name: "guide-character-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) {
      if (id === `\0${hookModule}`) return `
        let slots = [], cursor = 0, effects = [];
        export function reset() { dispose(); slots = []; cursor = 0; effects = []; }
        export function render() { cursor = 0; effects = []; }
        export function flush() { const pending = effects; effects = []; for (const fn of pending) fn(); }
        export function dispose() { for (const slot of slots) slot?.cleanup?.(); }
        export function useRef(initial) { return slots[cursor++] ??= { current: initial }; }
        export function useState(initial) {
          const slot = slots[cursor++] ??= { value: initial };
          return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
        }
        export function useSyncExternalStore(_, snapshot) { return snapshot(); }
        export function useEffect(effect, dependencies) {
          const index = cursor++, previous = slots[index];
          if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i])))
            effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
        }
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/onboarding/guide-character.tsx")) return source.replace('from "react";', `from "${hookModule}";`);
    },
  }],
});
after(() => vite.close());
const { GuideCharacter } = await vite.ssrLoadModule("/features/onboarding/guide-character.tsx");
const { GuideCoach } = await vite.ssrLoadModule("/features/onboarding/guide-coach.tsx");
const { GUIDE_REACTION_DURATION_MS } = await vite.ssrLoadModule("/features/onboarding/guide-portrait-animation.ts");
const hooks = await vite.ssrLoadModule(hookModule);
function nodes(tree) {
  const result = [];
  const walk = element => {
    if (!isValidElement(element)) return;
    result.push(element); Children.forEach(element.props.children, walk);
  };
  walk(tree); return result;
}
function environment() {
  const names = ["document", "performance", "setTimeout", "clearTimeout"];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let now = 0, timerId = 0;
  const timers = new Map(), listeners = new Set();
  const doc = { visibilityState: "visible", addEventListener(_, fn) { listeners.add(fn); }, removeEventListener(_, fn) { listeners.delete(fn); } };
  const replacements = { document: doc, performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: replacements[name] });
  hooks.reset();
  return {
    timers, listeners,
    render() { hooks.render(); const result = GuideCharacter({ pose: "present", stepId: "explore" }); hooks.flush(); return result; },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    visibility(value) { doc.visibilityState = value; for (const fn of listeners) fn(); },
    restore() { hooks.dispose(); for (const name of names) { const value = originals.get(name); if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; } },
  };
}

test("petting the portrait is a labelled native button, varies the reaction, and contains the click", () => {
  const env = environment();
  try {
    let tree = env.render(), stopped = 0;
    assert.equal(tree.type, "button");
    assert.equal(tree.props.type, "button", "petting cannot submit a parent form");
    assert.equal(tree.props["aria-label"], "Погладить Мохлика");
    const reactions = [];
    for (let i = 0; i < 3; i++) {
      tree.props.onClick({ stopPropagation() { stopped++; } });
      tree = env.render();
      reactions.push(nodes(tree).find(node => node.props.role === "status").props.children);
      assert.equal(env.timers.size, 1, "rapid taps replace the bounded reaction rather than queueing effects");
    }
    assert.equal(stopped, 3, "the click cannot reach any ancestor game action");
    assert.equal(new Set(reactions).size, 3);
    tree.props.onKeyDown({ key: "Enter", stopPropagation() { stopped++; } });
    tree.props.onKeyDown({ key: " ", stopPropagation() { stopped++; } });
    assert.equal(stopped, 5, "keyboard activation stays on the native button without cancelling its default click");
    tree.props.onKeyDown({ key: "Escape", stopPropagation() { stopped++; } });
    assert.equal(stopped, 5, "Escape remains available to pause the enclosing guide");
    env.advance(GUIDE_REACTION_DURATION_MS);
    tree = env.render();
    assert.equal(nodes(tree).find(node => node.props.role === "status").props.children, "");
    assert.equal(env.timers.size, 0);
  } finally { env.restore(); }
});

test("portrait speech waits through a hidden tab, then expires and cleans up", () => {
  const env = environment();
  try {
    env.render().props.onClick({ stopPropagation() {} });
    env.render();
    env.advance(400);
    env.visibility("hidden");
    assert.equal(env.render().props["data-paused"], true);
    assert.equal(env.timers.size, 0);
    env.advance(60_000);
    env.visibility("visible");
    assert.equal(env.timers.size, 1);
    env.advance(GUIDE_REACTION_DURATION_MS - 401);
    assert.notEqual(nodes(env.render()).find(node => node.props.role === "status").props.children, "");
    env.advance(1);
    assert.equal(nodes(env.render()).find(node => node.props.role === "status").props.children, "");
    assert.equal(env.listeners.size, 0);
  } finally { env.restore(); }
});

test("the guide renders the optional neighbor content between the explanation and the hint", () => {
  const env = environment();
  try {
    const html = renderToStaticMarkup(createElement(GuideCoach, {
      open: true, flow: "world", stepId: "neighbors", pose: "present", title: "Знакомимся", text: "MAIN EXPLANATION", hint: "ACTION HINT",
      onPause() { assert.fail("rendering cannot pause the guide"); }, onSkip() { assert.fail("rendering cannot skip the guide"); },
    }, createElement("button", { type: "button", "data-neighbor": "shishkolap" }, "NEIGHBOR CARD")));
    assert.ok(html.indexOf("MAIN EXPLANATION") < html.indexOf("NEIGHBOR CARD"));
    assert.ok(html.indexOf("NEIGHBOR CARD") < html.indexOf("ACTION HINT"));
    assert.match(html, /data-neighbor="shishkolap"/);
    assert.doesNotMatch(html, /aria-modal|role="dialog"/);
  } finally { env.restore(); }
});
