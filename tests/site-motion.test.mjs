import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const compile = async filename => ts.transpileModule(await readFile(new URL(filename, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const [modelCode, canvasCode, motionCode] = await Promise.all([
  compile("../features/site/forest-atmosphere-model.ts"),
  compile("../features/site/forest-atmosphere.tsx"),
  compile("../features/site/use-site-motion.ts"),
]);
const modelContext = { exports: {} };
vm.runInNewContext(modelCode, modelContext, { filename: "forest-atmosphere-model.ts" });
const model = modelContext.exports;

class Target {
  listeners = new Map();
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, event = {}) { for (const callback of [...(this.listeners.get(name) ?? [])]) callback(event); }
  count(name) { return this.listeners.get(name)?.size ?? 0; }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

class Element extends Target {
  dataset = {};
  properties = new Map();
  writes = 0;
  rect = { width: 1200, height: 800, top: 0, bottom: 800 };
  reveals = [];
  scrollHeight = 3200;
  style = { setProperty: (key, value) => { this.properties.set(key, value); this.writes++; } };
  setAttribute(name, value) { assert.ok(name.startsWith("data-")); this.dataset[name.slice(5)] = value; }
  removeAttribute(name) { delete this.dataset[name.slice(5)]; }
  getBoundingClientRect() { return this.rect; }
  querySelectorAll() { return this.reveals; }
  contains(element) { return this.reveals.includes(element); }
  closest() { return this.revealParent ?? null; }
}

function environment({ coarse = false, reduced = false, observers = true } = {}) {
  const calls = { contexts: 0, gradients: 0, images: 0, clears: 0, canvases: 0, transforms: [], storeChanges: 0 };
  const context = {
    save() {}, restore() {}, fillRect() {},
    setTransform(...values) { calls.transforms.push(values); },
    clearRect() { calls.clears++; },
    drawImage() { calls.images++; },
    createRadialGradient() { calls.gradients++; return { addColorStop() {} }; },
  };
  const window = Object.assign(new Target(), { innerWidth: 1200, innerHeight: 800, scrollY: 0, devicePixelRatio: 3 });
  const document = Object.assign(new Target(), { hidden: false });
  const queries = new Map();
  const reducedQuery = Object.assign(new Target(), { matches: reduced });
  queries.set("(prefers-reduced-motion: reduce)", reducedQuery);
  queries.set("(pointer: coarse)", Object.assign(new Target(), { matches: coarse }));
  queries.set("(hover: hover) and (pointer: fine)", Object.assign(new Target(), { matches: !coarse }));
  window.matchMedia = name => { assert.ok(queries.has(name), `Unexpected media query: ${name}`); return queries.get(name); };
  const frames = new Map(), cancelled = [], resizes = [], intersections = [];
  let nextFrame = 0;
  window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = id => { cancelled.push(id); frames.delete(id); };
  function canvas() {
    const element = new Element();
    element.width = element.height = 0;
    element.getContext = () => { calls.contexts++; return context; };
    element.parentElement = new Element();
    return element;
  }
  document.createElement = name => { assert.equal(name, "canvas"); calls.canvases++; return canvas(); };
  class Observer {
    observed = new Set();
    disconnected = false;
    constructor(callback, list) { this.callback = callback; list.push(this); }
    observe(element) { this.observed.add(element); }
    unobserve(element) { this.observed.delete(element); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
  }
  const globals = { window, document, Element };
  if (observers) {
    globals.ResizeObserver = class extends Observer { constructor(callback) { super(callback, resizes); } };
    globals.IntersectionObserver = class extends Observer { constructor(callback) { super(callback, intersections); } };
  }
  return {
    calls, window, document, frames, cancelled, resizes, intersections, reducedQuery, canvas, globals,
    tick(now) {
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(now);
    },
  };
}

// Execute production effects and event handlers, replacing React scheduling
// and the browser surface. Animation callbacks remain callable after cancel
// to model a callback already queued when an effect unmounts.
function harness(code, { server = false, env = environment() } = {}) {
  const slots = [], pending = [], cleanups = new Map();
  let cursor = 0;
  const hooks = {
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useEffect(callback, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        slots[index] = dependencies;
        if (!server) pending.push(() => { cleanups.get(index)?.(); cleanups.set(index, callback()); });
      }
    },
    useSyncExternalStore(subscribe, snapshot, serverSnapshot) {
      hooks.useEffect(() => subscribe(() => { env.calls.storeChanges++; }), [subscribe]);
      return server ? serverSnapshot() : snapshot();
    },
  };
  const loaded = { exports: {}, ...(server ? {} : env.globals),
    require(id) {
      if (id === "react") return hooks;
      if (id === "react/jsx-runtime") return jsxRuntime;
      if (id === "./forest-atmosphere-model") return model;
      if (id.endsWith(".module.css")) return { default: { canvas: "canvas" } };
      assert.fail(`Unexpected dependency: ${id}`);
    },
  };
  vm.runInNewContext(code, loaded, { filename: "site-motion-runtime.tsx" });
  return {
    env,
    render(name, argument) { cursor = 0; return loaded.exports[name](argument); },
    effects() { while (pending.length) pending.shift()(); },
    unmount() { for (const cleanup of cleanups.values()) cleanup?.(); cleanups.clear(); pending.length = 0; },
  };
}

function mountCanvas(options = {}, props = {}) {
  const env = environment(options), h = harness(canvasCode, { env });
  if (options.matchMedia === false) delete env.window.matchMedia;
  const element = env.canvas();
  const view = h.render("ForestAtmosphere", props);
  view.props.ref.current = element;
  return { ...h, element, view };
}

test("atmosphere bounds memory, frame budgets and slow particle motion on high-DPI and coarse displays", () => {
  for (const coarse of [false, true]) for (const [width, height, dpr] of [[390, 844, 3], [1920, 1080, 2], [7680, 4320, 8], [100_000, 100_000, 8], [1, 1, 0]]) {
    const budget = model.atmosphereBudget(width, height, dpr, coarse);
    assert.ok(budget.ratio > 0 && budget.ratio <= 1.5);
    assert.ok(Math.floor(width * budget.ratio) * Math.floor(height * budget.ratio) <= 1_500_000);
    assert.equal(budget.particles, coarse ? 18 : 30);
    assert.equal(budget.interval, 1000 / (coarse ? 20 : 24));
  }
  const particles = model.forestParticles(30);
  assert.equal(particles.length, 30);
  assert.deepEqual(particles, model.forestParticles(30), "rerenders keep the same composition");
  assert.equal(model.forestParticles(1000).length, 40);
  assert.equal(model.forestParticles(-1).length, 0);
  for (const particle of particles) for (const time of [0, 3600, 86400]) for (const pointer of [-1, 0, 1]) {
    const point = model.forestParticleFrame(particle, time, pointer, -pointer);
    for (const value of Object.values(point)) assert.ok(Number.isFinite(value));
    assert.ok(point.x >= 0 && point.x <= 1); assert.ok(point.y >= 0 && point.y <= 1);
    assert.ok(point.opacity >= 0 && point.opacity <= 1); assert.ok(point.size > 0);
    const next = model.forestParticleFrame(particle, time + 1 / 20, pointer, -pointer);
    assert.ok(Math.abs(next.opacity - point.opacity) < .01, "opacity changes gently, without a flashing effect");
  }
});

test("canvas is decorative and does not touch DOM until effects; pause and reduced motion allocate nothing", () => {
  const server = harness(canvasCode, { server: true });
  const html = server.render("ForestAtmosphere", {});
  assert.equal(html.type, "canvas"); assert.equal(html.props["aria-hidden"], "true");
  for (const [options, props] of [[{}, { enabled: false }], [{ reduced: true }, {}], [{ matchMedia: false }, {}], [{}, {}]]) {
    const h = mountCanvas(options, props);
    assert.equal(h.env.calls.contexts, 0); assert.equal(h.env.calls.canvases, 0); assert.equal(h.env.frames.size, 0);
    if (props.enabled === false || options.reduced || options.matchMedia === false) {
      h.effects();
      assert.equal(h.env.calls.contexts, 0); assert.equal(h.env.calls.canvases, 0); assert.equal(h.env.frames.size, 0);
      assert.equal(h.env.document.listenerCount, 0); assert.equal(h.env.resizes.length, 0);
    }
    h.unmount();
  }
});

test("real canvas lifecycle caches its glow and throttles drawing while visibility and intersection pause frames", () => {
  const h = mountCanvas(); h.effects();
  assert.equal(h.env.calls.canvases, 1); assert.equal(h.env.calls.gradients, 1);
  assert.equal(h.env.frames.size, 1);
  h.env.tick(100); assert.equal(h.env.calls.images, 30);
  h.env.tick(110); assert.equal(h.env.calls.images, 30, "a RAF does not redraw before the 24fps budget");
  h.env.tick(145); assert.equal(h.env.calls.images, 60);
  assert.equal(h.env.calls.canvases, 1); assert.equal(h.env.calls.gradients, 1, "no gradient allocation per frame or particle");
  h.env.document.hidden = true; h.env.document.emit("visibilitychange");
  assert.equal(h.env.frames.size, 0);
  h.env.document.hidden = false; h.env.document.emit("visibilitychange");
  assert.equal(h.env.frames.size, 1);
  h.env.intersections[0].callback([{ target: h.element, isIntersecting: false }]);
  assert.equal(h.env.frames.size, 0);
  h.env.document.emit("visibilitychange"); assert.equal(h.env.frames.size, 0, "a visible tab does not resume an offscreen canvas");
  h.env.intersections[0].callback([{ target: h.element, isIntersecting: true }]);
  assert.equal(h.env.frames.size, 1);
  const queued = [...h.env.frames.values()][0];
  h.unmount();
  assert.equal(h.env.frames.size, 0); assert.ok(h.env.resizes[0].disconnected); assert.ok(h.env.intersections[0].disconnected);
  assert.equal(h.env.document.listenerCount, 0); assert.equal(h.element.parentElement.listenerCount, 0);
  const before = { ...h.env.calls, transformCount: h.env.calls.transforms.length };
  queued(200);
  h.env.resizes[0].callback(); h.env.intersections[0].callback([{ target: h.element, isIntersecting: true }]);
  assert.equal(h.env.calls.images, before.images); assert.equal(h.env.calls.clears, before.clears);
  assert.equal(h.env.calls.transforms.length, before.transformCount);
  assert.equal(h.env.frames.size, 0, "a callback queued before cleanup cannot write or restart animation");
});

test("ResizeObserver reapplies the memory bound; coarse canvas and live reduced-motion changes remain lightweight", () => {
  const h = mountCanvas({ coarse: true }); h.effects();
  assert.equal(h.element.parentElement.count("pointermove"), 0);
  h.element.rect = { width: 7680, height: 4320, top: 0, bottom: 4320 };
  h.env.resizes[0].callback();
  assert.ok(h.element.width * h.element.height <= 1_500_000);
  h.env.tick(100); assert.equal(h.env.calls.images, 18);
  h.env.tick(145); assert.equal(h.env.calls.images, 18, "coarse displays stay within the 20fps budget");
  h.env.tick(151); assert.equal(h.env.calls.images, 36);
  h.env.reducedQuery.matches = true; h.env.reducedQuery.emit("change");
  assert.equal(h.env.frames.size, 0); assert.ok(h.env.calls.clears > 0);
  h.env.reducedQuery.matches = false; h.env.reducedQuery.emit("change"); assert.equal(h.env.frames.size, 1);
  const paused = h.render("ForestAtmosphere", { enabled: false }); paused.props.ref.current = h.element; h.effects();
  assert.equal(h.env.frames.size, 0); assert.equal(h.env.reducedQuery.listenerCount, 0);
  h.unmount();
});

test("canvas without observers uses removable passive fallback listeners", () => {
  const h = mountCanvas({ observers: false }); h.effects();
  assert.equal(h.env.window.count("resize"), 1); assert.equal(h.env.window.count("scroll"), 1);
  h.element.rect = { width: 1200, height: 800, top: 900, bottom: 1700 };
  h.env.window.emit("scroll"); assert.equal(h.env.frames.size, 0);
  h.element.rect.top = 0; h.element.rect.bottom = 800;
  h.env.window.emit("resize"); assert.equal(h.env.frames.size, 1);
  h.unmount(); assert.equal(h.env.window.listenerCount, 0); assert.equal(h.env.document.listenerCount, 0);
});

test("motion hook has DOM-free conservative server snapshots and pausing cannot override reduced-motion preference", () => {
  const root = { current: null }, server = harness(motionCode, { server: true });
  const snapshot = server.render("useSiteMotion", root);
  assert.equal(snapshot.motionEnabled, false); assert.equal(snapshot.reducedMotion, true);
  const env = environment(), h = harness(motionCode, { env }); root.current = new Element();
  let state = h.render("useSiteMotion", root); h.effects();
  assert.equal(state.motionEnabled, true); assert.equal(root.current.dataset.motion, "ready");
  state.toggleMotion(); state = h.render("useSiteMotion", root); h.effects();
  assert.equal(state.motionEnabled, false); assert.equal(root.current.dataset.motion, "paused"); assert.equal(env.frames.size, 0);
  state.toggleMotion(); state = h.render("useSiteMotion", root); h.effects(); assert.equal(state.motionEnabled, true);
  env.reducedQuery.matches = true; env.reducedQuery.emit("change");
  assert.equal(env.calls.storeChanges, 1, "the actual external-store subscription observes the preference");
  state = h.render("useSiteMotion", root); h.effects();
  assert.equal(state.reducedMotion, true); assert.equal(state.motionEnabled, false);
  state.toggleMotion(); state = h.render("useSiteMotion", root); h.effects(); assert.equal(state.motionEnabled, false);
  h.unmount(); assert.equal(env.reducedQuery.listenerCount, 0); assert.equal(env.document.listenerCount, 0);
});

test("reveal enhancement leaves no-JS content visible, observes only offscreen sections and reveals keyboard focus", () => {
  const env = environment(), h = harness(motionCode, { env }), element = new Element();
  const onscreen = new Element(), offscreen = new Element();
  offscreen.rect = { width: 500, height: 400, top: 1600, bottom: 2000 };
  element.reveals = [onscreen, offscreen];
  h.render("useSiteMotion", { current: element });
  assert.equal(element.dataset.motion, undefined, "render alone does not opt the DOM into hidden reveal styles");
  h.effects();
  assert.equal(onscreen.dataset.revealed, "true"); assert.equal(offscreen.dataset.revealed, undefined);
  assert.ok(env.intersections[0].observed.has(offscreen)); assert.equal(env.intersections[0].observed.has(onscreen), false);
  const control = new Element(); control.revealParent = offscreen;
  element.emit("focusin", { target: control });
  assert.equal(offscreen.dataset.revealed, "true"); assert.equal(env.intersections[0].observed.has(offscreen), false);
  const other = new Element(); other.rect = offscreen.rect; element.reveals.push(other);
  // Exercise the observer callback itself, independently of keyboard reveal.
  env.intersections[0].callback([{ target: other, isIntersecting: true }]); assert.equal(other.dataset.revealed, "true");
  h.unmount();
  const lateReveal = new Element();
  env.intersections[0].callback([{ target: lateReveal, isIntersecting: true }]);
  assert.equal(lateReveal.dataset.revealed, undefined, "a queued observer callback cannot mutate DOM after unmount");
  assert.equal(element.dataset.motion, undefined); assert.equal(element.count("focusin"), 0);
  assert.equal(onscreen.dataset.revealed, "true"); assert.equal(offscreen.dataset.revealed, "true"); assert.ok(env.intersections[0].disconnected);
});

test("without observer/media features or with reduced motion, all sections are immediately revealed", () => {
  for (const options of [{ observers: false }, { reduced: true }, { matchMedia: false }]) {
    const env = environment(options), h = harness(motionCode, { env }), element = new Element();
    if (options.matchMedia === false) delete env.window.matchMedia;
    const reveal = new Element(); reveal.rect = { width: 500, height: 400, top: 1600, bottom: 2000 }; element.reveals = [reveal];
    h.render("useSiteMotion", { current: element }); h.effects();
    assert.equal(reveal.dataset.revealed, "true");
    if (options.reduced || options.matchMedia === false) { assert.equal(element.dataset.motion, "paused"); assert.equal(env.frames.size, 0); assert.equal(env.intersections.length, 0); }
    h.unmount();
  }
});

test("pointer and scroll writes coalesce, clamp inputs, pause in a hidden tab and cannot run after cleanup", () => {
  const env = environment(), h = harness(motionCode, { env }), element = new Element(), root = { current: element };
  h.render("useSiteMotion", root); h.effects();
  element.emit("pointermove", { clientX: 9000, clientY: -9000 }); element.emit("pointermove", { clientX: 9000, clientY: -9000 });
  env.window.scrollY = 9000; env.window.emit("scroll"); env.window.emit("resize");
  assert.equal(env.frames.size, 1, "events share a single scheduled write");
  env.tick(100);
  assert.equal(element.properties.get("--site-pointer-x"), "1"); assert.equal(element.properties.get("--site-pointer-y"), "-1");
  assert.equal(element.properties.get("--site-scroll"), "1"); assert.equal(env.frames.size, 0, "motion hook has no permanent RAF loop");
  element.emit("pointerleave"); assert.equal(env.frames.size, 1);
  env.document.hidden = true; env.document.emit("visibilitychange"); assert.equal(env.frames.size, 0);
  const writes = element.writes;
  element.emit("pointermove", { clientX: 0, clientY: 0 }); env.window.emit("scroll"); assert.equal(env.frames.size, 0); assert.equal(element.writes, writes);
  env.document.hidden = false; env.document.emit("visibilitychange"); assert.equal(env.frames.size, 1);
  const queued = [...env.frames.values()][0]; h.unmount();
  assert.equal(env.frames.size, 0); assert.equal(element.listenerCount, 0); assert.equal(env.window.listenerCount, 0); assert.equal(env.document.listenerCount, 0);
  assert.equal(element.properties.get("--site-pointer-x"), "0"); assert.equal(element.properties.get("--site-pointer-y"), "0");
  const cleanedWrites = element.writes; queued(200); assert.equal(element.writes, cleanedWrites); assert.equal(env.frames.size, 0);
});
