import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:guide-portrait-hooks";
const vite = await createServer({
  appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{
    name: "guide-portrait-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) {
      if (id === `\0${hookModule}`) return `
        let canvas = null, effect = null;
        export function setCanvas(value) { canvas = value; }
        export function useRef() { return { current: canvas }; }
        export function useEffect(value) { effect = value; }
        export function start() { return effect(); }
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/onboarding/guide-portrait.tsx")) return source.replace('from "react";', `from "${hookModule}";`);
    },
  }],
});
after(() => vite.close());
const { guidePortraitFrame } = await vite.ssrLoadModule("/features/onboarding/guide-portrait-animation.ts");
const { GuidePortrait } = await vite.ssrLoadModule("/features/onboarding/guide-portrait.tsx");
const hooks = await vite.ssrLoadModule(hookModule);

function environment({ reducedMotion = false, hidden = false } = {}) {
  const names = ["document", "window", "performance", "setTimeout", "clearTimeout"];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const timers = new Map(), listeners = new Map(), motionListeners = new Set(), draws = [];
  let nextTimer = 0, now = 0;
  const motion = { matches: reducedMotion, addEventListener: (_, fn) => motionListeners.add(fn), removeEventListener: (_, fn) => motionListeners.delete(fn) };
  const doc = {
    visibilityState: hidden ? "hidden" : "visible",
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    createElement() {
      const drawing = [], surface = { width: 0, height: 0, drawing };
      const ctx = { fillStyle: "", fillRect(x, y, w, h) { drawing.push([x, y, w, h, ctx.fillStyle]); } };
      surface.getContext = () => ctx;
      return surface;
    },
  };
  const ctx = { clearRect() {}, drawImage(sprite) { draws.push(sprite.drawing); } };
  hooks.setCanvas({ getContext: () => ctx });
  const replacements = { document: doc, window: { matchMedia: () => motion }, performance: { now: () => now },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: replacements[name] });
  return {
    timers, draws, listeners, motionListeners,
    start(pose, stepId) { GuidePortrait({ pose, stepId }); return hooks.start(); },
    advance(ms) { now += ms; const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); },
    visibility(value) { doc.visibilityState = value; listeners.get("visibilitychange")?.(); },
    motion(value) { motion.matches = value; for (const fn of motionListeners) fn(); },
    restore() { for (const name of names) { const original = originals.get(name); if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name]; } },
  };
}

test("the guide changes actual sprite pixels during a gesture, and changing steps changes its pose", () => {
  const env = environment();
  let stop;
  try {
    stop = env.start("greet", "hello");
    const greeting = env.draws.at(-1);
    env.advance(300);
    assert.notDeepEqual(env.draws.at(-1), greeting, "a waving paw changes the painted sprite, not only CSS position");
    stop();
    assert.equal(env.timers.size, 0);
    stop = env.start("wonder", "explore");
    assert.notDeepEqual(env.draws.at(-1), greeting, "the next explanation has a genuinely different expression and pose");
    stop();
    stop = env.start("present", "well-done");
    assert.notDeepEqual(env.draws.at(-1), greeting);
  } finally { stop?.(); env.restore(); }
});

test("hidden tabs stop the portrait timer and resume the gesture without replaying the hidden interval", () => {
  const env = environment();
  let stop;
  try {
    stop = env.start("reach", "berries");
    env.advance(300);
    env.visibility("hidden");
    const painted = env.draws.length;
    assert.equal(env.timers.size, 0);
    env.advance(60_000);
    assert.equal(env.draws.length, painted);
    env.visibility("visible");
    assert.equal(env.timers.size, 1);
    assert.equal(env.draws.length, painted, "returning to the tab keeps the paused animation frame");
    env.advance(300);
    assert.equal(env.draws.length, painted + 1);
    stop(); stop = undefined;
    assert.equal(env.timers.size, 0);
    assert.equal(env.listeners.size, 0);
    assert.equal(env.motionListeners.size, 0);
  } finally { stop?.(); env.restore(); }
});

test("reduced motion displays the requested poses without running frame timers, including live preference changes", () => {
  const env = environment({ reducedMotion: true });
  let stop;
  try {
    stop = env.start("hold", "harvest");
    const held = env.draws.at(-1);
    assert.ok(held.length > 0);
    assert.equal(env.timers.size, 0);
    stop();
    stop = env.start("present", "finished");
    assert.notDeepEqual(env.draws.at(-1), held, "reduced motion still changes the pose for the next step");
    assert.equal(env.timers.size, 0);
    env.motion(false);
    assert.equal(env.timers.size, 1);
    env.motion(true);
    assert.equal(env.timers.size, 0);
  } finally { stop?.(); env.restore(); }
});

test("long explanations settle a reaching/holding gesture instead of continuously bending", () => {
  for (const pose of ["reach", "hold"]) {
    const settled = guidePortraitFrame(pose, 1500);
    assert.deepEqual(guidePortraitFrame(pose, 4000), settled);
    assert.deepEqual(guidePortraitFrame(pose, 50_000, true), settled);
    assert.deepEqual(guidePortraitFrame(pose, Number.NaN), guidePortraitFrame(pose, 0));
  }
});
