import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = {
  schemaVersion: 1, id: "test-scene", width: 1254, height: 1254,
  terrain: [{ id: "ground", image: "/test-ground.webp", bounds: { x: 0, y: 0, width: 1254, height: 1254 } }],
  focus: { x: 455, y: 480, width: 350, height: 350 },
  actor: { spawn: { x: 630, y: 660 }, size: 36 }, sites: [], paths: [],
};
const options = { paused: false, reducedMotion: true, lampOn: false, dusk: false };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function modules(override) {
  const vite = await createServer({ appType: "custom", configFile: false, root,
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
  try {
    const { default: scene } = await vite.ssrLoadModule("/features/world/tiled/forest.generated.json");
    Object.assign(scene, structuredClone(fixture), override);
    return {
      ...await vite.ssrLoadModule("/features/mochlik/scene.ts"),
      ...await vite.ssrLoadModule("/features/world/map-engine.ts"),
      ...await vite.ssrLoadModule("/features/world/art.ts"),
      ...await vite.ssrLoadModule("/features/world/presentation.ts"),
    };
  } finally { await vite.close(); }
}

function browser() {
  const saved = new Map(), pending = [], requests = [], timers = new Map(), frames = new Map(), observers = [];
  let id = 0;
  const install = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  function surface(width = 320, height = width) {
    const calls = [], events = new Map(), captured = new Set();
    const context = new Proxy({
      drawImage: (...args) => calls.push({ method: "drawImage", args }),
      setTransform: (...args) => calls.push({ method: "setTransform", args }),
      translate: (...args) => calls.push({ method: "translate", args }),
      scale: (...args) => calls.push({ method: "scale", args }),
    }, { get: (target, key) => key in target ? target[key] : () => {} });
    return {
      width: 1, height: 1, clientWidth: width, clientHeight: height, calls, context, events,
      getContext: () => context,
      getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
      addEventListener: (name, callback) => events.set(name, callback),
      removeEventListener: name => events.delete(name),
      setPointerCapture: pointer => captured.add(pointer),
      releasePointerCapture: pointer => captured.delete(pointer),
      hasPointerCapture: pointer => captured.has(pointer),
      focus() {},
    };
  }
  install("document", { hidden: false, createElement: () => surface(), addEventListener() {}, removeEventListener() {} });
  install("window", { devicePixelRatio: 2, addEventListener() {}, removeEventListener() {} });
  install("Image", class {
    naturalWidth = 2560; naturalHeight = 2560;
    set src(path) { if (path) { requests.push(path); pending.push({ path, image: this }); } }
  });
  install("setTimeout", (callback, ms) => { timers.set(++id, { callback, ms }); return id; });
  install("clearTimeout", key => timers.delete(key));
  install("requestAnimationFrame", callback => { frames.set(++id, callback); return id; });
  install("cancelAnimationFrame", key => frames.delete(key));
  for (const kind of ["ResizeObserver", "IntersectionObserver"]) {
    install(kind, class {
      nodes = new Set();
      constructor() { observers.push(this); }
      observe(node) { this.nodes.add(node); }
      disconnect() { this.nodes.clear(); }
    });
  }
  return {
    surface, pending, requests, timers, frames,
    observed: () => observers.reduce((sum, observer) => sum + observer.nodes.size, 0),
    finish(error = false) {
      const request = pending.shift(); assert.ok(request, "an image is awaiting completion");
      if (error) request.image.onerror?.(); else request.image.onload?.();
      return request.image;
    },
    tick(now) { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(now)); },
    fireTimer(key) { const timer = timers.get(key); assert.ok(timer); timers.delete(key); timer.callback(); },
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    },
  };
}

test("new circle and world paint the same 2560px source in 1254 logical units and use the new focus", async () => {
  const { mountHabitat, TILED_WORLD, NEW_MAP_FOCUS, NEW_MAP_SPAWN, NEW_MAP_SIZE } = await modules();
  const env = browser(); let scene;
  try {
    const circle = env.surface(), fullWorld = env.surface();
    let ready = 0;
    scene = mountHabitat(circle, options, { activity() {}, ready: () => ready++, failure: assert.fail });
    const image = env.finish(); await flush();
    assert.equal(ready, 1);
    assert.deepEqual(env.requests, [TILED_WORLD.terrain[0].image], "no preview, home detail, boat or overlay assets load");
    assert.equal(circle.width, 640, "the circle keeps its DPR 2 backing resolution");
    scene.paintWorld(fullWorld.context);
    const groundCalls = target => target.calls.filter(call => call.method === "drawImage" && call.args[0] === image);
    const sourceToWorld = [image, 0, 0, 2560, 2560, 0, 0, 1254, 1254];
    assert.equal(NEW_MAP_SIZE, 1254);
    assert.deepEqual(groundCalls(circle).at(-1).args, sourceToWorld);
    assert.deepEqual(groundCalls(fullWorld).at(-1).args, sourceToWorld);
    assert.ok(circle.calls.some(call => call.method === "setTransform" && call.args[0] === 640 / NEW_MAP_FOCUS.width
      && call.args[3] === 640 / NEW_MAP_FOCUS.height));
    assert.ok(circle.calls.some(call => call.method === "translate" && call.args[0] === -NEW_MAP_FOCUS.x && call.args[1] === -NEW_MAP_FOCUS.y));
    const at = scene.position();
    assert.equal(at.x, NEW_MAP_SPAWN.x);
    scene.moveTo(.1, .1); scene.invite("home"); scene.invite("bush");
    assert.deepEqual(scene.position(), at, "old movement destinations cannot move the clean scene actor");
    assert.deepEqual(scene.ambience(), { elapsed: 0, ecologyTime: 0, rain: 0, dusk: 0 });
  } finally { scene?.dispose(); env.restore(); }
});

test("new scene pauses, resumes, reacts without reduced-motion RAF, and releases timers and observers", async () => {
  const { mountHabitat } = await modules();
  const env = browser(); let scene;
  try {
    const canvas = env.surface(); let activity;
    const animated = { ...options, reducedMotion: false };
    scene = mountHabitat(canvas, animated, { activity: value => { activity = value; }, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    assert.equal(env.frames.size, 1); env.tick(100); env.tick(134);
    assert.ok(scene.ambience().elapsed > 0);
    scene.configure({ ...animated, paused: true });
    const frozen = canvas.calls.length, elapsed = scene.ambience().elapsed;
    scene.notice(); env.tick(168);
    assert.equal(canvas.calls.length, frozen); assert.equal(scene.ambience().elapsed, elapsed); assert.equal(env.frames.size, 0);
    scene.configure({ ...animated, backgrounded: true }); assert.equal(env.frames.size, 0);
    scene.configure(animated); assert.equal(env.frames.size, 1);
    scene.configure(options); assert.equal(env.frames.size, 0);
    scene.notice(); assert.equal(activity, "greet"); assert.equal(env.frames.size, 0);
    assert.equal(env.timers.size, 1, "a finite reaction expiry replaces the animation loop");
    env.fireTimer([...env.timers.keys()][0]);
    assert.equal(activity, "idle"); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
    scene.notice(); assert.equal(env.timers.size, 1);
    scene.dispose(); scene.configure(animated); scene.notice();
    assert.equal(env.observed(), 0); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  } finally { scene?.dispose(); env.restore(); }
});

test("failed new artwork reaches the failure callback and a fresh mount retries", async () => {
  const { mountHabitat, TILED_WORLD } = await modules();
  const env = browser(); let scene;
  try {
    let ready = 0; const failures = [];
    const callbacks = { activity() {}, ready: () => ready++, failure: error => failures.push(error) };
    scene = mountHabitat(env.surface(), options, callbacks);
    env.finish(true); await flush();
    assert.equal(ready, 0); assert.equal(failures.length, 1); assert.ok(failures[0] instanceof Error);
    assert.equal(env.observed(), 0); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
    scene = mountHabitat(env.surface(), options, callbacks);
    assert.deepEqual(env.requests, [TILED_WORLD.terrain[0].image, TILED_WORLD.terrain[0].image]);
    env.finish(); await flush();
    assert.equal(ready, 1); assert.equal(failures.length, 1);
  } finally { scene?.dispose(); env.restore(); }
});

test("disposing during new artwork loading prevents late callbacks and animation", async () => {
  const { mountHabitat } = await modules();
  const env = browser(); let scene;
  try {
    let callbacks = 0;
    const canvas = env.surface();
    scene = mountHabitat(canvas, { ...options, reducedMotion: false }, {
      activity: () => callbacks++, ready: () => callbacks++, failure: () => callbacks++, rendered: () => callbacks++,
    });
    scene.dispose(); const before = canvas.calls.length;
    env.finish(); await flush();
    assert.equal(callbacks, 0); assert.equal(canvas.calls.length, before);
    assert.equal(env.observed(), 0); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  } finally { scene?.dispose(); env.restore(); }
});

test("new map ignores old place hit areas while camera controls and pet taps remain live", async () => {
  const { createMapEngine, TILED_WORLD, NEW_MAP_SIZE, NEW_MAP_SPAWN, NEW_MAP_PET_SIZE } = await modules();
  const env = browser(); let engine;
  try {
    const canvas = env.surface(400), places = [], anchor = { dataset: { kind: "house", x: 672, y: 569 }, style: {} };
    const loading = createMapEngine(canvas, options, place => places.push(place), [anchor]);
    env.finish(); engine = await loading;
    assert.deepEqual(env.requests, [TILED_WORLD.terrain[0].image]); assert.equal(anchor.style.visibility, "hidden");
    assert.equal(env.frames.size, 0);
    engine.control("overview");
    function tap(x, y) {
      const event = { pointerId: 1, pointerType: "mouse", button: 0, clientX: x * 400 / NEW_MAP_SIZE, clientY: y * 400 / NEW_MAP_SIZE };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    }
    // Interior points of the former house, cave and river must never open their old panels.
    for (const point of [[667, 612], [162, 197], [1016, 1015]]) tap(...point);
    assert.deepEqual(places, []);
    tap(NEW_MAP_SPAWN.x, NEW_MAP_SPAWN.y - NEW_MAP_PET_SIZE / 2);
    assert.equal(env.timers.size, 1, "tapping the stationary pet starts its finite greeting");
    const before = canvas.calls.length; let prevented = 0;
    canvas.events.get("wheel")({ clientX: 200, clientY: 200, deltaY: -150, preventDefault() { prevented++; } });
    canvas.events.get("keydown")({ key: "ArrowRight", preventDefault() { prevented++; } });
    canvas.events.get("keydown")({ key: "Home", preventDefault() { prevented++; } });
    assert.equal(prevented, 3); assert.ok(canvas.calls.length > before);
    assert.deepEqual(places, []);
    engine.dispose(); assert.equal(canvas.events.size, 0);
    assert.equal(env.observed(), 0); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  } finally { engine?.dispose(); env.restore(); }
});

test("exported Tiled edits drive both live views, active site art, pet hit area and expanded camera bounds", async () => {
  const focus = { x: 600, y: 800, width: 240, height: 240 };
  const actor = { spawn: { x: 710, y: 990 }, size: 60 };
  const terrain = [
    { id: "ground", image: "/test-ground.webp", bounds: { x: 0, y: 0, width: 1800, height: 1800 } },
    { id: "shore", image: "/test-shore.webp", bounds: { x: 0, y: 1800, width: 600, height: 600 } },
  ];
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 820, width: 120, height: 120 },
    anchor: { x: 660, y: 940 }, entry: { x: 660, y: 950 }, hitArea: [], collision: [], initialLevel: 1,
    states: [{ level: 1, label: "Дом", image: "/test-home.webp" }, { level: 2, label: "Будущее", image: "/unused-home.webp" }] };
  const { mountHabitat, createMapEngine, NEW_MAP_FOCUS, NEW_MAP_SPAWN, NEW_MAP_PET_SIZE } = await modules({
    width: 1800, height: 2400, focus, actor, terrain, sites: [site],
  });
  const env = browser(); let scene, engine;
  try {
    assert.deepEqual(NEW_MAP_FOCUS, focus); assert.deepEqual(NEW_MAP_SPAWN, actor.spawn); assert.equal(NEW_MAP_PET_SIZE, 60);
    const circle = env.surface(); let ready = false;
    scene = mountHabitat(circle, options, { activity() {}, ready() { ready = true; }, failure: assert.fail });
    assert.deepEqual(env.requests, ["/test-ground.webp", "/test-shore.webp", "/test-home.webp"]);
    const ground = env.finish(); await flush(); assert.equal(ready, false, "all authored initial art must finish first");
    const shore = env.finish(), home = env.finish(); await flush(); assert.equal(ready, true);
    assert.ok(circle.calls.some(call => call.method === "translate" && call.args[0] === -600 && call.args[1] === -800));
    assert.ok(circle.calls.some(call => call.method === "setTransform" && call.args[0] === 640 / 240));
    assert.deepEqual(scene.position(), { x: 710, y: 960 });
    assert.equal(scene.hitPet((710 - 600) / 240, (960 - 800) / 240), true);
    assert.equal(scene.hitPet((750 - 600) / 240, (960 - 800) / 240), false);
    const world = env.surface(400);
    engine = await createMapEngine(world, options, assert.fail, []);
    for (const target of [circle, world]) {
      const images = target.calls.filter(call => call.method === "drawImage");
      assert.deepEqual(images.find(call => call.args[0] === ground).args.slice(1), [0, 0, 2560, 2560, 0, 0, 1800, 1800]);
      assert.deepEqual(images.find(call => call.args[0] === shore).args.slice(1), [0, 0, 2560, 2560, 0, 1800, 600, 600]);
      assert.deepEqual(images.find(call => call.args[0] === home).args.slice(1), [600, 820, 120, 120]);
      assert.deepEqual(images.at(-1).args.slice(1), [680, 930, 60, 60]);
    }
    const scale = () => world.calls.filter(call => call.method === "scale").at(-1).args[0];
    assert.equal(scale(), 400 / 2400, "initial world overview is independent of the circle crop");
    engine.control("home"); assert.equal(scale(), 400 / 240);
    engine.control("overview"); assert.equal(scale(), 400 / 2400);
    assert.deepEqual(world.calls.filter(call => call.method === "translate").at(-1).args, [-900, -1200]);
    assert.equal(env.requests.length, 3, "both views share asset cache; inactive upgrades are not loaded");
  } finally { scene?.dispose(); engine?.dispose(); env.restore(); }
});
