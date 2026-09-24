import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = {
  schemaVersion: 1, id: "test-scene", width: 1254, height: 1254,
  terrain: [{ id: "ground", image: "/test-ground.webp", bounds: { x: 0, y: 0, width: 1254, height: 1254 } }],
  focus: { x: 455, y: 480, width: 350, height: 350 },
  actor: { spawn: { x: 630, y: 660 }, size: 36 }, sites: [], paths: [], lights: [],
  water: { surfaces: [], exclusions: [] }, bushes: [], navigation: undefined, habitats: undefined,
  mushrooms: [{ id: "test-mushroom", position: { x: 635, y: 665 } }],
};
const livingHabitats = [
  { id: "test-flowers", species: "butterfly", capacity: 3,
    points: [{ x: 600, y: 615 }, { x: 670, y: 615 }, { x: 670, y: 675 }, { x: 600, y: 675 }],
    anchors: [{ id: "test-leaf", kind: "rest", position: { x: 620, y: 640 } }, { id: "test-cover", kind: "shelter", position: { x: 605, y: 625 } }] },
  { id: "test-grass", species: "firefly", capacity: 3,
    points: [{ x: 600, y: 615 }, { x: 670, y: 615 }, { x: 670, y: 675 }, { x: 600, y: 675 }],
    anchors: [{ id: "test-tip", kind: "rest", position: { x: 640, y: 635 } }, { id: "test-base", kind: "shelter", position: { x: 655, y: 665 } }] },
];
const livingNavigation = { version: 1, cellSize: 8,
  areas: [{ id: "test-clearing", points: [{ x: 570, y: 610 }, { x: 720, y: 610 }, { x: 720, y: 735 }, { x: 570, y: 735 }] }],
  obstacles: [], interests: [{ id: "test-flowers", position: { x: 680, y: 705 }, activity: "sniff" }] };
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
      ...await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts"),
      ...await vite.ssrLoadModule("/features/mochlik/pixel-sprite.ts"),
      ...await vite.ssrLoadModule("/features/world/forest-session.ts"),
      ...await vite.ssrLoadModule("/features/world/clearing-activity.ts"),
    };
  } finally { await vite.close(); }
}

function browser() {
  const saved = new Map(), pending = [], requests = [], timers = new Map(), frames = new Map(), observers = [];
  const documentEvents = new Map();
  let id = 0;
  const install = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  function surface(width = 320, height = width) {
    const calls = [], events = new Map(), captured = new Set();
    const context = new Proxy({
      createRadialGradient: () => ({ addColorStop() {} }),
      getTransform: () => undefined,
      drawImage: (...args) => calls.push({ method: "drawImage", args }),
      setTransform: (...args) => calls.push({ method: "setTransform", args }),
      translate: (...args) => calls.push({ method: "translate", args }),
      scale: (...args) => calls.push({ method: "scale", args }),
    }, {
      get: (target, key) => key in target ? target[key] : (...args) => calls.push({ method: key, args }),
      set: (target, key, value) => {
        target[key] = value;
        if (key === "globalCompositeOperation" || key === "strokeStyle") calls.push({ method: key, args: [value] });
        return true;
      },
    });
    return {
      width: 1, height: 1, clientWidth: width, clientHeight: height, calls, context, events,
      getContext: () => context,
      getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; },
      addEventListener: (name, callback) => events.set(name, callback),
      removeEventListener: name => events.delete(name),
      setPointerCapture: pointer => captured.add(pointer),
      releasePointerCapture: pointer => captured.delete(pointer),
      hasPointerCapture: pointer => captured.has(pointer),
      focus() {},
    };
  }
  install("document", { hidden: false, createElement: () => surface(),
    addEventListener(name, callback) {
      if (!documentEvents.has(name)) documentEvents.set(name, new Set());
      documentEvents.get(name).add(callback);
    },
    removeEventListener(name, callback) { documentEvents.get(name)?.delete(callback); },
  });
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
      constructor(callback) { this.callback = callback; this.kind = kind; observers.push(this); }
      observe(node) { this.nodes.add(node); }
      disconnect() { this.nodes.clear(); }
    });
  }
  return {
    surface, pending, requests, timers, frames,
    observed: () => observers.reduce((sum, observer) => sum + observer.nodes.size, 0),
    resize(node) {
      for (const observer of observers) {
        if (observer.kind === "ResizeObserver" && observer.nodes.has(node)) observer.callback([{ target: node }]);
      }
    },
    finish(error = false) {
      const request = pending.shift(); assert.ok(request, "an image is awaiting completion");
      if (error) request.image.onerror?.(); else request.image.onload?.();
      return request.image;
    },
    finishPath(path, error = false) {
      const index = pending.findIndex(request => request.path === path);
      assert.notEqual(index, -1, `image ${path} is awaiting completion`);
      const [request] = pending.splice(index, 1);
      if (error) request.image.onerror?.(); else request.image.onload?.();
      return request.image;
    },
    tick(now) { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(now)); },
    visibility(hidden) {
      document.hidden = hidden;
      for (const callback of documentEvents.get("visibilitychange") ?? []) callback();
    },
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
    const ambience = scene.ambience();
    assert.deepEqual({ ...ambience, rain: 0 }, { elapsed: 0, ecologyTime: 0, rain: 0, dusk: 0 });
    assert.ok(ambience.rain >= 0 && ambience.rain <= .42, "reduced motion keeps a bounded static weather sample");
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

test("circle and world share atmospheric time and smoothly transition from day to night", async () => {
  const { mountHabitat } = await modules();
  const env = browser(), scenes = [];
  try {
    const animated = { ...options, reducedMotion: false, serverNow: 100_000 };
    const circle = env.surface(), world = env.surface();
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    scenes.push(mountHabitat(circle, animated, callbacks), mountHabitat(world, { ...animated, view: "world" }, callbacks));
    env.finish(); await flush();
    assert.equal(env.frames.size, 2);
    const samplePaint = scene => {
      const surface = env.surface(); scene.paintWorld(surface.context); return surface.calls;
    };
    const initialPaint = samplePaint(scenes[0]);
    assert.deepEqual(samplePaint(scenes[1]), initialPaint, "both cameras receive identical world-space effects");
    env.tick(100); env.tick(134);
    assert.equal(scenes[0].ambience().ecologyTime, 100.034);
    assert.deepEqual(scenes[0].ambience(), scenes[1].ambience());
    assert.notDeepEqual(samplePaint(scenes[0]), initialPaint, "the atmosphere moves with the shared clock");
    assert.deepEqual(samplePaint(scenes[0]), samplePaint(scenes[1]));
    scenes.forEach((scene, index) => scene.configure({ ...animated, dusk: true, view: index ? "world" : "circle" }));
    assert.equal(scenes[0].ambience().dusk, 0, "changing the target does not flash immediately to night");
    env.tick(200); env.tick(250);
    assert.ok(scenes[0].ambience().dusk > 0 && scenes[0].ambience().dusk < 1);
    assert.deepEqual(scenes[0].ambience(), scenes[1].ambience());
    assert.deepEqual(samplePaint(scenes[0]), samplePaint(scenes[1]));
    const before = scenes[0].ambience(); env.tick(5_000);
    assert.ok(Math.abs(scenes[0].ambience().elapsed - before.elapsed - .05) < 1e-10,
      "long frame gaps use the existing step cap");
    const paints = circle.calls.length + world.calls.length;
    scenes.forEach(scene => scene.setTime(240_000));
    assert.equal(circle.calls.length + world.calls.length, paints, "clock samples do not trigger an extra paint");
    assert.equal(scenes[0].ambience().ecologyTime, 240);
    assert.deepEqual(scenes[0].ambience(), scenes[1].ambience());
  } finally { scenes.forEach(scene => scene.dispose()); env.restore(); }
});

test("paused and hidden scenes buffer time until active and reduced motion stays still", async () => {
  const { mountHabitat } = await modules();
  const env = browser(); let scene;
  try {
    const animated = { ...options, reducedMotion: false, serverNow: 100_000 }, canvas = env.surface();
    scene = mountHabitat(canvas, animated, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); env.tick(100); env.tick(134);
    scene.configure({ ...animated, paused: true, dusk: true });
    const frozen = scene.ambience(), paints = canvas.calls.length;
    scene.setTime(200_000); scene.setTime(Number.NaN); scene.setTime(Number.POSITIVE_INFINITY);
    scene.notice(); env.tick(200);
    assert.deepEqual(scene.ambience(), frozen); assert.equal(canvas.calls.length, paints);
    assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
    scene.configure({ ...animated, backgrounded: true, dusk: true }); scene.setTime(300_000);
    assert.deepEqual(scene.ambience(), frozen); assert.equal(env.frames.size, 0);
    document.hidden = true; scene.configure({ ...animated, dusk: true });
    assert.deepEqual(scene.ambience(), frozen); assert.equal(env.frames.size, 0);
    document.hidden = false; scene.configure({ ...animated, dusk: true });
    assert.equal(scene.ambience().ecologyTime, 300);
    assert.equal(scene.ambience().elapsed, frozen.elapsed); assert.equal(scene.ambience().dusk, frozen.dusk);
    assert.equal(env.frames.size, 1);
    scene.configure({ ...animated, dusk: true, reducedMotion: true });
    assert.equal(scene.ambience().dusk, 1); assert.equal(scene.ambience().ecologyTime, 0);
    assert.equal(env.frames.size, 0);
    const still = env.surface(), again = env.surface(); scene.paintWorld(still.context);
    scene.setTime(400_000); env.tick(50_000); scene.paintWorld(again.context);
    assert.deepEqual(again.calls, still.calls, "reduced motion freezes atmospheric positions and weather");
    scene.configure({ ...animated, dusk: true });
    assert.equal(scene.ambience().ecologyTime, 400, "the latest clock sample survives reduced motion");
    scene.dispose(); const disposed = scene.ambience(); scene.setTime(500_000); scene.configure(animated); scene.notice();
    assert.deepEqual(scene.ambience(), disposed);
    assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0); assert.equal(env.observed(), 0);
  } finally { scene?.dispose(); env.restore(); }
});

test("stale configuration samples cannot replace a newer active or pending clock", async () => {
  const { mountHabitat } = await modules();
  const env = browser(); let scene;
  try {
    const initial = { ...options, reducedMotion: false, serverNow: 100_000 };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    scene.setTime(200_000); scene.configure(initial);
    assert.equal(scene.ambience().ecologyTime, 200, "visibility may reapply the unchanged initial options");
    const withoutSample = { ...initial }; delete withoutSample.serverNow;
    scene.configure(withoutSample); scene.configure(initial);
    assert.equal(scene.ambience().ecologyTime, 200, "omitting a sample does not make the old sample fresh again");
    scene.configure({ ...initial, paused: true }); scene.setTime(300_000);
    scene.configure({ ...initial, paused: true });
    assert.equal(scene.ambience().ecologyTime, 200, "a paused clock retains its visible state");
    scene.configure(initial);
    assert.equal(scene.ambience().ecologyTime, 300, "resuming applies the pending sample, not the stale configuration");
    scene.configure({ ...initial, serverNow: 400_000 });
    assert.equal(scene.ambience().ecologyTime, 400, "an explicitly changed configuration sample is accepted");
    scene.configure({ ...initial, paused: true, serverNow: 500_000 });
    assert.equal(scene.ambience().ecologyTime, 400);
    scene.configure({ ...initial, serverNow: 500_000 });
    assert.equal(scene.ambience().ecologyTime, 500, "a new explicit sample can also wait for resume");
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

function mapProjection(canvas, width = fixture.width, height = fixture.height) {
  const frame = canvas.calls.slice(canvas.calls.findLastIndex(call => call.method === "setTransform"));
  const translates = frame.filter(call => call.method === "translate");
  const zoom = frame.find(call => call.method === "scale").args[0];
  const [centerX, centerY] = translates[0].args, [offsetX, offsetY] = translates[1].args;
  return { zoom, left: centerX + offsetX * zoom, top: centerY + offsetY * zoom,
    right: centerX + (offsetX + width) * zoom, bottom: centerY + (offsetY + height) * zoom };
}

function dragMap(canvas, x, y) {
  const event = { pointerId: 1, pointerType: "touch", button: 0, clientX: canvas.clientWidth / 2, clientY: canvas.clientHeight / 2 };
  canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
  canvas.events.get("pointermove")({ ...event, type: "pointermove", clientX: event.clientX + x, clientY: event.clientY + y });
  canvas.events.get("pointerup")({ ...event, type: "pointerup", clientX: event.clientX + x, clientY: event.clientY + y });
}

const approximately = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} ≈ ${expected}`);

test("full map clears the vertical HUD when zoomed in without adding horizontal travel", async () => {
  const { createMapEngine } = await modules();
  const env = browser(); let engine;
  try {
    const canvas = env.surface(393, 852), top = { offsetHeight: 170 }, bottom = { offsetHeight: 110 };
    const loading = createMapEngine(canvas, options, assert.fail, [], undefined, { top, bottom });
    env.finish(); engine = await loading;
    engine.control("home");
    dragMap(canvas, 10_000, 10_000);
    let projection = mapProjection(canvas);
    approximately(projection.top, top.offsetHeight, "the upper edge moves below the full top HUD");
    approximately(projection.left, 0, "the left edge retains its existing hard boundary");
    dragMap(canvas, -10_000, -10_000);
    projection = mapProjection(canvas);
    approximately(projection.bottom, canvas.clientHeight - bottom.offsetHeight, "the lower edge moves above the dock");
    approximately(projection.right, canvas.clientWidth, "the right edge retains its existing hard boundary");

    // Wheel zoom must remove the extra travel as soon as the whole map fits vertically.
    const heightFit = canvas.clientHeight / fixture.height;
    canvas.events.get("wheel")({ clientX: 196.5, clientY: 426,
      deltaY: Math.log(projection.zoom / heightFit) / .0015, preventDefault() {} });
    dragMap(canvas, 0, 10_000);
    projection = mapProjection(canvas);
    approximately(projection.top, 0, "no upper gap at vertical fit");
    approximately(projection.bottom, canvas.clientHeight, "no lower gap at vertical fit");
    canvas.events.get("keydown")({ key: "ArrowDown", preventDefault() {} });
    approximately(mapProjection(canvas).top, 0, "keyboard panning uses the same zoom-dependent limits");

    engine.control("overview");
    projection = mapProjection(canvas);
    approximately(projection.left, 0, "overview continues to show the complete width");
    approximately(projection.right, canvas.clientWidth, "overview never crops either side");
    approximately(projection.top, (canvas.clientHeight - canvas.clientWidth) / 2, "existing portrait overview stays centered");
    const overview = { ...projection };
    dragMap(canvas, 0, -10_000);
    assert.deepEqual(mapProjection(canvas), overview, "overview cannot be dragged farther into its letterbox");

    engine.control("home");
    const first = { pointerId: 1, pointerType: "touch", button: 0, clientX: 120, clientY: 400 };
    const second = { ...first, pointerId: 2, clientX: 280 };
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointerdown")({ ...second, type: "pointerdown" });
    canvas.events.get("pointermove")({ ...second, type: "pointermove", clientX: 121 });
    canvas.events.get("pointercancel")({ ...first, type: "pointercancel" });
    canvas.events.get("pointercancel")({ ...second, type: "pointercancel", clientX: 121 });
    assert.deepEqual(mapProjection(canvas), overview, "pinch zoom closes the extra travel just like the overview control");
  } finally { engine?.dispose(); env.restore(); }
});

test("HUD layout and viewport changes reclamp vertical travel and observers are released", async () => {
  const { createMapEngine } = await modules();
  const env = browser(); let engine;
  try {
    const canvas = env.surface(393, 852), top = { offsetHeight: 170 }, bottom = { offsetHeight: 110 };
    const loading = createMapEngine(canvas, options, assert.fail, [], undefined, { top, bottom });
    env.finish(); engine = await loading;
    engine.control("home"); dragMap(canvas, 0, 10_000);
    top.offsetHeight = 90; env.resize(top);
    approximately(mapProjection(canvas).top, 90, "a shorter top HUD removes the now-unnecessary gap immediately");
    dragMap(canvas, 0, -10_000);
    bottom.offsetHeight = 60; env.resize(bottom);
    approximately(mapProjection(canvas).bottom, canvas.clientHeight - 60, "a shorter bottom HUD also reclamps immediately");

    canvas.clientWidth = 852; canvas.clientHeight = 393; env.resize(canvas);
    dragMap(canvas, 10_000, 10_000);
    let projection = mapProjection(canvas);
    approximately(projection.top, 90, "landscape continues to use the measured top HUD height");
    approximately(projection.left, 0, "rotation does not loosen horizontal bounds");
    dragMap(canvas, -10_000, -10_000);
    projection = mapProjection(canvas);
    approximately(projection.bottom, canvas.clientHeight - 60, "landscape bottom edge clears the dock");
    approximately(projection.right, canvas.clientWidth, "landscape right edge remains bounded");

    engine.dispose();
    assert.equal(env.observed(), 0, "both HUD targets and canvas observers are disconnected");
    assert.equal(canvas.events.size, 0);
    const paints = canvas.calls.length;
    env.resize(top); env.resize(bottom); env.resize(canvas);
    assert.equal(canvas.calls.length, paints, "resizing detached HUD nodes cannot repaint a disposed engine");
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
  const { mountHabitat, createMapEngine, NEW_MAP_FOCUS, NEW_MAP_SPAWN, NEW_MAP_PET_SIZE, pixelSprite } = await modules({
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
      const hero = images.findLast(call => call.args[0] === pixelSprite("idle", "front", 0));
      assert.deepEqual(hero.args.slice(1), [680, 933.75, 60, 60]);
      assert.equal(hero.args[2] + hero.args[4] * 45 / 48, actor.spawn.y,
        "the visible sole rests on the Tiled spawn instead of the transparent sprite edge");
    }
    const scale = () => world.calls.filter(call => call.method === "scale").at(-1).args[0];
    assert.equal(scale(), 400 / 2400, "initial world overview is independent of the circle crop");
    engine.control("home"); assert.equal(scale(), 400 / 240);
    engine.control("overview"); assert.equal(scale(), 400 / 2400);
    const lastCameraScale = world.calls.findLastIndex(call => call.method === "scale");
    assert.deepEqual(world.calls.slice(lastCameraScale).find(call => call.method === "translate").args, [-900, -1200]);
    assert.equal(env.requests.length, 3, "both views share asset cache; inactive upgrades are not loaded");
  } finally { scene?.dispose(); engine?.dispose(); env.restore(); }
});

test("development overrides redraw immediately while paused without advancing time or escaping background", async () => {
  const { mountHabitat, worldDevStore, WORLD_DEV_ENABLED, pixelSprite } = await modules();
  assert.equal(WORLD_DEV_ENABLED, true);
  const env = browser(); let scene;
  try {
    const canvas = env.surface(), initial = { ...options, reducedMotion: false, serverNow: 100_000 };
    scene = mountHabitat(canvas, initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); env.tick(100); env.tick(140);
    const before = canvas.calls.length, time = scene.ambience().elapsed;
    worldDevStore.patch({ paused: true });
    assert.equal(env.frames.size, 0); assert.ok(canvas.calls.length > before, "pausing refreshes both render consumers");
    worldDevStore.patch({ weather: "downpour", timeOfDay: "night", pose: "fish", direction: "right", heroScale: 1.5 });
    assert.equal(scene.ambience().rain, 1); assert.equal(scene.ambience().dusk, 1);
    const expectedSprite = pixelSprite("fish", "right", Math.floor(time * 3) % 4);
    const hero = canvas.calls.findLast(call => call.method === "drawImage" && call.args[0] === expectedSprite);
    assert.ok(hero, "the hero remains present before the night-lighting texture");
    assert.equal(hero.args[3], 54);
    env.tick(4000); assert.equal(scene.ambience().elapsed, time);
    for (const still of [false, true]) for (const direction of ["right", "left"]) {
      worldDevStore.patch({ pose: "auto", autoLife: still, reducedMotion: still ? "on" : "off", direction });
      const currentPaint = canvas.calls.slice(canvas.calls.findLastIndex(call => call.method === "clearRect"));
      assert.ok(currentPaint.some(call => call.method === "drawImage" && call.args[0] === pixelSprite("idle", direction, 0)),
        `DEV direction ${direction} redraws the automatic pose with ${still ? "reduced motion" : "automatic life disabled"}`);
    }
    scene.configure({ ...initial, backgrounded: true });
    const hidden = canvas.calls.length;
    worldDevStore.patch({ paused: false, weather: "clear", reducedMotion: "off" });
    worldDevStore.triggerPose("greet");
    assert.equal(canvas.calls.length, hidden); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
    scene.configure(initial); assert.equal(env.frames.size, 1);
    worldDevStore.patch({ showHero: false });
    assert.equal(scene.hitPet(.5, .5), false);
    scene.dispose(); const disposed = canvas.calls.length;
    worldDevStore.patch({ weather: "rain", paused: true }); worldDevStore.triggerPose("jump");
    assert.equal(canvas.calls.length, disposed); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("DEV day and night shade the complete scene and hide lights belonging to hidden buildings", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 600, width: 120, height: 120 },
    anchor: { x: 660, y: 720 }, entry: { x: 660, y: 730 }, hitArea: [], collision: [], initialLevel: 1,
    states: [{ level: 1, label: "Дом", image: "/test-lit-home.webp" }] };
  const lights = [
    { id: "home-lantern", position: { x: 675, y: 630 }, kind: "lantern", radius: 70, intensity: 1, color: "#ffd28a", flicker: 0 },
    { id: "path-lantern", position: { x: 850, y: 860 }, kind: "lantern", radius: 60, intensity: .8, color: "#ffd28a", flicker: 0 },
  ];
  const { mountHabitat, worldDevStore, pixelSprite } = await modules({ sites: [site], lights });
  const env = browser(); let scene;
  try {
    worldDevStore.patch({ timeOfDay: "day", weather: "clear", butterflies: "off", fireflies: "off", birds: "off" });
    scene = mountHabitat(env.surface(), options, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); const home = env.finish(); await flush();
    const sample = () => { const target = env.surface(); scene.paintWorld(target.context); return target.calls; };
    const multiply = call => call.method === "globalCompositeOperation" && call.args[0] === "multiply";
    const core = (calls, light) => calls.some(call => call.method === "ellipse"
      && call.args[0] === light.position.x && call.args[1] === light.position.y);
    const day = sample();
    assert.equal(day.some(multiply), false, "daylight preserves the original artwork without a night texture");
    assert.equal(core(day, lights[0]), false);
    worldDevStore.patch({ timeOfDay: "night" });
    const night = sample(), shadeIndex = night.findIndex(multiply);
    const heroIndex = night.findIndex(call => call.method === "drawImage" && call.args[0] === pixelSprite("idle", "front", 0));
    assert.ok(heroIndex >= 0 && shadeIndex > heroIndex, "one night pass includes the hero as well as terrain and buildings");
    assert.ok(core(night, lights[0]) && core(night, lights[1]), "both authored light sources glow at night");
    const nightTexture = night.slice(shadeIndex).find(call => call.method === "drawImage").args[0];
    const repeated = sample();
    assert.equal(repeated.slice(repeated.findIndex(multiply)).find(call => call.method === "drawImage").args[0], nightTexture,
      "another camera paint reuses the shared illumination texture");
    worldDevStore.patch({ showBuildings: false });
    const hidden = sample();
    assert.ok(hidden.some(multiply), "hiding buildings does not disable the night");
    assert.equal(hidden.some(call => call.method === "drawImage" && call.args[0] === home), false);
    assert.equal(core(hidden, lights[0]), false, "a hidden building cannot leave its lantern floating in the forest");
    assert.equal(core(hidden, lights[1]), true, "independent path lights remain visible");
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("manual pose events restart, finish, preserve loop choice and use finite reduced-motion stills", async () => {
  const { mountHabitat, worldDevStore, pixelSprite } = await modules();
  const env = browser(); let scene;
  try {
    const canvas = env.surface();
    scene = mountHabitat(canvas, options, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    const assertHero = (pose, frame, message) => {
      const sprite = pixelSprite(pose, worldDevStore.getSnapshot().direction, frame);
      const currentFrame = canvas.calls.slice(canvas.calls.findLastIndex(call => call.method === "clearRect"));
      assert.ok(currentFrame.some(call => call.method === "drawImage" && call.args[0] === sprite), message ?? `painted ${pose} frame ${frame}`);
    };
    worldDevStore.patch({ pose: "sleep", direction: "left" });
    assertHero("sleep", 0);
    worldDevStore.triggerPose("greet");
    assertHero("greet", 2); assert.equal(env.frames.size, 0);
    const firstTimer = [...env.timers.keys()][0]; assert.ok(firstTimer);
    worldDevStore.triggerPose("greet");
    assert.equal(env.timers.has(firstTimer), false); assert.equal(env.timers.size, 1);
    env.fireTimer([...env.timers.keys()][0]);
    assertHero("sleep", 0); assert.equal(env.timers.size, 0);
    worldDevStore.triggerPose("greet"); worldDevStore.patch({ pose: "fish", animation: null });
    assertHero("fish", 0); assert.equal(env.timers.size, 0, "choosing a loop cancels the manual event immediately");
    worldDevStore.patch({ reducedMotion: "off", pose: "idle" });
    worldDevStore.triggerPose("greet"); assertHero("greet", 0);
    env.tick(100);
    for (let now = 150; now <= 500; now += 50) env.tick(now);
    assertHero("greet", 1);
    worldDevStore.triggerPose("greet"); assertHero("greet", 0, "a repeated click starts at the first frame");
    env.tick(550);
    for (let now = 600; now <= 1550; now += 50) env.tick(now);
    assertHero("idle", Math.floor(scene.ambience().elapsed * 3) % 4);
    worldDevStore.patch({ paused: true }); worldDevStore.triggerPose("jump");
    assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0); assertHero("jump", 0);
    worldDevStore.reset(); assertHero("idle", 0, "reset clears manual events and loop overrides");
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("development building levels load only selected artwork and reject stale and failed replacements", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 820, width: 120, height: 120 },
    anchor: { x: 660, y: 940 }, entry: { x: 660, y: 950 }, hitArea: [], collision: [], initialLevel: 1,
    states: [1, 2, 3, 4].map(level => ({ level, label: `Level ${level}`, image: `/home-${level}.webp` })) };
  const { mountHabitat, worldDevStore } = await modules({ sites: [site] });
  const env = browser(); let scene;
  try {
    const canvas = env.surface(); let ready = 0;
    scene = mountHabitat(canvas, options, { activity() {}, ready: () => ready++, failure: assert.fail });
    env.finish(); const first = env.finish(); await flush();
    assert.equal(ready, 1); assert.deepEqual(env.requests, ["/test-ground.webp", "/home-1.webp"]);
    worldDevStore.patch({ paused: true, levels: { home: 2 } });
    worldDevStore.patch({ levels: { home: 3 } });
    assert.deepEqual(env.requests, ["/test-ground.webp", "/home-1.webp", "/home-2.webp", "/home-3.webp"]);
    const latest = env.finishPath("/home-3.webp"); await flush();
    const paintedBuilding = () => canvas.calls.findLast(call => call.method === "drawImage" && call.args.length === 5
      && call.args[0] instanceof Image).args[0];
    assert.equal(paintedBuilding(), latest);
    env.finishPath("/home-2.webp"); await flush();
    worldDevStore.patch({ timeOfDay: "night" }); assert.equal(paintedBuilding(), latest, "old completion cannot replace the latest chosen art");
    worldDevStore.patch({ levels: { home: 4 } }); env.finishPath("/home-4.webp", true); await flush();
    assert.ok(worldDevStore.getSnapshot().artError); assert.equal(paintedBuilding(), latest, "a failed level retains complete previous art");
    assert.equal(ready, 1, "building changes do not remount the scene");
    worldDevStore.patch({ levels: { home: 999, unknown: 2 } });
    assert.equal(env.requests.length, 5, "invalid or unauthored states never load artwork");
    worldDevStore.reset(); await flush(); assert.equal(paintedBuilding(), first); assert.equal(worldDevStore.getSnapshot().artError, null);
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("full map responds to shared paused edits and camera commands and releases dev subscriptions", async () => {
  const { createMapEngine, worldDevStore } = await modules();
  const env = browser(); let engine;
  try {
    const canvas = env.surface(400), loading = createMapEngine(canvas, { ...options, reducedMotion: false }, assert.fail, []);
    env.finish(); engine = await loading;
    assert.equal(env.frames.size, 2, "map and shared scene initially run their clocks");
    worldDevStore.patch({ paused: true }); assert.equal(env.frames.size, 0);
    const frozen = canvas.calls.length;
    worldDevStore.patch({ timeOfDay: "night", showHero: false });
    assert.ok(canvas.calls.length > frozen, "world redraws store edits even with no RAF");
    const scale = () => canvas.calls.filter(call => call.method === "scale").at(-1).args[0];
    const beforeZoom = scale(); worldDevStore.triggerCamera("in"); assert.ok(scale() > beforeZoom);
    worldDevStore.triggerCamera("overview"); assert.equal(scale(), 400 / 1254);
    worldDevStore.patch({ paused: false, reducedMotion: "on" }); assert.equal(env.frames.size, 0);
    worldDevStore.patch({ reducedMotion: "off" }); assert.equal(env.frames.size, 2);
    engine.update({ ...options, reducedMotion: false, backgrounded: true }); assert.equal(env.frames.size, 0);
    const hidden = canvas.calls.length; worldDevStore.patch({ paused: true, weather: "rain" });
    assert.equal(canvas.calls.length, hidden, "development overrides do not wake a hidden world");
    engine.dispose(); const disposed = canvas.calls.length; worldDevStore.triggerCamera("pet"); worldDevStore.reset();
    assert.equal(canvas.calls.length, disposed); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0); assert.equal(env.observed(), 0);
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("map loading adopts the latest dev pause before starting its outer animation loop", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 820, width: 120, height: 120 },
    anchor: { x: 660, y: 940 }, entry: { x: 660, y: 950 }, hitArea: [], collision: [], initialLevel: 1,
    states: [{ level: 1, label: "Дом", image: "/test-loading-home.webp" }] };
  const { createMapEngine, worldDevStore } = await modules({ sites: [site] });
  const env = browser(); let engine;
  try {
    const loading = createMapEngine(env.surface(400), { ...options, reducedMotion: false }, assert.fail, []);
    env.finish(); await flush();
    assert.deepEqual(env.requests, ["/test-ground.webp", "/test-loading-home.webp"]);
    worldDevStore.patch({ paused: true });
    env.finish(); engine = await loading;
    assert.equal(env.frames.size, 0, "both scene and map retain the pause applied during the asynchronous load");
    worldDevStore.patch({ paused: false }); assert.equal(env.frames.size, 2);
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("same-account art-ready world owns one clock and preserves life, moisture and time on return", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 900, y: 820, width: 100, height: 100 },
    anchor: { x: 950, y: 920 }, entry: { x: 950, y: 930 }, hitArea: [], collision: [], initialLevel: 1,
    states: [1, 2].map(level => ({ level, label: `Level ${level}`, image: `/shared-home-${level}.webp` })) };
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD } = await modules({ sites: [site] });
  const env = browser(), scenes = []; let probe;
  try {
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "owner-account" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finish(); env.finish(); await flush(); env.tick(100); env.tick(150);
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    worldDevStore.patch({ weather: "rain", levels: { home: 2 } });
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    const before = circle.ambience().elapsed; env.tick(200); env.tick(250);
    assert.ok(circle.ambience().elapsed > before, "loading world has not taken the ready circle's clock");
    env.finishPath("/shared-home-2.webp"); await flush();
    assert.equal(env.frames.size, 1, "only one shared scene clock runs after world art is ready");
    circle.configure({ ...initial, backgrounded: true });
    worldDevStore.triggerLife("mushroom");
    env.tick(300); for (let now = 350; now <= 2850; now += 50) env.tick(now);
    assert.equal(probe.state.life.routine.kind, "mushroom"); assert.equal(probe.state.life.routine.picked, true);
    assert.ok(probe.state.wetness > 0);
    assert.deepEqual(circle.ambience(), world.ambience());
    const snapshot = structuredClone(probe.state);
    circle.setTime(80_000);
    world.dispose(); circle.configure(initial); await flush();
    assert.equal(env.frames.size, 1); assert.deepEqual(probe.state, snapshot, "handoff does not reset life or rewind to an old circle time sample");
    env.tick(2900); env.tick(2950);
    assert.ok(probe.state.life.routine.elapsed > snapshot.life.routine.elapsed);
    assert.ok(probe.state.wetness > snapshot.wetness);
    assert.deepEqual(circle.position(), { x: 630, y: 642 }, "routines never move the authored hero");
  } finally { probe?.release(); scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});

test("shared DEV transitions apply once and pause, reduced motion and account changes isolate life", async () => {
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD } = await modules({ habitats: livingHabitats });
  const env = browser(), scenes = [], probes = [];
  try {
    worldDevStore.patch({ weather: "clear", timeOfDay: "day", autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "life-account" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    env.finish(); await flush();
    const clock = sceneClock(env);
    const probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {}); probes.push(probe);
    worldDevStore.triggerBirds();
    assert.equal(probe.state.birdSeed, 0, "both cameras consume the first bird visit only once");
    assert.equal(probe.state.birdStarted, probe.state.elapsed);
    worldDevStore.triggerBirds();
    assert.equal(probe.state.birdSeed, 1, "another DEV invocation chooses the next shared scenario");
    worldDevStore.triggerPose("greet"); worldDevStore.triggerLife("butterfly");
    assert.equal(probe.state.pendingLife, "butterfly", "the shared request survives both camera subscribers");
    clock.advance(.1);
    assert.equal(probe.state.fauna.encounter?.kind, "butterfly", "the next visible step reserves one real individual");
    assert.equal(probe.state.fauna.sequence, 1, "the two cameras cannot create duplicate reservations");
    assert.equal(probe.state.life.routine, null, "insects never use the old transient prop routine");
    assert.equal(probe.state.animation, null);
    worldDevStore.patch({ pose: "sleep" }); worldDevStore.triggerLife("firefly");
    assert.equal(probe.state.pendingLife, "firefly", "changing a held pose to auto is also a single shared transition");
    worldDevStore.patch({ paused: true });
    const paused = structuredClone(probe.state); env.tick(10_000);
    assert.deepEqual(probe.state, paused); assert.equal(env.frames.size, 0);
    worldDevStore.patch({ paused: false, reducedMotion: "on" });
    const still = structuredClone(probe.state); env.tick(20_000);
    assert.deepEqual(probe.state, still); assert.equal(env.frames.size, 0);
    worldDevStore.patch({ reducedMotion: "off" }); worldDevStore.triggerPose("jump");
    assert.equal(probe.state.life.routine, null, "manual sprite poses cancel interaction props immediately");
    assert.equal(probe.state.fauna.encounter, null); assert.equal(probe.state.pendingLife, null);
    world.configure({ ...initial, presenceKey: "other-account", view: "world" });
    const other = connectForestSession("other-account", TILED_WORLD, "circle", 0, 0, () => {}); probes.push(other);
    assert.notEqual(other.state, probe.state); assert.equal(other.state.life.elapsed, 0);
    assert.equal(other.state.animation, null); assert.equal(other.state.wetness, 0);
    await flush(); assert.equal(env.frames.size, 2, "different accounts and anonymous scenes remain independent");
  } finally { probes.forEach(probe => probe.release()); scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});

const clearingPath = { id: "clearing-fern", label: "Fern", behavior: "clearing", activity: "groom", pauseSeconds: 3,
  points: [{ ...fixture.actor.spawn }, { x: 617, y: 654 }, { x: 605, y: 647 }] };
const clearingHome = { id: "home", label: "Дом", bounds: { x: 620, y: 580, width: 80, height: 70 },
  anchor: { x: 650, y: 650 }, entry: { x: 650, y: 650 }, doorway: { x: 650, y: 640 },
  hitArea: [{ x: 620, y: 580 }, { x: 700, y: 580 }, { x: 700, y: 650 }, { x: 620, y: 650 }],
  collision: [{ x: 640, y: 600 }, { x: 675, y: 600 }, { x: 675, y: 644 }, { x: 640, y: 644 }],
  initialLevel: 1, states: [{ level: 1, label: "Дом", image: "/test-residence.webp" }] };
const clearingHomePath = { id: "clearing-home", behavior: "home", siteId: "home",
  points: [{ ...fixture.actor.spawn }, { x: 642, y: 655 }, { ...clearingHome.entry }] };
const clearingBush = { id: "test-bush", entry: { x: 611, y: 666 }, hide: { x: 600, y: 641 },
  points: [{ x: 578, y: 600 }, { x: 621, y: 594 }, { x: 628, y: 616 },
    { x: 621, y: 650 }, { x: 584, y: 652 }, { x: 575, y: 630 }] };
const clearingBushPath = { id: "clearing-bush", behavior: "clearing", activity: "bush", bushId: clearingBush.id, pauseSeconds: 4,
  points: [{ ...fixture.actor.spawn }, { x: 620, y: 666 }, { ...clearingBush.entry }] };
const quietClearing = { weather: "clear", timeOfDay: "day", butterflies: "off", fireflies: "off", birds: "off" };
const distanceBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const circlePoint = point => ({ x: (point.x - fixture.focus.x) / fixture.focus.width,
  y: (point.y - fixture.focus.y) / fixture.focus.height });
function sceneClock(env) {
  let now = 100;
  env.tick(now);
  const step = (milliseconds = 50) => { now += milliseconds; env.tick(now); };
  return {
    step,
    advance(seconds) { for (let i = 0; i < Math.ceil(seconds * 20); i++) step(); },
    until(predicate, message, limit = 400) {
      for (let i = 0; i < limit && !predicate(); i++) step();
      assert.ok(predicate(), message);
    },
  };
}

function sampleHero(scene, env, pixelSprite) {
  const target = env.surface();
  scene.paintWorld(target.context);
  const body = target.calls.findLast(call => call.method === "drawImage" && call.args.length === 5
    && call.args[0]?.width === 48 && call.args[0]?.height === 48);
  return {
    body, calls: target.calls,
    hasPose(...poses) {
      return Boolean(body) && poses.some(pose => ["front", "back", "left", "right"].some(direction =>
        [0, 1, 2, 3].some(frame => body.args[0] === pixelSprite(pose, direction, frame))));
    },
  };
}

function bushMaskAfterBody(sample, bush = clearingBush) {
  if (!sample.body) return false;
  const calls = sample.calls.slice(sample.calls.indexOf(sample.body) + 1);
  const start = calls.findIndex(call => call.method === "moveTo"
    && call.args[0] === bush.points[0].x && call.args[1] === bush.points[0].y);
  if (start < 0) return false;
  const contour = bush.points.map((point, index) => ({ method: index ? "lineTo" : "moveTo", args: [point.x, point.y] }));
  assert.deepEqual(calls.slice(start, start + contour.length), contour, "occlusion follows every authored leaf vertex");
  const tail = calls.slice(start + contour.length);
  return tail[0]?.method === "closePath" && tail[1]?.method === "clip"
    && tail.some(call => call.method === "drawImage" && call.args.length === 9 && call.args[0] instanceof Image);
}

function bushParticleDraws(sample) {
  if (!sample.body) return [];
  // In this quiet, unlit fixture the actor's contact shadow precedes its sprite;
  // berry ellipses are painted afterward, outside the foliage clip.
  return sample.calls.slice(sample.calls.indexOf(sample.body) + 1)
    .filter(call => call.method === "ellipse" || call.method === "arc");
}

test("authored clearing routes move the rendered pet, its hit area and camera target together", async () => {
  const { mountHabitat, createMapEngine, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite, clearingActivityFrame } = await modules({ paths: [clearingPath] });
  const env = browser(); let scene, engine, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "walking-pet" }, canvas = env.surface();
    scene = mountHabitat(canvas, initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const home = scene.position(), clock = sceneClock(env);
    let previous = home, moved = false;
    for (let i = 0; i < 200 && probe.state.clearing.stage !== "activity"; i++) {
      clock.step();
      const current = scene.position();
      assert.ok(distanceBetween(current, previous) <= fixture.actor.size * .36 * .05 + 1e-8,
        "each visual frame moves at walking speed, including route corners and arrival");
      assert.ok(distanceBetween(current, home) <= fixture.actor.size * 1.6, "the actor stays near its clearing spawn");
      moved ||= distanceBetween(current, home) > 10;
      previous = current;
    }
    assert.equal(moved, true, "automatic life starts walking without DEV commands or a user tap");
    assert.equal(probe.state.clearing.stage, "activity", "the hero reaches the authored local destination");
    assert.deepEqual(scene.position(), { x: 605, y: 629 });
    const actorDraw = canvas.calls.findLast(call => call.method === "drawImage" && call.args.length === 5
      && call.args[3] === fixture.actor.size && call.args[4] === fixture.actor.size);
    assert.ok(actorDraw, "the moving actor is painted");
    assert.equal(actorDraw.args[1] + fixture.actor.size / 2, scene.position().x,
      "sprite drawing uses the live position rather than the original Tiled spawn");
    const live = circlePoint(scene.position()), old = circlePoint(home);
    assert.equal(scene.hitPet(live.x, live.y), true, "the new position responds to touches");
    assert.equal(scene.hitPet(old.x, old.y), false, "the departed spawn is not an invisible touch target");
    canvas.calls.length = 0;
    const grooming = [0, 1, 2, 3].map(frame => pixelSprite("groom", "front", frame));
    clock.until(() => canvas.calls.some(call => call.method === "drawImage" && grooming.includes(call.args[0])),
      "each variant of the authored endpoint activity reaches the visible grooming sprite", 60);
    assert.deepEqual(scene.position(), { x: 605, y: 629 }, "the endpoint activity keeps its authored contact point");

    const world = env.surface(400);
    engine = await createMapEngine(world, initial, assert.fail, []);
    worldDevStore.patch({ paused: true });
    engine.control("pet");
    const projection = mapProjection(world), target = scene.position();
    approximately(projection.left + target.x * projection.zoom, 200, "find pet centers its current X");
    approximately(projection.top + target.y * projection.zoom, 200, "find pet centers its current Y");
    engine.control("overview");
    const tap = (point, pointerId) => {
      const event = { pointerId, pointerType: "touch", button: 0,
        clientX: point.x * 400 / fixture.width, clientY: point.y * 400 / fixture.height };
      world.events.get("pointerdown")({ ...event, type: "pointerdown" });
      world.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    tap(home, 1); assert.equal(clearingActivityFrame(probe.state.clearing).attention, false, "a map tap at the old spawn also misses");
    tap(target, 2); assert.equal(clearingActivityFrame(probe.state.clearing).attention, true, "a map tap finds and greets the relocated pet");
  } finally { engine?.dispose(); scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("greetings, reduced motion and hidden tabs pause an outing without catch-up jumps", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ paths: [clearingPath] });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "interrupted-outing" }, activities = [];
    scene = mountHabitat(env.surface(), initial, { activity: value => activities.push(value), ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const home = scene.position(), clock = sceneClock(env);
    clock.until(() => distanceBetween(scene.position(), home) > 10, "the hero has left its spawn");
    const greetedAt = scene.position();
    scene.notice(); clock.advance(.8);
    assert.deepEqual(scene.position(), greetedAt, "greeting freezes translation at the actual location");
    assert.equal(activities.at(-1), "greet");
    clock.until(() => distanceBetween(scene.position(), greetedAt) > 0, "the finite greeting returns to its interrupted route", 80);
    assert.equal(activities.at(-1), "idle");
    assert.ok(distanceBetween(scene.position(), greetedAt) > 0 && distanceBetween(scene.position(), greetedAt) < 3,
      "the outing continues from the same spot after greeting");

    scene.configure({ ...initial, reducedMotion: true });
    const still = scene.position(), travelTime = probe.state.clearing.elapsed;
    clock.step(60_000);
    assert.deepEqual(scene.position(), still); assert.equal(probe.state.clearing.elapsed, travelTime);
    assert.equal(env.frames.size, 0);
    scene.configure(initial); clock.step(); clock.step();
    assert.ok(distanceBetween(scene.position(), still) > 0 && distanceBetween(scene.position(), still) < 1,
      "turning motion back on resumes one short frame without applying the hidden minute");

    for (const mode of ["paused", "backgrounded", "hidden"]) {
      if (mode === "hidden") env.visibility(true); else scene.configure({ ...initial, [mode]: true });
      const frozen = scene.position(), elapsed = probe.state.clearing.elapsed;
      assert.equal(env.frames.size, 0, `${mode} cancels the scene clock`);
      clock.step(60_000);
      assert.deepEqual(scene.position(), frozen, `${mode} keeps the live actor stationary`);
      assert.equal(probe.state.clearing.elapsed, elapsed);
      if (mode === "hidden") env.visibility(false); else scene.configure(initial);
      clock.step(); clock.step();
      assert.ok(distanceBetween(scene.position(), frozen) <= fixture.actor.size * .36 * .05 + 1e-8,
        `${mode} resumes without replaying the elapsed background time`);
    }
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("circle/world handoff preserves one walking clock, path progress and position", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ paths: [clearingPath] });
  const env = browser(), scenes = []; let probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "shared-outing" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const home = circle.position(), clock = sceneClock(env);
    clock.until(() => distanceBetween(circle.position(), home) > 8, "circle starts its short walk");
    const snapshot = structuredClone(probe.state.clearing);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    await flush();
    assert.deepEqual(probe.state.clearing, snapshot, "mounting a second view preserves the existing outing");
    assert.deepEqual(circle.position(), world.position()); assert.equal(env.frames.size, 1);
    clock.step();
    const before = probe.state.clearing.elapsed;
    clock.advance(.5);
    approximately(probe.state.clearing.elapsed - before, .5, "two mounted views advance exactly one active clock");
    assert.deepEqual(circle.position(), world.position());
    assert.notDeepEqual(circle.position(), home);
    circle.configure({ ...initial, backgrounded: true });
    const beforeReturn = structuredClone(probe.state.clearing);
    world.dispose(); circle.configure(initial); await flush();
    assert.deepEqual(probe.state.clearing, beforeReturn, "closing the world continues the circle from the same route progress");
    assert.equal(env.frames.size, 1);
    clock.step(); clock.step();
    assert.ok(probe.state.clearing.elapsed > beforeReturn.elapsed);
    assert.ok(distanceBetween(circle.position(), { x: beforeReturn.position.x, y: beforeReturn.position.y - fixture.actor.size / 2 }) < 1);
  } finally { scenes.forEach(scene => scene.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("DEV interaction requested away from home waits for a continuous return along the local path", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ paths: [clearingPath] });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "return-before-life" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const home = scene.position(), clock = sceneClock(env);
    clock.until(() => distanceBetween(scene.position(), home) > 12, "the hero leaves home before the requested interaction");
    const requestedAt = scene.position();
    worldDevStore.triggerLife("mushroom");
    assert.deepEqual(scene.position(), requestedAt, "DEV does not teleport the hero back to its props");
    assert.equal(probe.state.pendingLife, "mushroom"); assert.equal(probe.state.life.routine, null);
    clock.step(); clock.step();
    assert.equal(probe.state.clearing.stage, "return");
    let previous = requestedAt, previousDistance = distanceBetween(previous, home);
    for (let i = 0; i < 160 && !probe.state.life.routine; i++) {
      clock.step();
      const current = scene.position(), remaining = distanceBetween(current, home);
      assert.ok(distanceBetween(current, previous) <= fixture.actor.size * .36 * .05 + 1e-8,
        "returning and final arrival retain bounded visual displacement");
      assert.ok(remaining <= previousDistance + 1e-8, "the character retraces the authored route towards home");
      if (remaining > .001) assert.equal(probe.state.life.routine, null, "the mushroom remains at home until the actor returns");
      previous = current; previousDistance = remaining;
    }
    assert.deepEqual(scene.position(), home);
    assert.equal(probe.state.pendingLife, null); assert.equal(probe.state.life.routine?.kind, "mushroom");
    clock.advance(1);
    assert.deepEqual(scene.position(), home, "interacting with a ground prop never resumes walking underneath it");
    assert.ok(probe.state.life.routine.elapsed > 0);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("a tap wakes an outdoor nap without replaying the interrupted sleep afterwards", async () => {
  const rest = { ...clearingPath, id: "clearing-nap", activity: "rest", pauseSeconds: 20 };
  const { mountHabitat, worldDevStore, pixelSprite } = await modules({ paths: [rest] });
  const env = browser(); let scene;
  try {
    worldDevStore.patch(quietClearing);
    scene = mountHabitat(env.surface(), { ...options, view: "world", reducedMotion: false },
      { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    const clock = sceneClock(env), sample = () => sampleHero(scene, env, pixelSprite);
    clock.until(() => sample().hasPose("sleep"), "the authored rest route reaches a visible natural nap", 600);
    const sleepingAt = scene.position(), sleepingTouch = circlePoint(sleepingAt);
    assert.equal(scene.hitPet(sleepingTouch.x, sleepingTouch.y), true, "a sleeping body retains its touch target");
    scene.notice();
    const poses = new Set();
    for (let i = 0; i < 100; i++) {
      clock.step();
      const current = sample();
      for (const pose of ["drowsy", "stretch", "greet", "idle", "walk", "blink", "wonder"]) {
        if (current.hasPose(pose)) poses.add(pose);
      }
      assert.equal(current.hasPose("sleep"), false, "the interrupted nap cannot resume after the response");
    }
    assert.ok(poses.has("stretch"), "waking has a visible transition before ordinary activity");
    assert.ok(poses.has("walk") || poses.has("idle") || poses.has("wonder"), "the hero settles into awake behavior");
    assert.ok(distanceBetween(scene.position(), sleepingAt) < fixture.actor.size * 1.6, "waking stays on the clearing");
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("a DEV mushroom interaction cannot consume a prop while its hero is hidden", async () => {
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD } = await modules();
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, showHero: false });
    const initial = { ...options, view: "world", reducedMotion: false, presenceKey: "hidden-mushroom" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerLife("mushroom");
    const mushrooms = structuredClone(probe.state.life.mushrooms);
    assert.ok(mushrooms.length > 0, "the fixture has a real ground prop to interact with");
    clock.advance(3);
    for (const mushroom of mushrooms) {
      const current = probe.state.life.mushrooms.find(item => item.id === mushroom.id);
      assert.ok(current.growth >= mushroom.growth, "a hidden interaction cannot pick an unseen mushroom");
      assert.equal(current.regrowIn, 0);
    }
    assert.notEqual(probe.state.life.routine?.picked, true);
    worldDevStore.patch({ showHero: true });
    worldDevStore.triggerLife("mushroom");
    clock.advance(3);
    assert.equal(probe.state.life.routine?.picked, true, "the visible requested interaction still picks its prop normally");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("tapping a held mushroom finishes putting it back before greeting and repeated taps do not restart cleanup", async () => {
  const { mountHabitat, worldDevStore, pixelSprite, connectForestSession, TILED_WORLD } = await modules();
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, view: "world", reducedMotion: false, presenceKey: "interrupted-mushroom" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const clock = sceneClock(env), sample = () => sampleHero(scene, env, pixelSprite);
    worldDevStore.triggerLife("mushroom"); clock.advance(3);
    assert.equal(probe.state.life.routine?.picked, true);
    const id = probe.state.life.routine.mushroomId;
    assert.equal(sample().hasPose("hold"), true, "the actor visibly holds the uneaten mushroom");
    const beforeStill = sample();
    const heldRectangles = sample => sample.calls.slice(sample.calls.indexOf(sample.body) + 1)
      .filter(call => call.method === "fillRect");
    assert.ok(heldRectangles(beforeStill).length > 0, "the held prop is painted after the body");
    scene.configure({ ...initial, reducedMotion: true });
    clock.step(60_000);
    const frozen = sample();
    assert.equal(frozen.body.args[0], beforeStill.body.args[0], "reduced motion keeps the current holding pose");
    assert.deepEqual(heldRectangles(frozen), heldRectangles(beforeStill), "reduced motion freezes the held prop instead of hiding it");
    scene.configure(initial); clock.step();
    scene.notice();
    assert.equal(sample().hasPose("hold"), true, "the touch does not instantly discard the held object");
    for (let i = 0; i < 16; i++) { scene.notice(); clock.step(); }
    assert.equal(probe.state.life.routine, null, "repeat touches cannot keep restarting the finite put-back animation");
    const restored = probe.state.life.mushrooms.find(mushroom => mushroom.id === id);
    assert.equal(restored.growth, 1); assert.equal(restored.regrowIn, 0);
    const response = new Set();
    for (let i = 0; i < 32; i++) {
      const hero = sample();
      for (const pose of ["greet", "wonder", "jump", "blink", "idle"]) if (hero.hasPose(pose)) response.add(pose);
      clock.step();
    }
    assert.ok(response.has("greet") || response.has("wonder") || response.has("jump"), "the queued touch response runs after the prop is safe");
    assert.deepEqual(scene.position(), { x: fixture.actor.spawn.x, y: fixture.actor.spawn.y - fixture.actor.size / 2 });
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("only visible inactivity sends the hero indoors and a map tap on the house wakes him along the authored path", async () => {
  const { mountHabitat, createMapEngine, worldDevStore, pixelSprite } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(); let scene, engine;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, view: "world", reducedMotion: false, presenceKey: "natural-residence" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); env.finish(); await flush();
    const clock = sceneClock(env), sample = () => sampleHero(scene, env, pixelSprite);
    const spawn = scene.position();
    clock.advance(179);
    assert.ok(sample().body, "the character remains outdoors before three active minutes without taps");
    for (const mode of ["paused", "backgrounded", "hidden", "reducedMotion"]) {
      if (mode === "hidden") env.visibility(true); else scene.configure({ ...initial, [mode]: true });
      const before = scene.ambience().elapsed, position = scene.position();
      clock.step(300_000);
      assert.equal(scene.ambience().elapsed, before, `${mode} must not count as player inactivity`);
      assert.deepEqual(scene.position(), position);
      if (mode === "hidden") env.visibility(false); else scene.configure(initial);
      clock.step();
      assert.ok(sample().body, `${mode} cannot catch up to a hidden indoor sleep on resume`);
    }
    clock.until(() => !sample().body, "the actor walks to the authored entrance and disappears inside", 700);
    assert.deepEqual(scene.position(), { x: clearingHome.doorway.x, y: clearingHome.doorway.y - fixture.actor.size / 2 });
    const oldTouch = circlePoint({ x: spawn.x, y: fixture.actor.spawn.y - 1 });
    const housePoint = { x: 675, y: 610 }, houseTouch = circlePoint(housePoint);
    assert.equal(scene.hitPet(oldTouch.x, oldTouch.y), false, "the departed clearing position is not a ghost touch target");
    assert.equal(scene.hitPet(houseTouch.x, houseTouch.y), true, "the sleeping character can be reached through the house");

    const map = env.surface(400);
    engine = await createMapEngine(map, initial, assert.fail, []);
    engine.control("overview");
    const tap = { pointerId: 1, pointerType: "touch", button: 0,
      clientX: housePoint.x * 400 / fixture.width, clientY: housePoint.y * 400 / fixture.height };
    map.events.get("pointerdown")({ ...tap, type: "pointerdown" });
    map.events.get("pointerup")({ ...tap, type: "pointerup" });
    engine.dispose(); engine = null;
    clock.until(() => Boolean(sample().body), "the real map pointer handler starts the resident's exit", 100);
    let previous = scene.position();
    const awakePoses = new Set();
    for (let i = 0; i < 240; i++) {
      if (i < 60) scene.notice();
      clock.step();
      const current = scene.position(), hero = sample();
      assert.ok(hero.body, "repeat taps cannot make the hero disappear back indoors");
      assert.equal(hero.hasPose("sleep"), false, "waking does not resume the former sleep");
      assert.equal(hero.hasPose("drowsy"), false, "after walking outside the resident stays standing instead of curling up again");
      assert.ok(distanceBetween(current, previous) <= fixture.actor.size * .36 * .05 + 1e-7,
        "returning from the doorway moves continuously without a spawn teleport");
      for (const pose of ["walk", "stretch", "greet", "idle", "blink", "wonder"]) if (hero.hasPose(pose)) awakePoses.add(pose);
      previous = current;
    }
    assert.ok(awakePoses.has("walk"), "wake-up includes actual movement out of the house");
    assert.ok(awakePoses.has("stretch") || awakePoses.has("greet"), "the character acknowledges the wake-up after coming outside");
    assert.deepEqual(scene.position(), spawn, "repeated taps do not pin the exit or prevent returning to the clearing");
  } finally { engine?.dispose(); scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("indoor sleep survives circle/world ownership handoff and a circle tap wakes the shared resident", async () => {
  const { mountHabitat, worldDevStore, pixelSprite } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(), scenes = [];
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "shared-residence" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    env.finish(); env.finish(); await flush();
    worldDevStore.triggerLife("home-sleep");
    const clock = sceneClock(env);
    clock.until(() => !sampleHero(world, env, pixelSprite).body, "DEV uses the same route and indoor sleep as automatic life", 500);
    const sleepingAt = world.position(), elapsed = world.ambience().elapsed;
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    await flush();
    assert.deepEqual(circle.position(), sleepingAt);
    assert.equal(sampleHero(circle, env, pixelSprite).body, undefined, "mounting a second view does not reveal the sleeping body");
    assert.equal(env.frames.size, 1, "both views retain a single active residence clock");
    world.dispose();
    await flush();
    assert.deepEqual(circle.position(), sleepingAt); assert.equal(circle.ambience().elapsed, elapsed);
    assert.equal(sampleHero(circle, env, pixelSprite).body, undefined, "returning to the circle preserves indoor sleep");
    circle.notice();
    clock.until(() => Boolean(sampleHero(circle, env, pixelSprite).body), "tapping the circle brings its resident outside", 100);
    clock.advance(4);
    assert.equal(sampleHero(circle, env, pixelSprite).hasPose("sleep"), false);
  } finally { scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});

test("hiding the home returns its sleeping resident outside even when automatic life is disabled", async () => {
  const { mountHabitat, worldDevStore, pixelSprite } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(); let scene;
  try {
    worldDevStore.patch(quietClearing);
    scene = mountHabitat(env.surface(), { ...options, view: "world", reducedMotion: false },
      { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); const houseImage = env.finish(); await flush();
    const spawn = scene.position(), clock = sceneClock(env), sample = () => sampleHero(scene, env, pixelSprite);
    worldDevStore.triggerLife("home-sleep");
    clock.until(() => !sample().body, "the resident falls asleep inside the visible home", 500);
    worldDevStore.patch({ autoLife: false, showBuildings: false });
    assert.equal(sample().calls.some(call => call.method === "drawImage" && call.args[0] === houseImage), false,
      "the home is actually hidden by the development control");
    clock.until(() => Boolean(sample().body) && distanceBetween(scene.position(), spawn) < .001,
      "finishing the necessary exit must not depend on automatic life being enabled", 400);
    assert.equal(worldDevStore.getSnapshot().autoLife, false, "the cleanup does not change the user's development setting");
    const returnedAt = scene.position();
    clock.advance(10);
    assert.deepEqual(scene.position(), returnedAt, "after the safe return no new automatic walk begins");
    assert.ok(sample().body, "the character remains visible once his house disappears");
    assert.equal(sample().hasPose("sleep"), false);
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("DEV bush interaction walks, jumps, hides and returns while automatic life stays disabled", async () => {
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD, pixelSprite, clearingActivityFrame } = await modules({
    bushes: [clearingBush], paths: [clearingBushPath],
  });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "dev-bush" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    assert.ok(probe.state.clearing.diagnostics.every(item => item.valid), JSON.stringify(probe.state.clearing.diagnostics));
    const spawn = scene.position(), clock = sceneClock(env), stages = new Set(), poses = new Set();
    worldDevStore.triggerLife("bush");
    assert.deepEqual(scene.position(), spawn, "requesting the scene cannot teleport to its target");
    let hidden = false, lifted = false, returned = false, foreground = false, particles = false;
    for (let index = 0; index < 500 && !returned; index++) {
      clock.step();
      const frame = clearingActivityFrame(probe.state.clearing), sample = sampleHero(scene, env, pixelSprite);
      stages.add(probe.state.clearing.stage);
      for (const pose of ["walk", "jump", "crouch", "shake", "blink"]) if (sample.hasPose(pose)) poses.add(pose);
      lifted ||= frame.lift > 0 && sample.hasPose("jump");
      assert.ok(sample.body, `${probe.state.clearing.stage}: the bush never removes the rendered actor`);
      assert.equal(frame.opacity, 1, "foliage, not an opacity switch, hides the actor");
      if (probe.state.clearing.stage !== "home") {
        assert.equal(frame.bush?.occlude, true, `${probe.state.clearing.stage}: route boundaries cannot toggle the foreground off`);
      }
      if (probe.state.clearing.stage === "bush-hidden") {
        hidden = true;
        assert.ok(bushMaskAfterBody(sample), "the hidden actor remains drawn behind the authored leaf contour");
      }
      if (frame.bush?.occlude) {
        assert.ok(bushMaskAfterBody(sample), `${probe.state.clearing.stage}: foliage stays in front throughout approach and return`);
        foreground = true;
      }
      particles ||= bushParticleDraws(sample).length > 0;
      returned = hidden && probe.state.clearing.stage === "home";
    }
    assert.ok(returned && hidden && lifted && foreground, "the full rendered story includes lift, foliage occlusion, hiding and return");
    for (const stage of ["outbound", "bush-prepare", "bush-enter", "bush-hidden", "bush-exit", "bush-land", "return", "home"]) {
      assert.ok(stages.has(stage), `the scene must visit ${stage}`);
    }
    assert.ok(poses.has("walk") && poses.has("jump") && poses.has("shake"), "travel, jumping and shaking leaves off use distinct sprites");
    assert.ok(particles, "rummaging shakes visible berries out of the foliage");
    assert.deepEqual(scene.position(), spawn);
    assert.equal(worldDevStore.getSnapshot().autoLife, false);
    clock.advance(10);
    assert.deepEqual(scene.position(), spawn, "completing an explicit DEV request does not enable new automatic outings");
    assert.equal(clearingActivityFrame(probe.state.clearing).bush, undefined, "finite berry effects expire even when automatic life stays off");
    assert.equal(bushParticleDraws(sampleHero(scene, env, pixelSprite)).length, 0, "no berries remain permanently in the air");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("a map tap on an occupied bush starts a continuous exit and repeat taps cannot trap the pet", async () => {
  const { mountHabitat, createMapEngine, worldDevStore, connectForestSession, TILED_WORLD, pixelSprite } = await modules({
    bushes: [clearingBush], paths: [clearingBushPath],
  });
  const env = browser(); let scene, probe, engine;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "bush-touch", view: "world" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const spawn = scene.position(), clock = sceneClock(env), touch = circlePoint(clearingBush.hide);
    assert.equal(scene.hitPet(touch.x, touch.y), false, "an empty bush is not a ghost character touch target");
    worldDevStore.triggerLife("bush");
    clock.until(() => probe.state.clearing.stage === "outbound", "the request begins its authored approach", 20);
    assert.ok(bushMaskAfterBody(sampleHero(scene, env, pixelSprite)), "the foreground exists before the character reaches the bush");
    assert.equal(scene.hitPet(touch.x, touch.y), false, "an approach mask does not make the still-empty bush an occupied touch target");
    clock.until(() => probe.state.clearing.stage === "bush-hidden", "the character enters the actual bush", 200);
    assert.ok(bushMaskAfterBody(sampleHero(scene, env, pixelSprite)));
    assert.equal(scene.hitPet(touch.x, touch.y), true, "the authored foliage makes its hidden resident reachable");
    const map = env.surface(400);
    engine = await createMapEngine(map, initial, assert.fail, []);
    engine.control("overview");
    const point = clearingBush.hide, event = { pointerId: 1, pointerType: "touch", button: 0,
      clientX: point.x * 400 / fixture.width, clientY: point.y * 400 / fixture.height };
    map.events.get("pointerdown")({ ...event, type: "pointerdown" });
    map.events.get("pointerup")({ ...event, type: "pointerup" });
    assert.equal(probe.state.clearing.stage, "bush-exit", "the real map handler wakes the hidden resident");
    assert.ok(distanceBetween(scene.position(), spawn) > 10, "touch does not snap back to the clearing");
    engine.dispose(); engine = null;
    clock.until(() => probe.state.clearing.stage === "bush-land", "the pet physically leaves the foliage", 80);
    for (let index = 0; index < 160; index++) { scene.notice(); clock.step(); }
    assert.deepEqual(scene.position(), spawn, "even repeated touches finish the exit and return");
    assert.equal(scene.hitPet(touch.x, touch.y), false, "departing removes the occupied-bush touch target");
    assert.ok(sampleHero(scene, env, pixelSprite).body);
  } finally { engine?.dispose(); scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("a hidden bush resident survives camera handoff and pause without restarting or revealing the actor", async () => {
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD, pixelSprite } = await modules({
    bushes: [clearingBush], paths: [clearingBushPath],
  });
  const env = browser(), scenes = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "shared-bush" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerLife("bush");
    clock.until(() => probe.state.clearing.stage === "bush-hidden", "circle reaches the hidden phase", 200);
    const snapshot = structuredClone(probe.state.clearing);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    await flush();
    assert.deepEqual(probe.state.clearing, snapshot, "opening the world preserves the exact scene phase");
    assert.equal(env.frames.size, 1);
    const circleSample = sampleHero(circle, env, pixelSprite), worldSample = sampleHero(world, env, pixelSprite);
    assert.ok(bushMaskAfterBody(circleSample)); assert.ok(bushMaskAfterBody(worldSample));
    const berries = bushParticleDraws(circleSample);
    assert.ok(berries.length, "handoff occurs with airborne berries, not only an empty effect clock");
    assert.deepEqual(bushParticleDraws(worldSample), berries, "both cameras share each berry's exact position");
    circle.configure({ ...initial, backgrounded: true });
    for (const mode of ["paused", "reducedMotion"]) {
      world.configure({ ...initial, view: "world", [mode]: true });
      const frozen = structuredClone(probe.state.clearing);
      const frozenSample = sampleHero(world, env, pixelSprite);
      clock.step(60_000);
      assert.deepEqual(probe.state.clearing, frozen, `${mode} cannot advance the bush choreography`);
      const stillSample = sampleHero(world, env, pixelSprite);
      assert.ok(bushMaskAfterBody(stillSample), `${mode} keeps the actor behind its foliage`);
      assert.deepEqual(bushParticleDraws(stillSample), bushParticleDraws(frozenSample), `${mode} freezes the falling berries`);
      assert.deepEqual(stillSample.body.args, frozenSample.body.args, `${mode} preserves the tucked pose and body position`);
      world.configure({ ...initial, view: "world" }); clock.step();
    }
    const beforeReturn = structuredClone(probe.state.clearing);
    world.dispose(); circle.configure(initial); await flush();
    assert.deepEqual(probe.state.clearing, beforeReturn);
    assert.ok(bushMaskAfterBody(sampleHero(circle, env, pixelSprite)));
    clock.until(() => probe.state.clearing.stage === "home", "returning to the circle finishes the existing outing", 240);
    assert.ok(sampleHero(circle, env, pixelSprite).body);
  } finally { scenes.forEach(scene => scene.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("water outlines are an independent DEV overlay above night lighting and redraw while paused", async () => {
  const rectangle = (x, y, size) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
  const water = { surfaces: [{ id: "river", points: rectangle(900, 950, 100) }],
    exclusions: [{ id: "leaf", points: rectangle(930, 980, 10) }] };
  const { mountHabitat, worldDevStore } = await modules({ water });
  const env = browser(); let scene;
  try {
    worldDevStore.patch({ ...quietClearing, paused: true, timeOfDay: "night", debug: false, debugWater: false });
    const canvas = env.surface();
    scene = mountHabitat(canvas, options, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    const sample = () => { const target = env.surface(); scene.paintWorld(target.context); return target.calls; };
    const colors = calls => calls.filter(call => call.method === "strokeStyle").map(call => call.args[0]);
    const generalBounds = calls => calls.some(call => call.method === "strokeRect"
      && call.args.join() === Object.values(fixture.focus).join());
    assert.equal(colors(sample()).includes("#58e5ff"), false);
    const before = canvas.calls.length;
    worldDevStore.patch({ debugWater: true });
    assert.ok(canvas.calls.length > before, "the new toggle redraws the paused circle without a frame loop");
    const outlined = sample();
    assert.ok(colors(outlined).includes("#58e5ff") && colors(outlined).includes("#ff997e"), "water and exclusions have distinct outlines");
    assert.equal(generalBounds(outlined), false, "water debugging does not enable all map markup");
    assert.ok(outlined.findIndex(call => call.method === "strokeStyle" && call.args[0] === "#58e5ff")
      > outlined.findIndex(call => call.method === "globalCompositeOperation" && call.args[0] === "multiply"),
    "night shading cannot hide the debug boundaries");
    worldDevStore.patch({ debugWater: false, debug: true });
    const marked = sample();
    assert.equal(colors(marked).includes("#58e5ff"), false);
    assert.equal(generalBounds(marked), true, "ordinary markup stays independently available");
    assert.equal(env.frames.size, 0);
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("a real insect is painted once through contact, camera handoff, pause and a reduced-motion tap", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite } =
    await modules({ habitats: livingHabitats, navigation: livingNavigation });
  const env = browser(), scenes = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, butterflies: "on" });
    const initial = { ...options, reducedMotion: false, presenceKey: "persistent-visitor" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const ids = probe.state.fauna.entities.map(entity => entity.id), clock = sceneClock(env);
    worldDevStore.triggerLife("butterfly");
    clock.until(() => probe.state.fauna.encounter !== null, "a DEV request reserves a nearby real body");
    const partner = probe.state.fauna.entities.find(entity => entity.id === probe.state.fauna.encounter.entityId);
    const reservation = probe.state.fauna.encounter;
    clock.until(() => probe.state.fauna.encounter?.phase === "perch", "the individual physically reaches the paw");
    assert.equal(probe.state.life.routine, null);
    const contact = sampleHero(circle, env, pixelSprite);
    assert.equal(contact.hasPose("greet"), true);
    assert.equal(contact.calls.filter(call => call.method === "translate" && call.args[0] === partner.x && call.args[1] === partner.y).length, 1,
      "the ambient painter paints the reserved body exactly once");
    const atContact = structuredClone(probe.state.fauna);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world); await flush();
    assert.equal(env.frames.size, 1); assert.equal(probe.state.fauna.encounter, reservation);
    assert.deepEqual(probe.state.fauna, atContact, "mounting the other camera cannot advance or recreate the visitor");
    const otherContact = sampleHero(world, env, pixelSprite);
    assert.equal(otherContact.body.args[0], contact.body.args[0]);
    assert.equal(otherContact.calls.filter(call => call.method === "translate" && call.args[0] === partner.x && call.args[1] === partner.y).length, 1);
    worldDevStore.patch({ paused: true });
    const paused = structuredClone(probe.state); clock.step(60_000); assert.deepEqual(probe.state, paused);
    worldDevStore.patch({ paused: false, reducedMotion: "on" });
    const still = structuredClone(probe.state); clock.step(60_000); assert.deepEqual(probe.state, still);
    const coordinates = probe.state.fauna.entities.map(({ id, x, y }) => ({ id, x, y }));
    world.notice();
    assert.equal(probe.state.fauna.encounter, null);
    assert.deepEqual(probe.state.fauna.entities.map(({ id, x, y }) => ({ id, x, y })), coordinates,
      "a static greeting releases the paw constraint at the insect's exact world position");
    clock.step(60_000);
    assert.deepEqual(probe.state.fauna.entities.map(({ id, x, y }) => ({ id, x, y })), coordinates);
    worldDevStore.patch({ reducedMotion: "off" }); clock.advance(.1);
    assert.equal(partner.mode, "depart");
    assert.ok(distanceBetween(partner, coordinates.find(entity => entity.id === partner.id)) < 1.2);
    assert.deepEqual(probe.state.fauna.entities.map(entity => entity.id), ids);
    assert.equal(probe.state.fauna.entities.find(entity => entity.id === partner.id), partner);
    env.visibility(true); const hidden = structuredClone(probe.state); clock.step(60_000); assert.deepEqual(probe.state, hidden);
    env.visibility(false); world.dispose(); await flush();
    assert.equal(env.frames.size, 1); assert.equal(probe.state.fauna.entities.find(entity => entity.id === partner.id), partner);
  } finally { scenes.forEach(scene => scene.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("visible taps let the same insect depart before the actor greets and repeated taps cannot restart release", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, clearingActivityFrame } = await modules({ habitats: livingHabitats });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, butterflies: "on" });
    const initial = { ...options, reducedMotion: false, presenceKey: "visitor-attention" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const clock = sceneClock(env); worldDevStore.triggerLife("butterfly");
    clock.until(() => probe.state.fauna.encounter?.phase === "perch", "the real butterfly reaches contact");
    const partner = probe.state.fauna.entities.find(entity => entity.id === probe.state.fauna.encounter.entityId);
    const point = { x: partner.x, y: partner.y }, feet = scene.position();
    scene.notice(); assert.equal(probe.state.pendingAttention, true);
    assert.deepEqual({ x: partner.x, y: partner.y }, point, "the tap does not teleport the perched body");
    for (let index = 0; index < 13; index++) { scene.notice(); clock.step(); }
    assert.equal(probe.state.fauna.encounter, null); assert.equal(probe.state.pendingAttention, false);
    assert.equal(partner.mode, "depart"); assert.equal(clearingActivityFrame(probe.state.clearing).attention, true);
    assert.deepEqual(scene.position(), feet);
    assert.equal(probe.state.life.routine, null);
    assert.equal(probe.state.fauna.entities.find(entity => entity.id === partner.id), partner);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("DEV navigation comparison and independent living overlays redraw a paused scene without advancing it", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } =
    await modules({ navigation: livingNavigation, habitats: livingHabitats, paths: [clearingPath], mushrooms: [] });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "living-overlays" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    probe.state.life.leaf = null;
    const clock = sceneClock(env), home = scene.position();
    clock.until(() => probe.state.clearing.stage === "free-walk" && distanceBetween(scene.position(), home) > 3, "free movement begins");
    const beforeSwitch = scene.position(); worldDevStore.patch({ navigationMode: "routes" });
    assert.deepEqual(scene.position(), beforeSwitch);
    clock.until(() => !probe.state.clearing.navigationEnabled, "the DEV route mode takes effect after a physical return");
    assert.ok(distanceBetween(scene.position(), home) < 1);
    clock.until(() => probe.state.clearing.stage === "outbound", "the old authored route can still be compared");
    worldDevStore.patch({ navigationMode: "auto" });
    clock.until(() => probe.state.clearing.navigationEnabled, "free navigation can be restored safely");
    worldDevStore.patch({ paused: true, debugNavigation: true, debugFauna: false });
    const frozen = structuredClone(probe.state), nav = env.surface(); scene.paintWorld(nav.context);
    assert.ok(nav.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#78edb0"));
    assert.equal(nav.calls.some(call => call.method === "fillText" && String(call.args[0]).includes("test-flowers")), false);
    worldDevStore.patch({ debugNavigation: false, debugFauna: true });
    const fauna = env.surface(); scene.paintWorld(fauna.context);
    assert.ok(fauna.calls.some(call => call.method === "fillText" && String(call.args[0]).includes(probe.state.fauna.entities[0].id)));
    assert.equal(fauna.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#78edb0"), false);
    assert.deepEqual(probe.state, frozen); assert.equal(env.frames.size, 0);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("static night and DEV lighting edits update real firefly glow without advancing their bodies", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ habitats: livingHabitats });
  const env = browser(); let scene, probe;
  function glowFrame() {
    const base = env.surface().context, values = []; let fillStyle, alpha = 1;
    const context = new Proxy(base, {
      get(target, key) {
        if (key === "createRadialGradient") return () => ({ firefly: false,
          addColorStop(_at, color) { if (color === "rgba(225,246,147,.48)") this.firefly = true; } });
        if (key === "fill") return () => { if (fillStyle?.firefly) values.push(alpha); };
        return target[key];
      },
      set(target, key, value) {
        if (key === "fillStyle") fillStyle = value;
        if (key === "globalAlpha") alpha = value;
        target[key] = value; return true;
      },
    });
    scene.paintWorld(context); return values;
  }
  try {
    worldDevStore.patch({ ...quietClearing, timeOfDay: "auto", fireflies: "auto", autoLife: false });
    const initial = { ...options, dusk: true, presenceKey: "static-night-fireflies" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 1, () => {});
    const frozen = structuredClone(probe.state.fauna), night = glowFrame();
    assert.equal(night.length, 3); assert.ok(night.every(alpha => alpha > 0), "a first static night frame has luminous real insects");
    worldDevStore.patch({ timeOfDay: "day" });
    assert.ok(glowFrame().every(alpha => alpha === 0), "daylight suppresses the halo while keeping the insect body");
    worldDevStore.patch({ fireflies: "on" });
    assert.ok(glowFrame().every(alpha => alpha > 0), "the explicit DEV override updates a frozen frame immediately");
    assert.deepEqual(probe.state.fauna, frozen); assert.equal(env.frames.size, 0);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});
