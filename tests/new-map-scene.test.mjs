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
      ...await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts"),
      ...await vite.ssrLoadModule("/features/mochlik/pixel-sprite.ts"),
      ...await vite.ssrLoadModule("/features/world/forest-session.ts"),
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
        if (key === "globalCompositeOperation") calls.push({ method: "globalCompositeOperation", args: [value] });
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
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD } = await modules();
  const env = browser(), scenes = [], probes = [];
  try {
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "life-account" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    env.finish(); await flush();
    const probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {}); probes.push(probe);
    worldDevStore.triggerBirds();
    assert.equal(probe.state.birdSeed, 0, "both cameras consume the first bird visit only once");
    assert.equal(probe.state.birdStarted, probe.state.elapsed);
    worldDevStore.triggerBirds();
    assert.equal(probe.state.birdSeed, 1, "another DEV invocation chooses the next shared scenario");
    worldDevStore.triggerPose("greet"); worldDevStore.triggerLife("butterfly");
    assert.equal(probe.state.life.routine.kind, "butterfly", "second subscriber cannot cancel the first subscriber's new routine");
    assert.equal(probe.state.animation, null);
    worldDevStore.patch({ pose: "sleep" }); worldDevStore.triggerLife("firefly");
    assert.equal(probe.state.life.routine.kind, "firefly", "changing a held pose to auto is also a single shared transition");
    worldDevStore.patch({ paused: true });
    const paused = structuredClone(probe.state); env.tick(10_000);
    assert.deepEqual(probe.state, paused); assert.equal(env.frames.size, 0);
    worldDevStore.patch({ paused: false, reducedMotion: "on" });
    const still = structuredClone(probe.state); env.tick(20_000);
    assert.deepEqual(probe.state, still); assert.equal(env.frames.size, 0);
    worldDevStore.patch({ reducedMotion: "off" }); worldDevStore.triggerPose("jump");
    assert.equal(probe.state.life.routine, null, "manual sprite poses cancel interaction props immediately");
    world.configure({ ...initial, presenceKey: "other-account", view: "world" });
    const other = connectForestSession("other-account", TILED_WORLD, "circle", 0, 0, () => {}); probes.push(other);
    assert.notEqual(other.state, probe.state); assert.equal(other.state.life.elapsed, 0);
    assert.equal(other.state.animation, null); assert.equal(other.state.wetness, 0);
    await flush(); assert.equal(env.frames.size, 2, "different accounts and anonymous scenes remain independent");
  } finally { probes.forEach(probe => probe.release()); scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});

const clearingPath = { id: "clearing-fern", label: "Fern", behavior: "clearing", activity: "groom", pauseSeconds: 3,
  points: [{ ...fixture.actor.spawn }, { x: 617, y: 654 }, { x: 605, y: 647 }] };
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

test("authored clearing routes move the rendered pet, its hit area and camera target together", async () => {
  const { mountHabitat, createMapEngine, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite } = await modules({ paths: [clearingPath] });
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
    canvas.calls.length = 0; clock.advance(.8);
    const grooming = [0, 1, 2, 3].map(frame => pixelSprite("groom", "front", frame));
    assert.ok(canvas.calls.some(call => call.method === "drawImage" && grooming.includes(call.args[0])),
      "the authored endpoint activity reaches the visible sprite rather than remaining only controller state");
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
    tap(home, 1); assert.equal(probe.state.reaction, 0, "a map tap at the old spawn also misses");
    tap(target, 2); assert.ok(probe.state.reaction > 0, "a map tap finds and greets the relocated pet");
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
    const greetedAt = scene.position(), leg = probe.state.clearing.stage;
    scene.notice(); clock.advance(.8);
    assert.deepEqual(scene.position(), greetedAt, "greeting freezes translation at the actual location");
    assert.equal(probe.state.clearing.stage, leg, "greeting does not discard the remaining path");
    assert.equal(activities.at(-1), "greet");
    clock.advance(.25);
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
