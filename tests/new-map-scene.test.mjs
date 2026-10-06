import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = {
  schemaVersion: 1, id: "test-scene", width: 1254, height: 1254,
  terrain: [{ id: "ground", image: "/test-ground.webp", bounds: { x: 0, y: 0, width: 1254, height: 1254 } }],
  focus: { x: 455, y: 480, width: 350, height: 350 },
  actor: { spawn: { x: 630, y: 660 }, size: 36 }, sites: [], paths: [], lights: [], destinations: [],
  water: { surfaces: [], exclusions: [] }, bushes: [], campfires: [], basket: undefined, navigation: undefined, habitats: undefined,
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
const sourceAndDestination = args => args.length === 5
  ? [args[0], 0, 0, args[0].naturalWidth, args[0].naturalHeight, ...args.slice(1)] : args;
const builderRigForHero = new WeakMap();

async function modules(override) {
  const vite = await createServer({ appType: "custom", configFile: false, root,
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { default: scene } = await vite.ssrLoadModule("/features/world/tiled/forest.generated.json");
    Object.assign(scene, structuredClone(fixture), override);
    const loaded = {
      ...await vite.ssrLoadModule("/features/mochlik/scene.ts"),
      ...await vite.ssrLoadModule("/features/world/map-engine.ts"),
      ...await vite.ssrLoadModule("/features/world/art.ts"),
      ...await vite.ssrLoadModule("/features/world/presentation.ts"),
      ...await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts"),
      ...await vite.ssrLoadModule("/features/mochlik/pixel-sprite.ts"),
      ...await vite.ssrLoadModule("/features/world/forest-session.ts"),
      ...await vite.ssrLoadModule("/features/world/tiled/preview-state.ts"),
      ...await vite.ssrLoadModule("/features/world/navigation.ts"),
      ...await vite.ssrLoadModule("/features/world/clearing-activity.ts"),
      ...await vite.ssrLoadModule("/features/world/new-map-scene.ts"),
      ...await vite.ssrLoadModule("/features/world/economy-scene-state.ts"),
      ...await vite.ssrLoadModule("/features/world/economy-production-state.ts"),
      ...await vite.ssrLoadModule("/features/world/forest-observer.ts"),
      ...await vite.ssrLoadModule("/features/world/forest-journey-travel.ts"),
      ...await vite.ssrLoadModule("/features/world/forest-fishing-painter.ts"),
      ...await vite.ssrLoadModule("/features/world/dev/forest-cooking-preview.ts"),
      ...await vite.ssrLoadModule("/features/world/builder-sprite.ts"),
      ...await vite.ssrLoadModule("/features/world/builder-mind.ts"),
    };
    builderRigForHero.set(loaded.pixelSprite, loaded.builderSpriteRig);
    return loaded;
  } finally { await vite.close(); }
}

function browser() {
  const saved = new Map(), pending = [], requests = [], timers = new Map(), frames = new Map(), observers = [];
  const documentEvents = new Map();
  let id = 0, frameTime = 0;
  const install = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  function surface(width = 320, height = width) {
    const calls = [], events = new Map(), captured = new Set();
    const context = new Proxy({
      createRadialGradient: () => ({ addColorStop() {} }),
      createLinearGradient: () => ({ addColorStop() {} }),
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
      flushFrame() { const current = [...frames.values()]; frames.clear(); frameTime += 34; current.forEach(callback => callback(frameTime)); },
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
    assert.deepEqual(sourceAndDestination(groundCalls(circle).at(-1).args), sourceToWorld);
    assert.deepEqual(sourceAndDestination(groundCalls(fullWorld).at(-1).args), sourceToWorld);
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

test("authored buildings and planned ruins open their place without selecting during a drag", async () => {
  const sites = ["workshop", "quarry", "bridge", "lighthouse"].map((id, index) => {
    const x = 100 + index * 240, y = 180;
    const points = [{ x, y }, { x: x + 120, y }, { x: x + 120, y: y + 100 }, { x, y: y + 100 }];
    return { id, label: id, initialLevel: 0, bounds: { x, y, width: 120, height: 100 },
      anchor: { x: x + 60, y: y + 100 }, entry: { x: x + 60, y: y + 110 }, hitArea: points, collision: [],
      states: [{ level: 0, label: id, image: `/click-${id}.webp` }] };
  });
  const { createMapEngine, worldDevStore } = await modules({ sites });
  const env = browser(); let engine;
  try {
    const canvas = env.surface(400), places = [];
    const anchors = sites.slice(0, 2).map(site => ({ dataset: { siteId: site.id, kind: site.id, x: site.anchor.x, y: site.anchor.y }, style: {} }));
    const loading = createMapEngine(canvas, options, place => places.push(place), anchors);
    env.finish(); await flush();
    for (const site of sites) env.finishPath(site.states[0].image);
    engine = await loading;
    engine.control("overview");
    for (const anchor of anchors) {
      assert.equal(anchor.style.visibility, "visible");
      assert.match(anchor.style.transform, /^translate\(/);
    }
    const tap = site => {
      const event = { pointerId: 1, pointerType: "mouse", button: 0,
        clientX: site.anchor.x * 400 / fixture.width, clientY: (site.anchor.y - 50) * 400 / fixture.height };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    sites.forEach(tap);
    assert.deepEqual(places, ["workshop", "quarry", "bridge", "lighthouse"]);
    dragMap(canvas, 45, 0);
    assert.deepEqual(places, ["workshop", "quarry", "bridge", "lighthouse"], "panning does not select a place");
    worldDevStore.patch({ showBuildings: false });
    sites.forEach(tap);
    assert.deepEqual(places, ["workshop", "quarry", "bridge", "lighthouse"]);
    for (const anchor of anchors) assert.equal(anchor.style.visibility, "hidden");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
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
  canvas.flushFrame();
}

const approximately = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} ≈ ${expected}`);

test("map object selection tracks projected anchors through camera changes and deduplicates unchanged pixels", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), places = [], selections = [];
    const anchor = { dataset: { objectId: "home", kind: "house" }, style: {} };
    const loading = createMapEngine(canvas, options, (place, selection) => places.push({ place, selection }), [anchor], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const expectedSelection = () => {
      const projection = mapProjection(canvas);
      return { objectId: "home", place: "house", x: Math.round(projection.left + clearingHome.anchor.x * projection.zoom),
        y: Math.round(projection.top + clearingHome.anchor.y * projection.zoom),
        viewportWidth: canvas.clientWidth, viewportHeight: canvas.clientHeight };
    };
    engine.setSelectedObject("home");
    assert.deepEqual(selections, [expectedSelection()]);
    assert.deepEqual(places, [], "tracking an object does not open its menu again");
    assert.equal(engine.activateObject("home"), true);
    assert.deepEqual(places, [{ place: "house", selection: expectedSelection() }]);
    assert.equal(selections.length, 1, "activation at the same pixel does not duplicate the coordinate update");
    engine.setSelectedObject("home"); engine.update(options);
    assert.equal(selections.length, 1, "repeated selection and scene redraws keep the same coordinate sample");

    engine.control("home");
    assert.deepEqual(selections.at(-1), expectedSelection());
    assert.notDeepEqual(selections.at(-1), selections[0], "zooming moves the anchor rather than leaving a stale screen point");
    const beforePan = selections.at(-1);
    dragMap(canvas, 12, -18);
    assert.deepEqual(selections.at(-1), expectedSelection());
    assert.equal(selections.at(-1).x, beforePan.x + 12);
    assert.equal(selections.at(-1).y, beforePan.y - 18);
    assert.equal(places.length, 1, "camera movement only updates the existing selection");
    const beforeTinyZoom = selections.length;
    canvas.events.get("wheel")({ clientX: 200, clientY: 200, deltaY: .000001, preventDefault() {} });
    assert.equal(selections.length, beforeTinyZoom, "subpixel changes are rounded before coordinate notifications");

    canvas.clientWidth = 520; canvas.clientHeight = 420; env.resize(canvas);
    assert.deepEqual(selections.at(-1), expectedSelection(), "resize updates the anchor and popup viewport together");
    const event = { pointerId: 1, pointerType: "touch", button: 0, clientX: 8, clientY: 8 };
    canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
    canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    assert.equal(selections.at(-1), null, "a blank map tap closes the selected menu");
    const cleared = selections.length;
    engine.setSelectedObject(null);
    assert.equal(selections.length, cleared, "repeated closing does not emit duplicate null selections");
    assert.equal(places.length, 1);

    engine.setSelectedObject("home");
    dragMap(canvas, -10_000, -10_000);
    assert.equal(selections.at(-1), null, "panning the selected anchor outside the viewport closes the menu");
    assert.equal(places.length, 1, "offscreen closing cannot reactivate the object");
    assert.equal(engine.activateObject("home"), true, "explicit activation brings an offscreen target back into view");
    const centered = selections.at(-1);
    assert.deepEqual(centered, expectedSelection(), "the reopened menu uses the newly centered camera projection");
    assert.ok(centered.x >= 0 && centered.x <= canvas.clientWidth && centered.y >= 0 && centered.y <= canvas.clientHeight,
      "explicit activation places the target anchor inside the current viewport");
    assert.equal(places.length, 2, "centering activates the requested place exactly once");
    assert.deepEqual(places.at(-1), { place: "house", selection: centered });
    assert.equal(engine.activateObject("missing-object"), false);
    assert.equal(places.length, 2, "unknown object IDs do not fall back to an unrelated place");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("construction anchors follow live map projection without repeated React notifications on idle redraws", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), samples = [], top = { offsetHeight: 40 }, bottom = { offsetHeight: 40 };
    const loading = createMapEngine(canvas, options, assert.fail, [], undefined, { top, bottom },
      { onObjectAnchorsChange: anchors => samples.push(anchors) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const expected = () => {
      const projection = mapProjection(canvas);
      const xs = clearingHome.hitArea.map(point => point.x), ys = clearingHome.hitArea.map(point => point.y);
      return { objectId: "home", place: "house", x: Math.round(projection.left + (Math.min(...xs) + Math.max(...xs)) / 2 * projection.zoom),
        y: Math.round(projection.top + Math.min(...ys) * projection.zoom - 10), pointerOffset: 0 };
    };
    assert.deepEqual(samples.at(-1), [expected()]);
    const idleCount = samples.length;
    engine.update(options); engine.control("overview");
    assert.equal(samples.length, idleCount, "unchanged projected pixels do not notify React every frame");
    engine.control("home");
    assert.deepEqual(samples.at(-1), [expected()]);
    const beforePan = samples.at(-1)[0];
    dragMap(canvas, 12, 18);
    assert.deepEqual(samples.at(-1), [expected()]);
    assert.equal(samples.at(-1)[0].x, beforePan.x + 12);
    assert.equal(samples.at(-1)[0].y, beforePan.y + 18);
    canvas.clientWidth = 520; canvas.clientHeight = 600; env.resize(canvas);
    assert.deepEqual(samples.at(-1), [expected()], "resize updates visible construction anchors immediately");
    worldDevStore.patch({ showBuildings: false });
    assert.deepEqual(samples.at(-1), [], "hidden site artwork removes its timer anchor too");
    worldDevStore.patch({ showBuildings: true });
    assert.deepEqual(samples.at(-1), [expected()]);
    top.offsetHeight = canvas.clientHeight; env.resize(top);
    assert.deepEqual(samples.at(-1), [], "measured HUD changes hide covered timers");
    top.offsetHeight = 40; env.resize(top);
    assert.deepEqual(samples.at(-1), [expected()]);
    dragMap(canvas, -10_000, -10_000);
    assert.deepEqual(samples.at(-1), [], "an offscreen building never leaves a timer pinned to the edge");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("map object selection ignores drag pinch and canceled pointers before a real tap", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), places = [], selections = [];
    const loading = createMapEngine(canvas, options, place => places.push(place), [], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const projection = mapProjection(canvas), point = { x: 650, y: 610 };
    const first = { pointerId: 1, pointerType: "touch", button: 0,
      clientX: projection.left + point.x * projection.zoom, clientY: projection.top + point.y * projection.zoom };
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointermove")({ ...first, type: "pointermove", clientX: first.clientX + 30 });
    canvas.events.get("pointerup")({ ...first, type: "pointerup", clientX: first.clientX + 30 });
    const second = { ...first, pointerId: 2, clientX: first.clientX + 30 };
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointerdown")({ ...second, type: "pointerdown" });
    canvas.events.get("pointermove")({ ...second, type: "pointermove", clientX: first.clientX + 40 });
    canvas.events.get("pointerup")({ ...first, type: "pointerup" });
    canvas.events.get("pointerup")({ ...second, type: "pointerup", clientX: first.clientX + 40 });
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointercancel")({ ...first, type: "pointercancel" });
    assert.deepEqual(places, []); assert.deepEqual(selections, [], "gestures cannot open an object menu");

    engine.control("overview");
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointerup")({ ...first, type: "pointerup" });
    assert.deepEqual(places, ["house"]);
    assert.equal(selections.at(-1).objectId, "home", "a single completed tap uses authored object geometry");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("visible hero taps take priority over overlapping garden and house menu geometry", async () => {
  const bush = { ...clearingBush, hide: { x: 630, y: 645 },
    points: [{ x: 610, y: 620 }, { x: 640, y: 620 }, { x: 640, y: 690 }, { x: 610, y: 690 }] };
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome], bushes: [bush] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), places = [], selections = [];
    const loading = createMapEngine(canvas, options, place => places.push(place), [], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const tap = (x, y) => {
      const projection = mapProjection(canvas), event = { pointerId: 1, pointerType: "touch", button: 0,
        clientX: projection.left + x * projection.zoom, clientY: projection.top + y * projection.zoom };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    tap(fixture.actor.spawn.x, fixture.actor.spawn.y - fixture.actor.size / 2);
    assert.equal(env.timers.size, 1, "touching the visible body starts its finite attention response");
    assert.deepEqual(places, [], "the overlapped object's footprint does not intercept a visible hero tap");
    assert.deepEqual(selections, []);
    tap(620, 680);
    assert.deepEqual(places, ["garden"], "the garden's authored area away from the hero still opens its menu");
    assert.equal(selections.at(-1).objectId, bush.id);
    tap(675, 600);
    assert.deepEqual(places, ["garden", "house"], "the house's area away from the hero still opens its menu");
    assert.equal(selections.at(-1).objectId, "home");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("foreground contours let hidden hero taps reach buildings while visible portions keep their response", async () => {
  for (const partial of [false, true]) {
    const mask = { id: "roof", frontY: 670, points: [
      { x: 610, y: 600 }, { x: partial ? 630 : 650, y: 600 },
      { x: partial ? 630 : 650, y: 670 }, { x: 610, y: 670 },
    ] };
    const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome], occluders: [mask] });
    const env = browser(); let engine;
    try {
      worldDevStore.patch(quietClearing);
      const canvas = env.surface(400), places = [], selections = [];
      const loading = createMapEngine(canvas, options, place => places.push(place), [], undefined, {},
        { onSelectionChange: selection => selections.push(selection) });
      env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
      engine.control("overview");
      const tap = (x, y) => {
        const projection = mapProjection(canvas), event = { pointerId: 1, pointerType: "touch", button: 0,
          clientX: projection.left + x * projection.zoom, clientY: projection.top + y * projection.zoom };
        canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
        canvas.events.get("pointerup")({ ...event, type: "pointerup" });
      };
      tap(625, 642);
      assert.equal(env.timers.size, 0, "a hidden part cannot start the hero's attention response");
      assert.deepEqual(places, ["house"], "the visible building receives the tap above a hidden hero");
      assert.equal(selections.at(-1).objectId, "home");
      if (partial) {
        tap(635, 642);
        assert.equal(env.timers.size, 1, "the still-visible part of the body remains tappable");
        assert.deepEqual(places, ["house"]);
        assert.equal(selections.at(-1), null, "the hero's visible response takes priority over the building");
      }
    } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
  }
});

test("object marker native touch capture opens once and preserves marker-origin drag pinch and cancellation", async () => {
  const site = { ...clearingHome, anchor: { x: 650, y: 700 } };
  const { createMapEngine, worldDevStore } = await modules({ sites: [site] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), places = [], selections = [];
    const marker = Object.assign(env.surface(), { dataset: { objectId: "home", kind: "house" }, style: {} });
    const markerEvents = marker.events;
    const loading = createMapEngine(canvas, options, place => places.push(place), [marker], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("home");
    const markerEvent = () => {
      const projection = mapProjection(canvas);
      return { pointerId: 1, pointerType: "touch", button: 0,
        clientX: projection.left + site.anchor.x * projection.zoom,
        clientY: projection.top + site.anchor.y * projection.zoom };
    };
    const first = markerEvent();
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointerup")({ ...first, type: "pointerup" });
    assert.deepEqual(places, [], "the marker anchor is deliberately outside the building hit polygon");
    assert.equal(typeof markerEvents.get("pointerdown"), "function");
    markerEvents.get("pointerdown")({ ...first, type: "pointerdown" });
    assert.equal(marker.hasPointerCapture(first.pointerId), true, "the original button retains native touch capture");
    assert.equal(canvas.hasPointerCapture(first.pointerId), false, "touch capture is not transferred to a sibling");
    markerEvents.get("pointerup")({ ...first, type: "pointerup" });
    markerEvents.get("lostpointercapture")({ ...first, type: "lostpointercapture" });
    canvas.events.get("pointerup")({ ...first, type: "pointerup" });
    assert.equal(marker.hasPointerCapture(first.pointerId), false);
    assert.deepEqual(places, ["house"], "a marker-origin tap activates its ID exactly once outside the polygon");
    assert.equal(selections.at(-1).objectId, "home");

    const drag = markerEvent(), beforeDrag = mapProjection(canvas);
    markerEvents.get("pointerdown")({ ...drag, type: "pointerdown" });
    markerEvents.get("pointermove")({ ...drag, type: "pointermove", clientX: drag.clientX + 25 });
    markerEvents.get("pointerup")({ ...drag, type: "pointerup", clientX: drag.clientX + 25 });
    canvas.flushFrame();
    assert.notDeepEqual(mapProjection(canvas), beforeDrag, "a marker-origin drag pans the same camera");
    assert.deepEqual(places, ["house"], "dragging from a marker does not activate it");
    const pinch = markerEvent(), second = { ...pinch, pointerId: 2, clientX: pinch.clientX + 30 };
    markerEvents.get("pointerdown")({ ...pinch, type: "pointerdown" });
    canvas.events.get("pointerdown")({ ...second, type: "pointerdown" });
    canvas.events.get("pointermove")({ ...second, type: "pointermove", clientX: second.clientX + 15 });
    markerEvents.get("pointerup")({ ...pinch, type: "pointerup" });
    canvas.events.get("pointerup")({ ...second, type: "pointerup", clientX: second.clientX + 15 });
    const cancel = markerEvent();
    markerEvents.get("pointerdown")({ ...cancel, type: "pointerdown" });
    markerEvents.get("pointercancel")({ ...cancel, type: "pointercancel" });
    canvas.flushFrame();
    assert.deepEqual(places, ["house"], "marker-origin pinch and cancellation cannot open a menu");
    assert.equal(marker.hasPointerCapture(1), false); assert.equal(canvas.hasPointerCapture(2), false);
    engine.dispose(); engine = null;
    assert.equal(markerEvents.size, 0, "disposing the engine removes marker-origin pointer listeners");
    assert.equal(canvas.events.size, 0);
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("pointer bursts share the next animation frame and read layout once per gesture", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), samples = [];
    let rectReads = 0, markerWrites = 0;
    const readRect = canvas.getBoundingClientRect;
    canvas.getBoundingClientRect = function () { rectReads++; return readRect.call(this); };
    const marker = { dataset: { objectId: "home", kind: "house" }, style: new Proxy({}, {
      set(target, key, value) { markerWrites++; target[key] = value; return true; },
    }) };
    const loading = createMapEngine(canvas, options, assert.fail, [marker], undefined, {},
      { onObjectAnchorsChange: anchors => samples.push(anchors) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("home"); canvas.flushFrame();
    const initial = mapProjection(canvas), paints = () => canvas.calls.filter(call => call.method === "setTransform").length;
    const before = paints(), beforeSamples = samples.length, beforeWrites = markerWrites;
    const event = { pointerId: 1, pointerType: "touch", button: 0, clientX: 200, clientY: 200 };
    canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
    for (let step = 1; step <= 120; step++) canvas.events.get("pointermove")({ ...event, type: "pointermove", clientX: 200 + step / 4 });
    assert.equal(paints(), before, "120 move packets do not each repaint the world");
    assert.equal(samples.length, beforeSamples, "construction anchor updates also wait for presentation");
    assert.equal(markerWrites, beforeWrites, "the high-rate input path does not mutate DOM marker transforms");
    assert.equal(rectReads, 1, "no synchronous layout read follows marker writes during pan");
    canvas.flushFrame();
    assert.equal(paints(), before + 1, "one browser frame paints the latest camera");
    approximately(mapProjection(canvas).left, initial.left + 30, "the camera keeps all movement rather than discarding input");
    assert.equal(samples.length, beforeSamples + 1);
    canvas.events.get("pointermove")({ ...event, type: "pointermove", clientX: 235 });
    canvas.events.get("pointerup")({ ...event, type: "pointerup", clientX: 235 });
    assert.equal(rectReads, 1, "pointerup reuses the same gesture viewport");
    assert.equal(paints(), before + 1);
    canvas.flushFrame();
    assert.equal(paints(), before + 2);
    approximately(mapProjection(canvas).left, initial.left + 35, "the release frame reaches the final camera position");
    const idleWrites = markerWrites;
    engine.control("home");
    const focusedWrites = markerWrites;
    engine.control("home");
    assert.equal(markerWrites, focusedWrites, "unchanged projected transforms do not rewrite DOM styles");
    assert.ok(focusedWrites > idleWrites);
    canvas.events.get("pointerdown")({ ...event, pointerId: 2, type: "pointerdown" });
    canvas.events.get("pointercancel")({ ...event, pointerId: 2, type: "pointercancel" });
    assert.equal(rectReads, 2, "a new gesture refreshes layout for resized or moved viewports");
    engine.dispose(); engine = null;
    assert.equal(env.frames.size, 0, "disposing removes the queued interaction frame even with reduced motion");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("construction anchor projection can be suspended until a visible timer or completion effect needs it", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), samples = [];
    const loading = createMapEngine(canvas, options, assert.fail, [], undefined, {},
      { objectAnchorsEnabled: false, onObjectAnchorsChange: anchors => samples.push(anchors) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("home"); dragMap(canvas, 25, 30);
    assert.deepEqual(samples, [], "ordinary camera movement does not notify an unused overlay");
    engine.setObjectAnchorsEnabled(true); canvas.flushFrame();
    assert.equal(samples.length, 1);
    assert.equal(samples[0][0].objectId, "home");
    const previous = samples[0][0];
    dragMap(canvas, 12, 18);
    assert.equal(samples.at(-1)[0].x, previous.x + 12);
    assert.equal(samples.at(-1)[0].y, previous.y + 18);
    engine.setObjectAnchorsEnabled(false);
    assert.deepEqual(samples.at(-1), []);
    const count = samples.length;
    dragMap(canvas, 10, 10);
    assert.equal(samples.length, count, "disabling a completed overlay stops subsequent camera notifications");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("overlapping phone marker targets resolve the nearest available anchor rather than DOM stacking", async () => {
  const fire = { id: "test-fire", position: { x: 700, y: 650 }, seat: { x: 720, y: 680 }, radius: 10 };
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome], campfires: [fire] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(390), places = [], selections = [];
    const marker = id => {
      const events = new Map();
      return { dataset: { objectId: id }, style: {}, events,
        addEventListener: (name, callback) => events.set(name, callback),
        removeEventListener: name => events.delete(name) };
    };
    const houseMarker = marker("home"), fireMarker = marker(fire.id);
    const loading = createMapEngine(canvas, options, place => places.push(place), [houseMarker, fireMarker], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const project = point => {
      const projection = mapProjection(canvas);
      return { x: projection.left + point.x * projection.zoom, y: projection.top + point.y * projection.zoom };
    };
    const pointerTap = (node, point) => {
      const event = { pointerId: 1, pointerType: "touch", button: 0, clientX: point.x, clientY: point.y };
      (node?.events ?? canvas.events).get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    const homePoint = project(clearingHome.anchor), firePoint = project(fire.position);
    assert.ok(Math.abs(homePoint.x - firePoint.x) < 22 && homePoint.y === firePoint.y,
      "the last 44px DOM target covers the neighboring marker's center on this phone viewport");
    pointerTap(fireMarker, homePoint);
    assert.deepEqual(places, ["house"], "campfire DOM delivery at the house center chooses the house anchor");
    assert.equal(selections.at(-1).objectId, "home");
    pointerTap(houseMarker, firePoint);
    assert.deepEqual(places, ["house", "campfire"], "house DOM delivery at the campfire center chooses the fire anchor");
    assert.equal(selections.at(-1).objectId, fire.id);
    const middle = { x: (homePoint.x + firePoint.x) / 2, y: homePoint.y };
    pointerTap(fireMarker, { ...middle, x: middle.x - 1 });
    pointerTap(houseMarker, { ...middle, x: middle.x + 1 });
    assert.deepEqual(places, ["house", "campfire", "house", "campfire"],
      "each side of the midpoint resolves the physically nearer marker");

    const bodyPoint = project({ x: fixture.actor.spawn.x, y: fixture.actor.spawn.y - fixture.actor.size / 2 });
    assert.ok(Math.abs(bodyPoint.x - firePoint.x) < 22 && Math.abs(bodyPoint.y - firePoint.y) < 22,
      "the fire's large marker target physically overlaps the visible hero center");
    const beforeMarkerBodyTap = places.length;
    pointerTap(fireMarker, bodyPoint); pointerTap(houseMarker, bodyPoint);
    assert.equal(places.length, beforeMarkerBodyTap, "marker DOM delivery at the visible body still notices the hero before choosing an anchor");
    assert.equal(selections.at(-1), null, "body attention closes the previous object menu");
    assert.equal(env.timers.size, 1, "marker-origin body taps use one finite attention response");

    worldDevStore.patch({ showBuildings: false });
    assert.equal(houseMarker.style.visibility, "hidden");
    assert.equal(engine.activateObject("home"), false, "hidden buildings are unavailable even through their explicit ID");
    pointerTap(fireMarker, homePoint);
    assert.equal(places.at(-1), "campfire", "hidden house anchors cannot capture a nearby visible marker tap");
    const beforeBodyTap = places.length;
    pointerTap(null, project({ x: fixture.actor.spawn.x, y: fixture.actor.spawn.y - fixture.actor.size / 2 }));
    assert.equal(places.length, beforeBodyTap, "ordinary canvas body taps keep their visible-hero priority");
    assert.equal(env.timers.size, 1);
    pointerTap(null, project({ x: 675, y: 600 }));
    assert.equal(places.length, beforeBodyTap, "the hidden house's polygon does not gain a ghost map target");
    pointerTap(null, firePoint);
    assert.equal(places.at(-1), "campfire", "ordinary canvas taps still use the authored fire footprint");
    const beforeKeyboard = places.length;
    assert.equal(engine.activateObject(fire.id), true);
    assert.equal(places.length, beforeKeyboard + 1);
    assert.equal(places.at(-1), "campfire", "keyboard activation keeps the requested object ID explicit");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

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
    canvas.flushFrame();
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
      assert.deepEqual(sourceAndDestination(images.find(call => call.args[0] === ground).args).slice(1), [0, 0, 2560, 2560, 0, 0, 1800, 1800]);
      assert.deepEqual(sourceAndDestination(images.find(call => call.args[0] === shore).args).slice(1), [0, 0, 2560, 2560, 0, 1800, 600, 600]);
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

test("conditional bridge debris loads atomically with current obstacles in the main circle and world", async () => {
  const bridge = { id: "bridge", label: "Мост", bounds: { x: 700, y: 720, width: 40, height: 40 },
    anchor: { x: 720, y: 750 }, entry: { x: 720, y: 765 }, hitArea: [], collision: [], initialLevel: 0,
    states: [0, 1].map(level => ({ level, label: String(level), image: "/conditional-bridge.webp" })) };
  const debris = { id: "bridge-debris", image: "/conditional-beams.png", bounds: bridge.bounds, when: { siteId: "bridge", level: 0 } };
  const navigation = { ...livingNavigation, obstacles: [{ id: "debris-blocker", when: { siteId: "bridge", level: 0 },
    points: [{ x: 680, y: 640 }, { x: 700, y: 640 }, { x: 700, y: 660 }, { x: 680, y: 660 }] }] };
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD, previewWorldScene, isWalkable } =
    await modules({ sites: [bridge], navigation, terrain: [...fixture.terrain, debris] });
  const env = browser(), scenes = [], probes = [];
  try {
    worldDevStore.patch({ ...quietClearing, paused: true, autoLife: false, previewBuildings: true, levels: { bridge: 1 } });
    const initial = { ...options, presenceKey: "conditional-bridge-account" };
    let ready = 0;
    const callbacks = { activity() {}, ready: () => ready++, failure: assert.fail };
    scenes.push(mountHabitat(env.surface(), initial, callbacks));
    scenes.push(mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks));
    assert.deepEqual(env.requests, ["/test-ground.webp", "/conditional-bridge.webp"],
      "an intact bridge must not wait for its hidden debris image");
    env.finishPath("/test-ground.webp"); env.finishPath("/conditional-bridge.webp"); await flush();
    assert.equal(ready, 2, "both views become ready without loading beams");
    const current = level => {
      const probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { bridge: level }), "circle", 0, 0, () => {});
      probes.push(probe); return probe;
    };
    const intact = current(1), blockedPoint = { x: 690, y: 650 };
    assert.equal(isWalkable(intact.state.clearing.navigation, blockedPoint), true);
    let beams;
    const paintedDebris = scene => {
      const surface = env.surface(); scene.paintWorld(surface.context);
      return surface.calls.some(call => call.method === "drawImage" && call.args[0] === beams);
    };
    worldDevStore.patch({ levels: { bridge: 0 } });
    assert(env.pending.some(request => request.path === debris.image), "returning to ruins requests previously hidden terrain");
    for (const scene of scenes) assert.equal(paintedDebris(scene), false, "pending debris keeps the previous complete frame");
    assert.equal(isWalkable(intact.state.clearing.navigation, blockedPoint), true, "pending images cannot install the ruin blocker early");
    beams = env.finishPath(debris.image); await flush();
    for (const scene of scenes) assert.equal(paintedDebris(scene), true);
    const ruins = current(0);
    assert.notEqual(ruins.state, intact.state);
    assert.equal(isWalkable(ruins.state.clearing.navigation, blockedPoint), false, "committed ruins use the filtered current obstacles");
    worldDevStore.patch({ levels: { bridge: 1 } }); await flush();
    for (const scene of scenes) assert.equal(paintedDebris(scene), false);
    assert.equal(isWalkable(current(1).state.clearing.navigation, blockedPoint), true, "restoration removes the blocker from actual navigation");
    const requests = env.requests.length;
    worldDevStore.patch({ levels: { bridge: 0 } }); await flush();
    for (const scene of scenes) assert.equal(paintedDebris(scene), true);
    assert.equal(isWalkable(current(0).state.clearing.navigation, blockedPoint), false, "switching back reinstates the cached ruin navigation");
    assert.equal(env.requests.length, requests, "revisiting a complete scene reuses its already loaded artwork");
    assert.equal(TILED_WORLD.terrain.length, 2);
    assert.equal(TILED_WORLD.navigation.obstacles.length, 1, "level changes never rewrite authored conditions");
  } finally { probes.forEach(probe => probe.release()); scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});

test("building geometry switches with loaded art and both cameras share the new doorway and collision", async () => {
  const shift = offset => ({
    bounds: { ...clearingHome.bounds, x: clearingHome.bounds.x + offset },
    anchor: { ...clearingHome.anchor, x: clearingHome.anchor.x + offset },
    entry: { ...clearingHome.entry, x: clearingHome.entry.x + offset },
    doorway: { ...clearingHome.doorway, x: clearingHome.doorway.x + offset },
    hitArea: clearingHome.hitArea.map(point => ({ ...point, x: point.x + offset })),
    collision: clearingHome.collision.map(point => ({ ...point, x: point.x + offset })),
  });
  const site = { ...clearingHome, states: [1, 2, 3].map(level => ({ level, label: `Level ${level}`,
    image: `/moving-home-${level}.webp`, geometry: shift((level - 1) * 50) })) };
  const navigation = { ...livingNavigation, areas: [{ id: "clearing", points: [
    { x: 570, y: 610 }, { x: 780, y: 610 }, { x: 780, y: 735 }, { x: 570, y: 735 },
  ] }] };
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD, previewWorldScene, isWalkable } = await modules({ sites: [site], navigation });
  const env = browser(), scenes = [], probes = [];
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "moving-home-account" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    env.finish(); const first = env.finish(); await flush();
    const probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: 1 }), "circle", 0, 0, () => {}); probes.push(probe);
    const building = scene => {
      const surface = env.surface(); scene.paintWorld(surface.context);
      return surface.calls.findLast(call => call.method === "drawImage" && call.args[0] instanceof Image && call.args.length === 5).args;
    };
    worldDevStore.patch({ levels: { home: 2 } });
    assert.deepEqual(building(circle), [first, 620, 580, 80, 70], "pending artwork keeps its old bounds");
    const second = env.finishPath("/moving-home-2.webp"); await flush();
    const current = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: 2 }), "circle", 0, 0, () => {}); probes.push(current);
    assert.notEqual(current.state, probe.state, "old paths and residence cannot survive changed geometry");
    assert.equal(current.state.memory.enabled, false, "DEV geometry cannot persist a test residence");
    assert.deepEqual(current.state.clearing.interactions.home.entry, shift(50).entry);
    assert.equal(isWalkable(current.state.clearing.navigation, { x: 650, y: 630 }), true, "old collision is removed");
    assert.equal(isWalkable(current.state.clearing.navigation, { x: 700, y: 630 }), false, "new footprint blocks navigation");
    assert.deepEqual(building(circle), [second, 670, 580, 80, 70]);
    assert.deepEqual(building(world), building(circle));
    assert.equal(env.frames.size, 1, "the two cameras share one replacement simulation");
    worldDevStore.triggerLife("home-sleep");
    const clock = sceneClock(env);
    clock.until(() => current.state.clearing.stage === "home-sleep", "the new entrance is reachable", 600);
    assert.deepEqual(circle.position(), { x: 700, y: 640 - fixture.actor.size / 2 });
    assert.deepEqual(world.position(), circle.position());
    const oldHit = circlePoint({ x: 630, y: 610 }), newHit = circlePoint({ x: 730, y: 610 });
    assert.equal(circle.hitPet(oldHit.x, oldHit.y), false);
    assert.equal(circle.hitPet(newHit.x, newHit.y), true, "sleeping house uses its new hit area");
    worldDevStore.patch({ levels: { home: 3 } }); env.finishPath("/moving-home-3.webp", true); await flush();
    assert.deepEqual(building(circle), [second, 670, 580, 80, 70], "failed art keeps the complete previous geometry");
    assert.equal(circle.hitPet(newHit.x, newHit.y), true);
    circle.notice();
    clock.until(() => current.state.clearing.stage !== "home-sleep", "the replacement resident can wake");
  } finally { probes.forEach(probe => probe.release()); scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
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

function sampleHero(scene, env, pixelSprite, withInteractionRig = false) {
  const target = env.surface();
  scene.paintWorld(target.context);
  const body = target.calls.findLast(call => call.method === "drawImage" && call.args.length === 5
    && call.args[0]?.width === 48 && call.args[0]?.height === 48 && !builderRigForHero.get(pixelSprite)?.(call.args[0]));
  return {
    body, calls: target.calls,
    hasPose(...poses) {
      const rigs = withInteractionRig
        ? [undefined, ...Array.from({ length: 7 }, (_, crouch) => ({ gardening: true, crouch }))]
        : [undefined];
      return Boolean(body) && poses.some(pose => ["front", "back", "left", "right"].some(direction =>
        [0, 1, 2, 3].some(frame => rigs.some(rig => body.args[0] === pixelSprite(pose, direction, frame, undefined, rig)))));
    },
  };
}

function sampleFishingHero(scene, env, loaded, state, world, still = false) {
  const frame = loaded.forestJourneyFishingFrame(state, world, still);
  assert.ok(frame, "the coastal job supplies a visible fishing frame");
  const rig = loaded.forestFishingHeroRig(frame, still);
  const sprite = loaded.pixelSprite(rig.pose, rig.bodyDirection, still ? 0 : frame.frame, undefined,
    { gardening: true, crouch: rig.crouch, lean: rig.lean, fishingStance: Boolean(frame.waterTarget) });
  const sample = sampleHero(scene, env, loaded.pixelSprite);
  assert.ok(sample.body, "the scene draws the coastal hero's body");
  assert.strictEqual(sample.body.args[0], sprite, "the visible body uses the exact current fishing stance and lean");
  assert.ok(sprite.calls.some(call => call.method === "fillRect" && call.args[2] > 0 && call.args[3] > 0),
    "the generated body contains opaque pixels");
  const [, left, top, width, height] = sample.body.args;
  assert.equal(width, frame.size, "the real actor retains its displayed size");
  assert.ok(height > 0);
  assert.ok(Math.abs(left + width / 2 - frame.x) < 1e-8, "the fishing body remains at the real actor's horizontal position");
  const contact = loaded.pixelSpriteContact(sprite);
  assert.ok(contact);
  assert.ok(Math.abs(top + contact.bottom / 48 * height - frame.y) < 1e-8,
    "the rendered soles remain on the real actor's ground position");
  // Match the known frame directly. Enumerating every crouch/lean combination
  // could evict the original canvas from the sprite's bounded LRU cache.
  return { ...sample, hasPose: (...poses) => poses.includes(rig.pose) };
}

function bushMask(sample, bush = clearingBush, afterBody = false) {
  if (afterBody && !sample.body) return false;
  const calls = afterBody ? sample.calls.slice(sample.calls.indexOf(sample.body) + 1) : sample.calls;
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
  // In this quiet, unlit fixture the actor's contact shadow precedes its sprite;
  // berry ellipses remain visible when the actor is fully concealed.
  return (sample.body ? sample.calls.slice(sample.calls.indexOf(sample.body) + 1) : sample.calls)
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
    assert.equal(probe.state.life.routine?.picked, true, `the visible requested interaction still picks its prop normally: ${JSON.stringify({
      routine: probe.state.life.routine, pendingLife: probe.state.pendingLife, reason: probe.state.director.reason,
      stage: probe.state.clearing.stage, lifeElapsed: probe.state.life.elapsed, stageElapsed: probe.state.clearing.stageElapsed,
      elapsed: probe.state.elapsed, frames: env.frames.size, seed: probe.state.clearing.seed,
    })}`);
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
    const clock = sceneClock(env), sample = () => sampleHero(scene, env, pixelSprite, true);
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

test("only visible inactivity sends the hero indoors and a house tap wakes him while opening its menu", async () => {
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

    const map = env.surface(400), places = [];
    engine = await createMapEngine(map, initial, place => places.push(place), []);
    engine.control("overview");
    const tap = { pointerId: 1, pointerType: "touch", button: 0,
      clientX: housePoint.x * 400 / fixture.width, clientY: housePoint.y * 400 / fixture.height };
    map.events.get("pointerdown")({ ...tap, type: "pointerdown" });
    map.events.get("pointerup")({ ...tap, type: "pointerup" });
    assert.deepEqual(places, ["house"], "the house tap opens its object menu while the resident sleeps");
    assert.equal(sample().body, undefined, "the resident exits through the door rather than appearing instantly");
    engine.dispose(); engine = null;
    clock.until(() => Boolean(sample().body), "the house tap alone starts the resident's exit", 100);
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
    const homeTouch = circlePoint({ x: 675, y: 610 });
    assert.equal(circle.hitPet(homeTouch.x, homeTouch.y), true, "the home in the circle remains a reachable wake target");
    circle.notice();
    clock.until(() => Boolean(sampleHero(circle, env, pixelSprite).body), "tapping the circle brings its resident outside", 100);
    clock.advance(4);
    assert.equal(sampleHero(circle, env, pixelSprite).hasPose("sleep"), false);
  } finally { scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});

test("a home marker wakes its sleeping resident once, while camera movement and canceled gestures leave him asleep", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "home-marker-wake" };
    const canvas = env.surface(400), places = [], marker = Object.assign(env.surface(), {
      dataset: { objectId: "home", kind: "house" }, style: {},
    });
    const loading = createMapEngine(canvas, initial, place => places.push(place), [marker]);
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerLife("home-sleep");
    clock.until(() => probe.state.clearing.stage === "home-sleep", "the resident sleeps behind the home artwork", 600);
    engine.control("home"); engine.setSelectedObject("home");
    dragMap(canvas, 15, -10);
    assert.equal(probe.state.clearing.stage, "home-sleep", "camera controls, selection tracking and pan cannot wake the resident");
    const event = (pointerId = 1) => {
      const projection = mapProjection(canvas);
      return { pointerId, pointerType: "touch", button: 0,
        clientX: projection.left + clearingHome.anchor.x * projection.zoom,
        clientY: projection.top + clearingHome.anchor.y * projection.zoom };
    };
    let touch = event();
    marker.events.get("pointerdown")({ ...touch, type: "pointerdown" });
    marker.events.get("pointermove")({ ...touch, type: "pointermove", clientX: touch.clientX + 20 });
    marker.events.get("pointerup")({ ...touch, type: "pointerup", clientX: touch.clientX + 20 });
    canvas.flushFrame();
    touch = event();
    marker.events.get("pointerdown")({ ...touch, type: "pointerdown" });
    marker.events.get("pointercancel")({ ...touch, type: "pointercancel" });
    const second = { ...touch, pointerId: 2, clientX: touch.clientX + 40 };
    marker.events.get("pointerdown")({ ...touch, type: "pointerdown" });
    canvas.events.get("pointerdown")({ ...second, type: "pointerdown" });
    marker.events.get("pointerup")({ ...touch, type: "pointerup" });
    canvas.events.get("pointerup")({ ...second, type: "pointerup" });
    assert.equal(probe.state.clearing.stage, "home-sleep", "marker drag, cancellation and pinch cannot wake him");
    assert.deepEqual(places, []);
    touch = event();
    marker.events.get("pointerdown")({ ...touch, type: "pointerdown" });
    marker.events.get("pointerup")({ ...touch, type: "pointerup" });
    marker.events.get("lostpointercapture")({ ...touch, type: "lostpointercapture" });
    assert.deepEqual(places, ["house"], "the same deliberate tap opens the building exactly once");
    assert.equal(probe.state.clearing.stage, "exiting");
    clock.step();
    const progress = probe.state.clearing.doorProgress;
    engine.activateObject("home");
    assert.equal(probe.state.clearing.doorProgress, progress, "another activation cannot restart the exit");
    clock.until(() => probe.state.clearing.routeKind !== "home", "the resident finishes leaving the house", 600);
    const stage = probe.state.clearing.stage;
    engine.activateObject("home");
    assert.equal(probe.state.clearing.stage, stage, "an ordinary house menu does not interrupt an outdoor resident");
    assert.deepEqual(places, ["house", "house", "house"]);
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("home waking interrupts entry, respects hidden heroes, and supports a still circle without teleporting on ordinary menu reads", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "home-entry-wake" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "world", 0, 0, () => {});
    const clock = sceneClock(env);
    assert.equal(scene.wakeHomeResident(), false, "opening a home while its resident is outdoors has no attention side effect");
    worldDevStore.triggerLife("home-sleep");
    clock.until(() => probe.state.clearing.stage === "entering", "the resident starts crossing the doorway", 600);
    const entering = scene.position();
    assert.equal(scene.wakeHomeResident(), true);
    assert.equal(probe.state.clearing.stage, "exiting");
    assert.deepEqual(scene.position(), entering, "an interrupted entry reverses at its current position");
    clock.until(() => probe.state.clearing.routeKind !== "home", "the interrupted entry returns outside", 600);
    worldDevStore.triggerLife("home-sleep");
    clock.until(() => probe.state.clearing.stage === "home-sleep", "the resident can later sleep normally", 600);
    worldDevStore.patch({ showHero: false });
    assert.equal(scene.wakeHomeResident(), false);
    assert.equal(probe.state.clearing.stage, "home-sleep", "a hidden DEV hero is not moved by the building API");
    worldDevStore.patch({ showHero: true });
    scene.configure({ ...initial, reducedMotion: true });
    assert.equal(scene.wakeHomeResident(), true);
    assert.notEqual(probe.state.clearing.stage, "home-sleep", "reduced motion still brings the resident outside");
    assert.equal(scene.wakeHomeResident(), false, "an already-awake resident cannot restart a static response");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
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

test("a separate bush cutout moves to the foreground once without repainting the ground polygon", async () => {
  const { paintNewMap, worldDevStore } = await modules();
  const env = browser();
  try {
    const cutout = { id: "bush-cutout", image: "/test-bush.webp", bounds: { x: 565, y: 585, width: 80, height: 80 } };
    const bush = { ...clearingBush, imageId: cutout.id };
    const map = { ...fixture, terrain: [...fixture.terrain, cutout], bushes: [bush] };
    const groundImage = new Image(), bushImage = new Image();
    const images = new Map([[fixture.terrain[0].image, groundImage], [cutout.image, bushImage]]);
    for (const [label, bushFrame, reducedMotion, showHero, foreground, misplaced = false] of [
      ["idle", undefined, false, true, false],
      ["enter", { id: bush.id, occlude: true, rustle: 0 }, false, true, true],
      ["rustle", { id: bush.id, occlude: false, rustle: .8, elapsed: .5 }, false, true, false],
      ["still without encounter clock", { id: bush.id, occlude: false, rustle: .8 }, true, true, false],
      ["frozen encounter", { id: bush.id, occlude: true, rustle: .8, elapsed: .5 }, true, true, true],
      ["hidden hero", { id: bush.id, occlude: true, rustle: .8 }, false, false, false],
      ["misplaced image", { id: bush.id, occlude: true, rustle: .8 }, false, true, false, true],
    ]) {
      const surface = env.surface();
      paintNewMap(surface.context, images, { ...options, reducedMotion }, 20, false, 0, 0, {
        scene: misplaced ? { ...map, bushes: [{ ...bush, points: bush.points.map(point => ({ x: point.x + 100, y: point.y })) }] } : map,
        state: { ...worldDevStore.getSnapshot(), ...quietClearing, showHero, reducedMotion: reducedMotion ? "on" : "off" },
        clearing: { ...fixture.actor.spawn, pose: "idle", frame: 0, direction: "front", opacity: 1, bush: bushFrame },
      });
      const calls = surface.calls;
      const bodyIndex = calls.findIndex(call => call.method === "drawImage" && call.args.length === 5
        && call.args[0]?.width === 48 && call.args[0]?.height === 48);
      const groundDraws = calls.filter(call => call.method === "drawImage" && call.args[0] === groundImage);
      const bushDraws = calls.filter(call => call.method === "drawImage" && call.args[0] === bushImage);
      assert.equal(groundDraws.length, 1, `${label}: soil and actor are never erased by a second terrain crop`);
      assert.ok(bushDraws.length > 0, `${label}: the cutout remains visible`);
      if (foreground) {
        assert.ok(bodyIndex >= 0);
        assert.ok(bushDraws.every(call => calls.indexOf(call) > bodyIndex), `${label}: no static duplicate behind the moving leaves`);
      } else {
        if (label !== "rustle") assert.equal(bushDraws.length, 1, `${label}: the idle cutout belongs to the terrain pass`);
        if (showHero) assert.ok(bushDraws.every(call => calls.indexOf(call) < bodyIndex), `${label}: leaves stay behind the visible body`);
      }
    }
  } finally { worldDevStore.reset(); env.restore(); }
});

test("an interrupted basket stays in the paws during attention and a held DEV pose", async () => {
  const { paintNewMap, worldDevStore } = await modules();
  const env = browser();
  try {
    const foot = fixture.actor.spawn, images = new Map([[fixture.terrain[0].image, new Image()]]);
    const life = { mushrooms: [], campfires: [], routine: null, garden: { elapsed: 0, bushes: [], routine: null,
      basket: { position: { x: 700, y: 700 }, homePosition: { x: 700, y: 700 }, size: 14, berries: 3, capacity: 12, held: true } } };
    const before = JSON.stringify(life);
    for (const [reacting, pose] of [[false, "auto"], [true, "auto"], [false, "greet"]]) {
      const surface = env.surface();
      paintNewMap(surface.context, images, { ...options, reducedMotion: false }, 20, reacting, 0, 0, {
        scene: fixture, life, state: { ...worldDevStore.getSnapshot(), ...quietClearing, pose },
        clearing: { ...foot, pose: "idle", frame: 0, direction: "front", opacity: 1 },
      });
      const baskets = surface.calls.filter(call => call.method === "fillRect" && JSON.stringify(call.args) === "[-7,-8,14,7]");
      assert.equal(baskets.length, 1, "occupied paws retain exactly one basket instead of losing it during attention");
      assert.ok(surface.calls.some(call => call.method === "translate" && call.args[0] === foot.x && call.args[1] < foot.y),
        "the carried basket stays with the actor, not its old parking spot");
      assert.equal(JSON.stringify(life), before, "painting cannot place or consume the held basket");
    }
  } finally { worldDevStore.reset(); env.restore(); }
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
      assert.equal(Boolean(sample.body), frame.opacity > 0, `${probe.state.clearing.stage}: body drawing follows its physical visibility`);
      if (probe.state.clearing.stage !== "home") {
        assert.equal(frame.bush?.occlude, frame.opacity === 0, `${probe.state.clearing.stage}: a route cannot cover an actor that is still in front`);
      }
      if (probe.state.clearing.stage === "bush-hidden") {
        hidden = true;
        assert.equal(frame.opacity, 0, "the tucked actor is fully concealed inside the leaves");
      }
      if (frame.bush?.occlude) {
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

test("an occupied garden tap opens its menu and explicit attention starts a continuous exit", async () => {
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
    assert.equal(bushMask(sampleHero(scene, env, pixelSprite), clearingBush, true), false,
      "the approach cannot place the entire crown above the character");
    assert.equal(scene.hitPet(touch.x, touch.y), false, "an approach mask does not make the still-empty bush an occupied touch target");
    clock.until(() => probe.state.clearing.stage === "bush-prepare", "the visible resident prepares beside the bush", 200);
    const preparing = circlePoint(scene.position());
    assert.equal(scene.hitVisiblePet(preparing.x, preparing.y), true,
      "the body remains reachable for interruption during preparation");
    clock.until(() => probe.state.clearing.stage === "bush-hidden", "the character enters the actual bush", 200);
    const hiddenSample = sampleHero(scene, env, pixelSprite);
    assert.equal(hiddenSample.body, undefined);
    assert.ok(bushMask(hiddenSample), "the leaves remain visible without a concealed body draw");
    assert.equal(scene.hitPet(touch.x, touch.y), true, "the authored foliage makes its hidden resident reachable");
    const hiddenBody = scene.position(), hiddenBodyTouch = circlePoint(hiddenBody);
    assert.equal(scene.hitVisiblePet(hiddenBodyTouch.x, hiddenBodyTouch.y), false,
      "body coordinates covered by the authored foliage do not become a visible hero target");
    const map = env.surface(400), places = [];
    engine = await createMapEngine(map, initial, place => places.push(place), []);
    engine.control("overview");
    const point = hiddenBody, event = { pointerId: 1, pointerType: "touch", button: 0,
      clientX: point.x * 400 / fixture.width, clientY: point.y * 400 / fixture.height };
    map.events.get("pointerdown")({ ...event, type: "pointerdown" });
    map.events.get("pointerup")({ ...event, type: "pointerup" });
    assert.deepEqual(places, ["garden"], "authored garden geometry opens the same menu even with a hidden resident");
    assert.equal(probe.state.clearing.stage, "bush-hidden", "opening the garden menu preserves the resident's activity");
    engine.notice();
    assert.equal(probe.state.clearing.stage, "bush-exit", "explicit attention wakes the hidden resident");
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
    assert.equal(circleSample.body, undefined); assert.equal(worldSample.body, undefined);
    assert.ok(bushMask(circleSample)); assert.ok(bushMask(worldSample));
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
      assert.ok(bushMask(stillSample), `${mode} keeps the foliage visible`);
      assert.equal(stillSample.body, undefined, `${mode} keeps the actor fully concealed`);
      assert.deepEqual(bushParticleDraws(stillSample), bushParticleDraws(frozenSample), `${mode} freezes the falling berries`);
      assert.equal(frozenSample.body, undefined);
      world.configure({ ...initial, view: "world" }); clock.step();
    }
    const beforeReturn = structuredClone(probe.state.clearing);
    world.dispose(); circle.configure(initial); await flush();
    assert.deepEqual(probe.state.clearing, beforeReturn);
    const resumed = sampleHero(circle, env, pixelSprite);
    assert.equal(resumed.body, undefined); assert.ok(bushMask(resumed));
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
    assert.deepEqual(glowFrame(), [], "daylight hides the nocturnal population entirely");
    worldDevStore.patch({ fireflies: "on" });
    assert.deepEqual(glowFrame(), [], "DEV on cannot show nocturnal insects during the day");
    worldDevStore.patch({ timeOfDay: "night" });
    assert.equal(glowFrame().length, 3); assert.ok(glowFrame().every(alpha => alpha > 0), "a frozen frame reflects the current night immediately");
    assert.deepEqual(probe.state.fauna, frozen); assert.equal(env.frames.size, 0);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("saved house progression selects both cameras, preserves memory and commits new geometry only with its artwork", async () => {
  const geometry = offset => ({
    bounds: { ...clearingHome.bounds, x: clearingHome.bounds.x + offset },
    anchor: { ...clearingHome.anchor, x: clearingHome.anchor.x + offset },
    entry: { ...clearingHome.entry, x: clearingHome.entry.x + offset },
    doorway: { ...clearingHome.doorway, x: clearingHome.doorway.x + offset },
    collision: clearingHome.collision.map(point => ({ ...point, x: point.x + offset })),
    hitArea: clearingHome.hitArea.map(point => ({ ...point, x: point.x + offset })),
  });
  const site = { ...clearingHome, initialLevel: 2, states: [1, 2].map(level => ({ level,
    label: `Level ${level}`, image: `/account-home-${level}.webp`, geometry: geometry((level - 1) * 50) })) };
  const navigation = { ...livingNavigation, areas: [{ id: "clearing", points: [
    { x: 570, y: 610 }, { x: 780, y: 610 }, { x: 780, y: 735 }, { x: 570, y: 735 },
  ] }] };
  const { mountHabitat, connectForestSession, previewWorldScene, TILED_WORLD, worldDevStore } = await modules({ sites: [site], navigation });
  const env = browser(), scenes = [], probes = [], saved = new Map();
  window.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  try {
    const initial = { ...options, presenceKey: "progression-scene", worldState: { houseLevel: 1 } };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    assert.deepEqual(env.requests, ["/test-ground.webp", "/account-home-1.webp"], "authored preview level cannot override the account");
    env.finish(); const first = env.finish(); await flush();
    const probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: 1 }), "circle", 0, 0, () => {}); probes.push(probe);
    assert.equal(probe.state.memory.enabled, true);
    probe.state.clearing.behavior.mind.needs.energy = .42;
    const building = scene => {
      const surface = env.surface(); scene.paintWorld(surface.context);
      return surface.calls.findLast(call => call.method === "drawImage" && call.args[0] instanceof Image && call.args.length === 5).args;
    };
    const upgraded = { ...initial, worldState: { houseLevel: 2 } };
    circle.configure(upgraded); world.configure({ ...upgraded, view: "world" });
    assert.deepEqual(building(circle), [first, 620, 580, 80, 70], "an in-flight replacement never reveals unready geometry");
    assert.equal(probe.state.clearing.interactions.home.entry.x, 650);
    const second = env.finishPath("/account-home-2.webp"); await flush();
    const current = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: 2 }), "circle", 0, 0, () => {}); probes.push(current);
    assert.equal(current.state.memory.enabled, true, "a legitimate upgrade keeps memory saving enabled");
    assert.equal(current.state.clearing.behavior.mind.needs.energy, .42, "geometry reconciliation preserves needs");
    assert.equal(current.state.clearing.interactions.home.entry.x, 700);
    assert.deepEqual(building(circle), [second, 670, 580, 80, 70]);
    assert.deepEqual(building(world), building(circle));
    worldDevStore.patch({ previewBuildings: true, levels: { home: 1 } }); await flush();
    assert.deepEqual(building(circle), [first, 620, 580, 80, 70], "an explicit preview overrides saved progression");
    worldDevStore.reset(); await flush();
    assert.deepEqual(building(circle), [second, 670, 580, 80, 70], "DEV reset returns to the saved account level");
  } finally { scenes.forEach(scene => scene.dispose()); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});

test("account house levels fall back to available art and explicit DEV can preview the authored initial level", async () => {
  const site = { ...clearingHome, states: [1, 3, 5].map(level => ({ level, label: `Level ${level}`, image: `/fallback-${level}.png` })) };
  const { accountSceneLevels, TILED_WORLD, WORLD_DEV_DEFAULTS } = await modules({ sites: [site] });
  assert.equal(accountSceneLevels(TILED_WORLD, 4, WORLD_DEV_DEFAULTS).home, 3);
  assert.equal(accountSceneLevels(TILED_WORLD, 99, WORLD_DEV_DEFAULTS).home, 5);
  for (const invalid of [NaN, Infinity, -1, 1.5, undefined]) assert.equal(accountSceneLevels(TILED_WORLD, invalid).home, 1);
  assert.equal(accountSceneLevels(TILED_WORLD, 5, { ...WORLD_DEV_DEFAULTS, previewBuildings: true }).home, 1);
});

function productionSite(id, y, available = [0, 1, 2]) {
  const states = available.map(level => {
    const x = 400 + level * 120;
    return { level, label: `${id} ${level}`, image: `/account-${id}-${level}.webp`, geometry: {
      bounds: { x, y, width: 80, height: 70 }, anchor: { x: x + 40, y: y + 70 }, entry: { x: x + 40, y: y + 90 },
      hitArea: [{ x, y }, { x: x + 80, y }, { x: x + 80, y: y + 70 }, { x, y: y + 70 }],
      collision: [{ x: x + 10, y: y + 35 }, { x: x + 70, y: y + 35 }, { x: x + 70, y: y + 70 }, { x: x + 10, y: y + 70 }],
    } };
  });
  return { id, label: id, initialLevel: 1, ...states[0].geometry, states };
}

test("confirmed economy levels include ruins, keep missing buildings authored and preserve home and DEV fallbacks", async () => {
  const sites = [clearingHome, productionSite("workshop", 380), productionSite("quarry", 800, [0, 1]), productionSite("lighthouse", 100)];
  const { accountSceneLevels, TILED_WORLD, WORLD_DEV_DEFAULTS } = await modules({ sites });
  const authored = { home: 1, workshop: 1, quarry: 1, lighthouse: 1 };
  assert.deepEqual(accountSceneLevels(TILED_WORLD, undefined, WORLD_DEV_DEFAULTS), authored);
  for (const level of [0, 1, 2, 5]) {
    const selected = accountSceneLevels(TILED_WORLD, 1, WORLD_DEV_DEFAULTS, { workshop: level, quarry: level, unplaced: 5 });
    assert.deepEqual(selected, { ...authored, workshop: Math.min(level, 2), quarry: Math.min(level, 1) });
  }
  for (const invalid of [NaN, Infinity, -1, 1.5, undefined]) {
    assert.deepEqual(accountSceneLevels(TILED_WORLD, 1, WORLD_DEV_DEFAULTS, { workshop: invalid, quarry: invalid }), authored);
  }
  const home = { ...clearingHome, states: [1, 3, 5].map(level => ({ level, label: `Home ${level}`, image: `/fallback-home-${level}.webp` })) };
  const scene = { ...TILED_WORLD, sites: [home, ...sites.slice(1)] };
  assert.equal(accountSceneLevels(scene, 3, WORLD_DEV_DEFAULTS, null).home, 3, "legacy house remains usable while economy is loading");
  assert.equal(accountSceneLevels(scene, 3, WORLD_DEV_DEFAULTS, { home: 5 }).home, 5, "confirmed economy wins over an older legacy snapshot");
  assert.equal(accountSceneLevels(scene, 3, WORLD_DEV_DEFAULTS, { home: 0 }).home, 1, "missing lower artwork keeps the earliest authored home");
  const economy = { home: 5, workshop: 2, quarry: 0 };
  assert.deepEqual(accountSceneLevels(scene, 3, { ...WORLD_DEV_DEFAULTS, previewBuildings: true }, economy), authored,
    "explicit DEV can preview initial levels even when they differ from confirmed progression");
  assert.deepEqual(accountSceneLevels(scene, 3, { ...WORLD_DEV_DEFAULTS, levels: { ...authored, workshop: 0 } }, economy),
    { ...authored, workshop: 0 }, "existing implicit DEV level selection retains priority");
  assert.deepEqual(accountSceneLevels(scene, 3, WORLD_DEV_DEFAULTS, { lighthouse: 2 }), { ...authored, home: 3, lighthouse: 2 },
    "the same rule supports a future confirmed building without inventing an economy for it");
});

test("confirmed production levels switch artwork and collision together in both views, preserving progress on load failure", async () => {
  const sites = [productionSite("workshop", 380), productionSite("quarry", 800, [0, 1])];
  const navigation = { ...livingNavigation, areas: [{ id: "production-clearing", points: [
    { x: 300, y: 200 }, { x: 1100, y: 200 }, { x: 1100, y: 1050 }, { x: 300, y: 1050 },
  ] }] };
  const { mountHabitat, connectForestSession, previewWorldScene, TILED_WORLD, worldDevStore, isWalkable } = await modules({ sites, navigation });
  const env = browser(), scenes = [], probes = [], images = new Map(), saved = new Map();
  window.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  try {
    const initial = { ...options, presenceKey: "production-account", economyBuildings: { workshop: 0, quarry: 0 } };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    const finish = (id, level, error = false) => {
      const path = `/account-${id}-${level}.webp`, image = env.finishPath(path, error);
      if (!error) images.set(path, image);
    };
    env.finishPath("/test-ground.webp"); finish("workshop", 0); finish("quarry", 0); await flush();
    const rendered = (scene, id) => {
      const surface = env.surface(); scene.paintWorld(surface.context);
      return surface.calls.filter(call => call.method === "drawImage" && call.args.length === 5)
        .find(call => [...images].some(([path, image]) => path.startsWith(`/account-${id}-`) && call.args[0] === image))?.args;
    };
    const check = (id, level) => {
      const geometry = sites.find(site => site.id === id).states.find(state => state.level === level).geometry;
      for (const scene of scenes) {
        assert.deepEqual(rendered(scene, id), [images.get(`/account-${id}-${level}.webp`), geometry.bounds.x, geometry.bounds.y, 80, 70]);
        assert.deepEqual(scene.siteAnchor(id), geometry.anchor);
        assert.equal(scene.hitSite({ x: geometry.bounds.x + 40, y: geometry.bounds.y + 20 }), id);
      }
    };
    check("workshop", 0); check("quarry", 0);
    const initialProbe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, initial.economyBuildings), "circle", 0, 0, () => {}); probes.push(initialProbe);
    initialProbe.state.clearing.behavior.mind.needs.energy = .42;
    const configure = buildings => {
      circle.configure({ ...initial, economyBuildings: buildings });
      world.configure({ ...initial, view: "world", economyBuildings: buildings });
    };
    configure({ workshop: 1, quarry: 1 });
    finish("workshop", 1); await flush();
    check("workshop", 0); check("quarry", 0);
    finish("quarry", 1); await flush();
    check("workshop", 1); check("quarry", 1);
    const current = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { workshop: 1, quarry: 1 }), "circle", 0, 0, () => {}); probes.push(current);
    assert.equal(current.state.memory.enabled, true, "confirmed production changes preserve account memory");
    assert.equal(current.state.clearing.behavior.mind.needs.energy, .42);
    assert.equal(isWalkable(current.state.clearing.navigation, { x: 440, y: 430 }), true, "the old workshop footprint is released");
    assert.equal(isWalkable(current.state.clearing.navigation, { x: 560, y: 430 }), false, "the confirmed workshop footprint blocks navigation");
    configure({ workshop: 2, quarry: 5 });
    finish("workshop", 2, true); await flush();
    check("workshop", 1); check("quarry", 1);
    assert.ok(worldDevStore.getSnapshot().artError);
    configure({ workshop: 2, quarry: 5 });
    finish("workshop", 2); await flush();
    check("workshop", 2); check("quarry", 1);
    const requests = env.requests.length;
    configure({ workshop: 5, quarry: 5 }); await flush();
    check("workshop", 2); check("quarry", 1);
    assert.equal(env.requests.length, requests, "higher confirmed levels never request unauthored artwork");
    worldDevStore.patch({ previewBuildings: true, levels: { workshop: 0, quarry: 0 } }); await flush();
    check("workshop", 0); check("quarry", 0);
    worldDevStore.reset(); await flush();
    check("workshop", 2); check("quarry", 1);
  } finally { scenes.forEach(scene => scene.dispose()); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});

test("map production clicks and accessible anchors follow only the loaded confirmed building level", async () => {
  const sites = [productionSite("workshop", 380), productionSite("quarry", 800, [0, 1])];
  const { createMapEngine } = await modules({ sites });
  const env = browser(); let engine;
  try {
    const canvas = env.surface(400), places = [], initial = { ...options, economyBuildings: { workshop: 0, quarry: 0 } };
    const anchors = sites.map(site => ({ dataset: { siteId: site.id, kind: site.id }, style: {} }));
    const loading = createMapEngine(canvas, initial, place => places.push(place), anchors);
    env.finish(); await flush(); env.finishPath("/account-workshop-0.webp"); env.finishPath("/account-quarry-0.webp"); engine = await loading;
    engine.control("overview");
    const tap = (x, y) => {
      const event = { pointerId: 1, pointerType: "mouse", button: 0, clientX: x * 400 / fixture.width, clientY: y * 400 / fixture.height };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    for (const site of sites) tap(440, site.bounds.y + 20);
    assert.deepEqual(places, ["workshop", "quarry"]);
    const previous = anchors.map(anchor => anchor.style.transform);
    engine.update({ ...initial, economyBuildings: { workshop: 1, quarry: 1 } });
    for (const site of sites) tap(560, site.bounds.y + 20);
    assert.equal(places.length, 2, "unloaded geometry cannot receive production clicks");
    assert.deepEqual(anchors.map(anchor => anchor.style.transform), previous);
    env.finishPath("/account-workshop-1.webp"); env.finishPath("/account-quarry-1.webp"); await flush();
    for (const site of sites) tap(440, site.bounds.y + 20);
    assert.equal(places.length, 2, "the old hit areas disappear after the confirmed replacement");
    for (const site of sites) tap(560, site.bounds.y + 20);
    assert.deepEqual(places, ["workshop", "quarry", "workshop", "quarry"]);
    anchors.forEach((anchor, index) => assert.notEqual(anchor.style.transform, previous[index]));
  } finally { engine?.dispose(); env.restore(); }
});

test("exploration hides the shared hero, releases carried props, advances ecology and returns on server time", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, pixelSprite, getForestObservation } = await modules({ habitats: livingHabitats });
  const env = browser(), scenes = [], saved = new Map(); let probe;
  window.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  try {
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "exploring-account" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const basket = { position: { x: 680, y: 700 }, approach: { x: 660, y: 700 }, homePosition: { x: 680, y: 700 },
      homeApproach: { x: 660, y: 700 }, size: 14, berries: 3, capacity: 12, held: true };
    probe.state.life.garden.basket = basket;
    const journey = { id: "exploration-1", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(160_000).toISOString(), label: "Разведка лесной тропы" };
    const travelling = { ...initial, economyJourney: journey };
    const before = circle.position(), lifeBefore = probe.state.life.elapsed;
    circle.configure(travelling);
    const world = mountHabitat(env.surface(), { ...travelling, view: "world" }, callbacks); scenes.push(world); await flush();
    const heroElapsed = probe.state.clearing.elapsed, needs = structuredClone(probe.state.clearing.behavior.mind.needs);
    assert.equal(basket.held, false, "the basket is placed beside the actual feet before departure");
    assert.equal(basket.berries, 3, "departure cannot lose delivered fruit");
    for (const scene of [circle, world]) {
      assert.equal(sampleHero(scene, env, pixelSprite).body, undefined);
      assert.equal(scene.hitPet(.5, .5), false); scene.notice();
    }
    const clock = sceneClock(env); clock.advance(2);
    assert.equal(probe.state.reaction, 0, "tapping cannot spawn a second hero on the clearing");
    assert.equal(probe.state.clearing.elapsed, heroElapsed, "autonomous hero actions stay paused");
    assert.deepEqual(probe.state.clearing.behavior.mind.needs, needs);
    assert.deepEqual(circle.position(), before, "departure never writes an imaginary off-map position");
    assert.ok(probe.state.life.elapsed > lifeBefore, "mushrooms and forest ecology keep their clock");
    assert.ok(probe.state.fauna.elapsed > 0);
    assert.equal(probe.state.memory.enabled, true, "exploration is not a DEV memory override");
    assert.equal(getForestObservation(initial.presenceKey).activity, "В исследовании");
    probe.saveMemory();
    assert.equal([...saved.values()].some(value => value.includes("exploration-1")), false, "the cosmetic snapshot cannot own an economic job");
    world.configure({ ...travelling, view: "world", reducedMotion: true });
    circle.configure({ ...travelling, backgrounded: true });
    world.setTime(160_000);
    assert.ok(sampleHero(world, env, pixelSprite).body, "server completion returns the hero even without animation frames or a reward claim");
    assert.equal(probe.state.explorationId, null);
    assert.equal(probe.state.clearing.idleSeconds, 0);
    assert.equal(basket.berries, 3);
  } finally { scenes.forEach(scene => scene.dispose()); probe?.release(); env.restore(); }
});

test("exploration server clock corrects backwards independently of the monotonic forest clock", async () => {
  const { mountHabitat, pixelSprite } = await modules();
  const env = browser(); let scene;
  try {
    const journey = { id: "corrected-clock", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(160_000).toISOString() };
    const initial = { ...options, serverNow: 1_000_000, economyJourney: journey };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    assert.ok(sampleHero(scene, env, pixelSprite).body, "initial inaccurate client time is ahead of the deadline");
    scene.setTime(110_000);
    assert.equal(sampleHero(scene, env, pixelSprite).body, undefined, "a server sample behind client time restores the real active exploration");
    scene.configure(initial);
    assert.equal(sampleHero(scene, env, pixelSprite).body, undefined, "visibility/configuration with an old sample cannot replace the newer server clock");
    scene.setTime(160_000);
    assert.ok(sampleHero(scene, env, pixelSprite).body, "authoritative completion returns the hero in reduced motion");
    scene.configure({ ...initial, serverNow: 120_000 });
    assert.equal(sampleHero(scene, env, pixelSprite).body, undefined, "configure also accepts a fresh authoritative correction");
  } finally { scene?.dispose(); env.restore(); }
});

test("map selection uses committed house geometry and home activation wakes a sleeping resident", async () => {
  const geometry = offset => ({
    bounds: { ...clearingHome.bounds, x: clearingHome.bounds.x + offset },
    anchor: { ...clearingHome.anchor, x: clearingHome.anchor.x + offset },
    entry: { ...clearingHome.entry, x: clearingHome.entry.x + offset },
    doorway: { ...clearingHome.doorway, x: clearingHome.doorway.x + offset },
    collision: clearingHome.collision.map(point => ({ ...point, x: point.x + offset })),
    hitArea: clearingHome.hitArea.map(point => ({ ...point, x: point.x + offset })),
  });
  const site = { ...clearingHome, states: [1, 2].map(level => ({ level, label: `Level ${level}`,
    image: `/click-home-${level}.webp`, geometry: geometry((level - 1) * 100) })) };
  const { createMapEngine, connectForestSession, previewWorldScene, TILED_WORLD, worldDevStore } = await modules({
    sites: [site], paths: [clearingHomePath],
  });
  const env = browser(); let engine, probe;
  try {
    const canvas = env.surface(400), places = [], selections = [], initial = { ...options, reducedMotion: false, presenceKey: "click-home", worldState: { houseLevel: 1 } };
    const anchor = { dataset: { objectId: "home", kind: "house" }, style: {} };
    const loading = createMapEngine(canvas, initial, place => places.push(place), [anchor], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/click-home-1.webp"); engine = await loading;
    engine.control("overview");
    const tap = (x, y) => {
      const event = { pointerId: 1, pointerType: "mouse", button: 0, clientX: x * 400 / fixture.width, clientY: y * 400 / fixture.height };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    tap(630, 600); assert.deepEqual(places, ["house"], "clicking the awake household opens construction");
    probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: 1 }), "circle", 0, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerLife("home-sleep");
    clock.until(() => probe.state.clearing.stage === "home-sleep", "the hero reaches the authored home", 600);
    tap(630, 600);
    assert.deepEqual(places, ["house", "house"], "the same target opens the house menu while its resident sleeps");
    assert.equal(probe.state.clearing.stage, "exiting", "house activation wakes the resident without blocking construction");
    clock.until(() => probe.state.clearing.routeKind !== "home", "waking finishes the real exit", 600);
    const previousAnchor = anchor.style.transform;
    const previousSelection = selections.at(-1), selectionCount = selections.length;
    engine.update({ ...initial, worldState: { houseLevel: 2 } });
    assert.equal(anchor.style.transform, previousAnchor, "pending art cannot move the accessible shortcut either");
    assert.deepEqual(selections.at(-1), previousSelection, "pending art preserves the selected object's committed anchor");
    assert.equal(selections.length, selectionCount, "waiting for new art cannot publish a speculative selection");
    tap(730, 600); assert.equal(places.length, 2, "pending artwork cannot expose the new hit area");
    engine.setSelectedObject("home");
    env.finishPath("/click-home-2.webp"); await flush();
    assert.equal(selections.at(-1).objectId, "home");
    assert.notEqual(selections.at(-1).x, previousSelection.x, "selection follows the new anchor as its image commits");
    tap(630, 600); canvas.flushFrame(); assert.equal(places.length, 2, "the old hit area disappears with old art");
    assert.notEqual(anchor.style.transform, previousAnchor, "the shortcut follows committed geometry");
    tap(730, 600); assert.deepEqual(places, ["house", "house", "house"]);
    worldDevStore.patch({ showBuildings: false }); tap(730, 600);
    assert.equal(places.length, 3, "hidden buildings have no ghost click target");
    assert.equal(selections.at(-1), null, "hiding a selected building closes its map selection");
    assert.equal(engine.activateObject("home"), false, "a hidden shortcut cannot activate a removed target");
    assert.equal(places.length, 3);
    assert.equal(anchor.style.visibility, "hidden");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("economic garden uses wall time in both cameras and emits one harvest fallback across handoff", async () => {
  const bushes = [{ id: "economic-bush", points: [{ x: 602, y: 617 }, { x: 642, y: 617 }, { x: 642, y: 647 }, { x: 602, y: 647 }],
    entry: { x: 591, y: 650 }, hide: { x: 622, y: 643 } }];
  const { mountHabitat, connectForestSession, TILED_WORLD } = await modules({ bushes, navigation: livingNavigation });
  const env = browser(), views = [], events = [];
  let probe;
  try {
    const end = Date.parse("2026-10-04T12:00:00Z");
    const crop = { jobId: "crop-scene", startedAt: new Date(end - 600000).toISOString(), finishesAt: new Date(end).toISOString() };
    const request = { requestId: 1, jobId: crop.jobId };
    const initial = { ...options, serverNow: end, presenceKey: "garden-controller-account", economyGarden: crop,
      gardenHarvestRequest: request, onGardenHarvestEvent: event => events.push(event) };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world);
    env.finishPath("/test-ground.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", end, 0, () => {});
    assert.equal(probe.state.life.garden.bushes[0].growth, 1);
    assert.equal(events.length, 1, "reduced motion emits once for the shared session");
    assert.equal(events[0].status, "unavailable");
    for (const view of views) view.paintWorld(env.surface().context);
    world.dispose(); await flush();
    circle.paintWorld(env.surface().context); await flush();
    assert.equal(events.length, 1, "camera handoff cannot restart the same request");
    circle.configure({ ...initial, serverNow: end - 300000, gardenHarvestRequest: null });
    assert.ok(Math.abs(probe.state.life.garden.bushes[0].growth - .49) < .0001, "a corrected server sample owns the displayed growth");
    circle.configure({ ...initial, economyGarden: null, gardenHarvestRequest: null });
    assert.equal(probe.state.life.garden.bushes[0].growth, 0, "claimed crop cannot survive as decorative berries");
  } finally { probe?.release(); views.forEach(view => view.dispose()); env.restore(); }
});

test("background garden snapshots cannot cancel the owner's delivery and a removed job stops pending work", async () => {
  const bushes = [{ id: "economic-bush", points: [{ x: 602, y: 617 }, { x: 642, y: 617 }, { x: 642, y: 647 }, { x: 602, y: 647 }],
    entry: { x: 591, y: 650 }, hide: { x: 622, y: 643 } }];
  const { mountHabitat, connectForestSession, TILED_WORLD } = await modules({ bushes, navigation: livingNavigation });
  const env = browser(), views = [], events = []; let probe;
  try {
    const end = Date.parse("2026-10-04T12:00:00Z");
    const crop = { jobId: "crop-live", startedAt: new Date(end - 600000).toISOString(), finishesAt: new Date(end).toISOString() };
    const initial = { ...options, reducedMotion: false, serverNow: end, presenceKey: "garden-live-handoff", economyGarden: crop,
      gardenHarvestRequest: { requestId: 1, jobId: crop.jobId }, onGardenHarvestEvent: event => events.push(event) };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finishPath("/test-ground.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", end, 0, () => {});
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.deepEqual(events.map(event => event.status), ["started"]);
    const garden = probe.state.life.garden;
    assert.equal(garden.harvest.phase, "pending");
    circle.configure({ ...initial, economyGarden: null, gardenHarvestRequest: null });
    circle.paintWorld(env.surface().context);
    assert.equal(garden.production.jobId, crop.jobId);
    assert.equal(garden.harvest.phase, "pending", "a background camera cannot invalidate its owner's accepted request");
    assert.equal(probe.state.pendingLife, "harvest-berries");
    // Simulate a persisted old/fallback routine whose transient request is gone.
    garden.harvest = null;
    garden.routine = { kind: "harvest-berries", bushId: "economic-bush", phase: "take-basket", elapsed: 0, totalElapsed: 1, carryingBasket: false };
    world.configure({ ...initial, view: "world", economyGarden: null, gardenHarvestRequest: null });
    assert.equal(garden.routine, null, "claim response must stop stale visual collection even without its request object");
    assert.equal(probe.state.pendingLife, null);
    assert.equal(garden.bushes[0].growth, 0);
    assert.ok(!events.some(event => event.status === "completed"));
  } finally { probe?.release(); views.forEach(view => view.dispose()); env.restore(); }
});

test("garden handoff waits through lease loading and confirmed lease refusal cancels visible work", async () => {
  const bushes = [{ id: "economic-bush", points: [{ x: 602, y: 617 }, { x: 642, y: 617 }, { x: 642, y: 647 }, { x: 602, y: 647 }],
    entry: { x: 591, y: 650 }, hide: { x: 622, y: 643 } }];
  const { mountHabitat, connectForestSession, TILED_WORLD } = await modules({ bushes, navigation: livingNavigation });
  const env = browser(), views = [], probes = [];
  try {
    for (const refused of [false, true]) {
      const timers = new Map(), events = []; let serial = 0, reads = 0, revision = 0, owned = false, delayedRead, savedSnapshot = null;
      const owner = refused ? "1234-ABCD-EFGJ" : "1234-ABCD-EFGH";
      const key = `zhiv:mochlik:presence:${owner}`, end = Date.parse("2026-10-04T12:00:00Z");
      const crop = { jobId: `crop-${owner}`, startedAt: new Date(end - 600000).toISOString(), finishesAt: new Date(end).toISOString() };
      const serverView = () => ({ ownerPublicId: owner, revision, snapshot: savedSnapshot, serverTime: new Date(end).toISOString(), updatedAt: null,
        lease: { owned: !refused && owned, token: !refused && owned ? "test-lease" : null,
          expiresAt: refused || owned ? new Date(end + 90_000).toISOString() : null } });
      const environment = { now: () => end, randomUUID: () => `00000000-0000-4000-8000-${(++serial).toString().padStart(12, "0")}`,
        setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
      const transport = { async read() {
        if (++reads > 1 && !refused) return new Promise(resolve => { delayedRead = resolve; });
        return serverView();
      }, async command(command) {
        if (command.action === "acquire") owned = true;
        if (command.action === "save") savedSnapshot = command.snapshot;
        if (command.action === "release") owned = false;
        revision++; return { state: serverView(), acceptedRevision: revision, replayed: false };
      } };
      const pump = async () => {
        for (let iteration = 0; iteration < 8; iteration++) {
          const next = [...timers].find(([, timer]) => timer.delay === 0);
          if (!next) break;
          timers.delete(next[0]); next[1].callback(); await flush();
        }
      };
      const probe = connectForestSession(key, TILED_WORLD, "circle", end, 0, () => {}, { sync: { environment, transport } }); probes.push(probe);
      if (refused) {
        probe.state.life.garden.production = crop;
        probe.state.life.garden.harvest = { request: { requestId: 1, jobId: crop.jobId }, phase: "running" };
        probe.state.life.garden.routine = { kind: "harvest-berries", bushId: "economic-bush", phase: "take-basket", elapsed: 0, totalElapsed: 1, carryingBasket: false };
      }
      const initial = { ...options, reducedMotion: false, serverNow: end, presenceKey: key, economyGarden: crop,
        gardenHarvestRequest: { requestId: 1, jobId: crop.jobId }, onGardenHarvestEvent: event => events.push(event) };
      const callbacks = { activity() {}, ready() {}, failure: assert.fail };
      const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
      if (!refused) env.finishPath("/test-ground.webp"); await flush();
      assert.deepEqual(events, [], "loading the lease cannot release an economic claim");
      await pump(); await flush();
      if (refused) {
        assert.equal(probe.state.memory.sync.mode, "other-device");
        assert.deepEqual(events.map(event => event.status), ["unavailable"]);
        assert.equal(probe.state.life.garden.routine, null, "real fallback cannot leave a basket pickup running");
        continue;
      }
      assert.deepEqual(events.map(event => event.status), ["started"]);
      const sameGarden = probe.state.life.garden, sameClearing = probe.state.clearing;
      const actualFeet = { ...sameClearing.position };
      circle.configure({ ...initial, backgrounded: true });
      const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
      assert.equal(probe.state.memory.sync.mode, "loading");
      assert.deepEqual(events.map(event => event.status), ["started"], "visible camera handoff is not an unavailable event");
      await pump();
      assert.equal(typeof delayedRead, "function");
      assert.ok(savedSnapshot, "handoff rereads a real saved forest snapshot");
      delayedRead(serverView()); await flush(); await pump(); await flush();
      assert.equal(probe.state.memory.sync.mode, "synced");
      assert.deepEqual(events.map(event => event.status), ["started"]);
      assert.equal(probe.state.life.garden, sameGarden, "same live lease preserves the actual delivery, not a restarted substitute");
      assert.equal(probe.state.clearing, sameClearing);
      assert.deepEqual(probe.state.clearing.position, actualFeet, "camera handoff never resets the feet");
      assert.equal(probe.state.life.garden.harvest.phase, "pending");
    }
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); env.restore(); }
});

const residentFixture = () => ({
  destinations: [{ id: "plesk-fishing", position: { x: 690, y: 700 }, pauseSeconds: 15 },
    { id: "plesk-trade", position: { x: 600, y: 700 }, pauseSeconds: 10 }],
  navigation: livingNavigation,
  water: { surfaces: [{ id: "river", points: [{ x: 703, y: 670 }, { x: 780, y: 670 },
    { x: 780, y: 760 }, { x: 703, y: 760 }] }], exclusions: [] },
  occluders: [],
});

const tradingFixture = () => ({
  ...residentFixture(),
  sites: [{ id: "plesk-shop", label: "Лавка Плёски", initialLevel: 1,
    bounds: { x: 575, y: 630, width: 50, height: 45 }, anchor: { x: 600, y: 665 }, entry: { x: 600, y: 690 },
    hitArea: [{ x: 575, y: 632 }, { x: 625, y: 632 }, { x: 625, y: 672 }, { x: 575, y: 672 }],
    collision: [{ x: 580, y: 655 }, { x: 619, y: 655 }, { x: 619, y: 669 }, { x: 580, y: 669 }],
    states: [{ level: 1, label: "Лавка", image: "/test-plesk-shop.webp" }] }],
  destinations: [{ id: "plesk-fishing", position: { x: 690, y: 700 }, pauseSeconds: 15 },
    { id: "plesk-trade", siteId: "plesk-shop", position: { x: 635, y: 680 }, pauseSeconds: 10 },
    { id: "plesk-customer", siteId: "plesk-shop", position: { x: 600, y: 690 }, pauseSeconds: 10 }],
});

test("stall taps open Plesk directly and queue one safe meeting, while camera gestures leave both actors alone", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(tradingFixture());
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "stall-meeting" };
    const canvas = env.surface(400), residents = [], selections = [];
    const loading = createMapEngine(canvas, initial, assert.fail, [], undefined, {}, {
      onResident: id => residents.push(id), onSelectionChange: value => selections.push(value),
    });
    env.finish(); await flush(); env.finishPath("/test-plesk-shop.webp"); engine = await loading;
    engine.control("overview");
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const mind = probe.state.pleskMind, original = structuredClone(mind), feet = { ...probe.state.clearing.position };
    const touch = () => { const projection = mapProjection(canvas); return { pointerId: 1, pointerType: "touch", button: 0,
      clientX: projection.left + 595 * projection.zoom, clientY: projection.top + 639 * projection.zoom }; };
    const send = (name, point) => canvas.events.get(name)({ ...point, type: name });
    let point = touch(); send("pointerdown", point); send("pointermove", { ...point, clientX: point.clientX + 30 });
    send("pointerup", { ...point, clientX: point.clientX + 30 }); engine.control("overview");
    point = touch(); send("pointerdown", point); send("pointercancel", point);
    const second = { ...point, pointerId: 2, clientX: point.clientX + 35 };
    send("pointerdown", point); send("pointerdown", second); send("pointermove", { ...second, clientX: second.clientX + 10 });
    send("pointerup", point); send("pointerup", { ...second, clientX: second.clientX + 10 }); engine.control("overview");
    assert.deepEqual(residents, []); assert.deepEqual(mind, original);
    assert.equal(probe.state.director.tradeVisit, null);

    point = touch(); send("pointerdown", point); send("pointerup", point);
    assert.deepEqual(residents, ["plesk"], "the existing shop opens immediately, without waiting for either actor");
    assert.ok(selections.every(value => value === null), "a merchant has no empty construction panel");
    assert.equal(mind.tradePending, true);
    assert.deepEqual(mind.position, original.position, "opening the shop never teleports the seller");
    assert.deepEqual(probe.state.clearing.position, feet);
    const visit = probe.state.director.tradeVisit;
    assert.equal(visit?.phase, "outbound");
    assert.equal(engine.activateObject("plesk-shop"), true, "keyboard activation uses the same shop interaction");
    assert.equal(probe.state.director.tradeVisit, visit, "repeated opens preserve the existing walk");
    assert.equal(probe.state.explorationId, null, "the visit is not an economic journey");
    const clock = sceneClock(env); clock.advance(.3);
    assert.notDeepEqual(probe.state.clearing.position, feet, "the free hero actually follows the requested route");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("a still or busy scene keeps the merchant accessible without starting a customer walk", async () => {
  for (const mode of ["reduced-motion", "busy"]) {
    const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(tradingFixture());
    const env = browser(); let engine, probe;
    try {
      worldDevStore.patch({ ...quietClearing, autoLife: false });
      const initial = { ...options, reducedMotion: mode === "reduced-motion", serverNow: 100_000, presenceKey: `stall-${mode}`,
        ...(mode === "busy" ? { economyJourney: { id: "cave-job", routeId: "cave", startedAt: new Date(100_000).toISOString(),
          finishesAt: new Date(700_000).toISOString() } } : {}) };
      const places = [], canvas = env.surface(320);
      const loading = createMapEngine(canvas, initial, place => places.push(place), []);
      env.finish(); await flush(); env.finishPath("/test-plesk-shop.webp"); engine = await loading;
      probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
      const feet = { ...probe.state.clearing.position };
      assert.equal(engine.activateObject("plesk-shop"), true);
      assert.deepEqual(places, ["plesk-shop"], "engines without a resident callback use the merchant place fallback");
      assert.equal(probe.state.director.tradeVisit, null);
      assert.deepEqual(probe.state.clearing.position, feet);
      if (mode === "reduced-motion") assert.equal(probe.state.pleskMind.tradePending, false);
      else assert.equal(probe.state.explorationId, "cave-job", "opening the merchant preserves the server-owned job");
      worldDevStore.patch({ showBuildings: false });
      assert.equal(engine.activateObject("plesk-shop"), false);
      assert.deepEqual(places, ["plesk-shop"], "hidden stall art cannot create an invisible click target");
    } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
  }
});

test("Plesk taps use world coordinates, respect foreground masks and never trigger the main hero", async () => {
  for (const mode of ["visible", "hidden", "equal-depth"]) {
    const hidden = mode === "hidden", overrides = residentFixture();
    const tapPoint = mode === "equal-depth" ? { x: 630, y: 642 } : { x: 690, y: 682 };
    if (mode === "equal-depth") overrides.destinations[0].position = { x: 630, y: 660 };
    if (hidden) overrides.occluders.push({ id: "crown", frontY: 720, points: [
      { x: 670, y: 650 }, { x: 710, y: 650 }, { x: 710, y: 715 }, { x: 670, y: 715 },
    ] });
    const { createMapEngine, worldDevStore } = await modules(overrides);
    const env = browser(); let engine;
    try {
      worldDevStore.patch(quietClearing);
      const canvas = env.surface(400), residents = [], places = [];
      const loading = createMapEngine(canvas, options, place => places.push(place), [], undefined, {},
        { onResident: id => residents.push(id) });
      env.finish(); await flush();
      assert.equal(env.pending.length, 0, "procedural residents need no downloaded artwork");
      engine = await loading; engine.control("overview");
      const projection = mapProjection(canvas), event = { pointerId: 1, pointerType: "touch", button: 0,
        clientX: projection.left + tapPoint.x * projection.zoom, clientY: projection.top + tapPoint.y * projection.zoom };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
      assert.deepEqual(residents, hidden ? [] : ["plesk"]);
      assert.deepEqual(places, []);
      assert.equal(env.timers.size, 0, "resident taps cannot start the main hero's response");
      assert.ok(canvas.calls.some(call => call.method === "drawImage" && call.args[0]?.width === 48), "the pixel rig reaches the renderer");
    } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
  }
});

test("procedural resident is ready with the terrain and has no external sprite dependency", async () => {
  const { mountHabitat } = await modules(residentFixture());
  const env = browser(); let scene;
  try {
    let ready = 0;
    scene = mountHabitat(env.surface(), options, { activity() {}, ready: () => ready++, failure: assert.fail });
    env.finish(); await flush();
    assert.equal(ready, 1); assert.equal(scene.hitResident(690, 682), "plesk");
    assert.deepEqual(env.requests, ["/test-ground.webp"]);
    const canvas = env.surface(); scene.paintWorld(canvas.context);
    assert.ok(canvas.calls.some(call => call.method === "drawImage" && call.args[0]?.width === 48));
  } finally { scene?.dispose(); env.restore(); }
});

const fishingFixture = () => ({
  navigation: livingNavigation,
  destinations: [{ id: "fishing", position: { x: 690, y: 700 }, pauseSeconds: 15 }],
  water: { surfaces: [{ id: "river", points: [{ x: 705, y: 660 }, { x: 800, y: 660 },
    { x: 800, y: 760 }, { x: 705, y: 760 }] }], exclusions: [] },
  occluders: [],
});

test("coastal jobs keep the real hero visible through walking, fishing, camera handoff and return", async () => {
  const loaded = await modules(fishingFixture());
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite } = loaded;
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "visible-fishing" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const home = { ...probe.state.clearing.position }, clock = sceneClock(env);
    const job = { id: "visible-shore-job", routeId: "shore", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
    const traveling = { ...initial, economyJourney: job };
    circle.configure(traveling);
    assert.equal(probe.state.journeyTravel.phase, "leaving");
    clock.until(() => probe.state.journeyTravel.phase === "fishing", "the real actor reaches the shore", 500);
    assert.deepEqual(probe.state.clearing.position, { x: 690, y: 700 });
    assert.ok(sampleHero(circle, env, pixelSprite).body, "arrival cannot make the main hero disappear");
    const touch = circlePoint(circle.position());
    assert.equal(circle.hitPet(touch.x, touch.y), true, "visible fishing body participates in hit depth");
    circle.notice(); assert.equal(probe.state.reaction, 0, "a tap cannot interrupt a confirmed job");
    const world = mountHabitat(env.surface(), { ...traveling, view: "world" }, callbacks); views.push(world); await flush();
    assert.equal(env.frames.size, 1, "both cameras share the same fisherman clock");
    const firstPaint = sampleFishingHero(world, env, loaded, probe.state, TILED_WORLD), feet = { ...probe.state.clearing.position };
    assert.ok(firstPaint.hasPose("fish"), "the main pixel body uses its articulated fishing rig");
    clock.advance(5);
    const waiting = sampleFishingHero(world, env, loaded, probe.state, TILED_WORLD);
    assert.ok(waiting.hasPose("fish")); assert.deepEqual(probe.state.clearing.position, feet);
    assert.ok(waiting.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#d1b27c"), "the rod is painted in the same scene");
    world.configure({ ...traveling, view: "world", paused: true }); circle.configure({ ...traveling, backgrounded: true });
    const paused = probe.state.director.elapsed; clock.advance(10); assert.equal(probe.state.director.elapsed, paused);
    world.configure({ ...traveling, view: "world" }); clock.advance(1);
    assert.ok(probe.state.director.elapsed > paused);
    world.setTime(700_000);
    assert.equal(probe.state.journeyTravel.phase, "fishing");
    assert.ok(probe.state.journeyTravel.ending, "the server deadline first folds the visible tackle");
    assert.deepEqual(probe.state.clearing.position, feet);
    world.notice(); assert.equal(probe.state.reaction, 0, "a tap cannot steal the actor during cleanup");
    clock.until(() => probe.state.journeyTravel.phase === "returning", "cleanup finishes before walking home");
    clock.until(() => !probe.state.journeyTravel, "the same walker returns after the server deadline", 500);
    assert.deepEqual(probe.state.clearing.position, home);
    assert.ok(sampleHero(world, env, pixelSprite).body);
    assert.equal(job.finishesAt, new Date(700_000).toISOString(), "cosmetic animation cannot edit server timing");
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("restored coastal jobs show static fishing in reduced motion without an animation loop", async () => {
  const loaded = await modules(fishingFixture());
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite } = loaded;
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const job = { id: "restored-shore", routeId: "shore_camp", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
    scene = mountHabitat(env.surface(), { ...options, serverNow: 200_000, presenceKey: "restored-visible-fishing", economyJourney: job },
      { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession("restored-visible-fishing", TILED_WORLD, "circle", 200_000, 0, () => {});
    assert.equal(probe.state.journeyTravel.phase, "fishing");
    assert.deepEqual(probe.state.clearing.position, { x: 690, y: 700 });
    assert.ok(sampleFishingHero(scene, env, loaded, probe.state, TILED_WORLD, true).hasPose("fish"));
    assert.equal(env.frames.size, 0);
    const before = sampleFishingHero(scene, env, loaded, probe.state, TILED_WORLD, true).calls;
    env.tick(10_000);
    assert.deepEqual(sampleFishingHero(scene, env, loaded, probe.state, TILED_WORLD, true).calls, before);
    scene.setTime(700_000);
    assert.equal(probe.state.journeyTravel, undefined);
    assert.ok(sampleHero(scene, env, pixelSprite).body, "completion leaves a visible safe outdoor actor");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("confirmed cancellation reaches both mounted cameras and clears caught fish for active and ready trips", async () => {
  for (const ready of [false, true]) {
    const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, forestJourneyFishingFrame } = await modules(fishingFixture());
    const env = browser(), views = []; let probe;
    try {
      worldDevStore.patch({ ...quietClearing, autoLife: false });
      const job = { id: `cancel-mounted-${ready}`, routeId: "shore", rewards: { fish: 4 }, startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
      const initial = { ...options, reducedMotion: false, serverNow: 200_000, presenceKey: `cancel-fishing-${ready}`, economyJourney: job };
      const callbacks = { activity() {}, ready() {}, failure: assert.fail };
      const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
      env.finish(); await flush();
      probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 200_000, 0, () => {});
      const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
      const clock = sceneClock(env);
      const catchAt = 100_000 + (probe.state.journeyTravel.jobFishing.catches[0].at - 3) * 1000;
      world.setTime(catchAt); clock.advance(.05);
      assert.equal(forestJourneyFishingFrame(probe.state, TILED_WORLD).carryingFish, true);
      if (ready) { world.setTime(700_000); clock.advance(1); }
      const feet = { ...probe.state.clearing.position };
      const cancelled = { ...initial, economyJourney: null, serverNow: ready ? 701_000 : catchAt + 50, cancelledExplorations: [job.id] };
      circle.configure(cancelled); world.configure({ ...cancelled, view: "world" });
      assert.equal(probe.state.journeyTravel.cancelled, true);
      assert.deepEqual(probe.state.clearing.position, feet);
      if (!ready) assert.ok(probe.state.journeyTravel.ending, "an active cancellation completes its visible gesture first");
      clock.until(() => probe.state.journeyTravel.phase === "returning", "a cancelled catch finishes putting away its tackle");
      assert.equal(forestJourneyFishingFrame(probe.state, TILED_WORLD).carryingFish, false);
      assert.deepEqual(circle.position(), world.position());
      const beganAt = probe.state.journeyTravel.beganAt;
      world.configure({ ...cancelled, view: "world" });
      assert.equal(probe.state.journeyTravel.beganAt, beganAt, "a repeated receipt cannot restart the walk");
      const handoffFeet = { ...probe.state.clearing.position };
      world.dispose(); await flush();
      assert.deepEqual(probe.state.clearing.position, handoffFeet, "camera handoff preserves the cancelled return");
      clock.until(() => !probe.state.journeyTravel, "the empty-handed actor returns using the shared collision-safe walker", 500);
      assert.deepEqual(probe.state.clearing.position, probe.state.clearing.home);
    } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
  }
});

test("resident AI advances once across cameras, freezes at actual feet and survives read-only DEV pose overrides", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "resident-mind-handoff" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const mind = probe.state.pleskMind, clock = sceneClock(env);
    assert.ok(mind);
    mind.catchCount = 3; // A full local basket gives the real AI a reason to leave its pier.
    clock.until(() => mind.stage.action === "walk", "the resident chooses a safe delivery walk", 120);
    clock.advance(.5);
    assert.notDeepEqual(mind.position, { x: 690, y: 700 });
    const beforeMount = structuredClone(mind);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.strictEqual(probe.state.pleskMind, mind);
    assert.deepEqual(mind, beforeMount, "opening the map cannot reroll the resident's decision or reset her feet");
    assert.equal(env.frames.size, 1);
    for (let pass = 0; pass < 4; pass++) for (const view of [circle, world]) {
      view.paintWorld(env.surface().context);
      const point = view.inspectPoint("plesk"); view.hitResident(point.x, point.y);
    }
    assert.deepEqual(mind, beforeMount, "painting and hit-testing cannot advance needs, RNG or stage clocks");
    const beforeClock = mind.elapsed, sceneTime = probe.state.elapsed;
    clock.advance(.4);
    approximately(mind.elapsed - beforeClock, probe.state.elapsed - sceneTime, "two visible cameras advance one resident clock");
    const beforePreview = structuredClone(mind);
    worldDevStore.triggerResident("fish", true);
    assert.deepEqual(mind, beforePreview, "starting a DEV pose cannot rewind the natural AI");
    assert.deepEqual(world.inspectPoint("plesk"), { x: 690, y: 682 });
    clock.advance(.5);
    assert.ok(mind.elapsed > beforePreview.elapsed, "natural needs and route continue underneath a display-only pose");
    const afterPreview = structuredClone(mind);
    worldDevStore.patch({ residentPreview: null });
    assert.deepEqual(mind, afterPreview);
    assert.deepEqual(world.inspectPoint("plesk"), { x: mind.position.x, y: mind.position.y - 18 });
    circle.configure({ ...initial, backgrounded: true });
    world.configure({ ...initial, view: "world", paused: true });
    const frozen = structuredClone(mind); clock.advance(2);
    assert.deepEqual(mind, frozen);
    world.configure({ ...initial, view: "world", reducedMotion: true }); clock.advance(2);
    assert.deepEqual(mind, frozen, "reduced motion freezes the actual route position");
    assert.deepEqual(world.inspectPoint("plesk"), { x: frozen.position.x, y: frozen.position.y - 18 });
    world.configure({ ...initial, view: "world" }); clock.advance(.5);
    assert.ok(mind.elapsed > frozen.elapsed);
    const beforeReturn = structuredClone(mind);
    world.dispose(); circle.configure(initial);
    assert.deepEqual(mind, beforeReturn, "handoff back to the circle preserves the same mind");
    clock.advance(.5); assert.ok(mind.elapsed > beforeReturn.elapsed);
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("only a completed resident tap reaches her AI, while drags, pinch and canceled touches leave it alone", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "resident-attention" };
    const canvas = env.surface(400), residents = [];
    const loading = createMapEngine(canvas, initial, assert.fail, [], undefined, {}, { onResident: id => residents.push(id) });
    env.finish(); await flush(); engine = await loading; engine.control("overview");
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const mind = probe.state.pleskMind, original = structuredClone(mind);
    const touch = () => { const projection = mapProjection(canvas); return { pointerId: 1, pointerType: "touch", button: 0,
      clientX: projection.left + 690 * projection.zoom, clientY: projection.top + 682 * projection.zoom }; };
    const send = (name, point) => canvas.events.get(name)({ ...point, type: name });
    let first = touch(); send("pointerdown", first); send("pointermove", { ...first, clientX: first.clientX + 30 });
    send("pointerup", { ...first, clientX: first.clientX + 30 }); engine.control("overview");
    first = touch(); send("pointerdown", first); send("pointercancel", first);
    first = touch(); const second = { ...first, pointerId: 2, clientX: first.clientX + 35 };
    send("pointerdown", first); send("pointerdown", second); send("pointermove", { ...second, clientX: second.clientX + 10 });
    send("pointerup", first); send("pointerup", { ...second, clientX: second.clientX + 10 }); engine.control("overview");
    assert.deepEqual(residents, []);
    assert.deepEqual(mind, original, "camera gestures cannot queue social attention or advance resident AI");
    first = touch(); send("pointerdown", first); send("pointerup", first);
    assert.deepEqual(residents, ["plesk"]);
    assert.equal(mind.noticePending, true);
    const clock = sceneClock(env); clock.advance(.1);
    assert.equal(mind.stage.action, "greet");
    assert.equal(mind.noticePending, false);
    assert.equal(probe.state.reaction, 0, "the main hero does not receive the resident's tap");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("DEV fishing rehearses the real trip, stops with a safe return and yields to confirmed jobs", async () => {
  const loaded = await modules(fishingFixture());
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite } = loaded;
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "dev-visible-fishing" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const home = { ...probe.state.clearing.position }, clock = sceneClock(env);
    worldDevStore.triggerScenario("fishing");
    assert.ok(probe.state.fishingPreview);
    assert.equal(probe.state.journeyTravel.phase, "leaving");
    assert.equal(probe.state.memory.enabled, false, "a rehearsal cannot save simulated account activity");
    clock.until(() => probe.state.journeyTravel.phase === "fishing", "DEV reaches the same real shore", 500);
    clock.advance(18);
    assert.ok(sampleFishingHero(scene, env, loaded, probe.state, TILED_WORLD).hasPose("present", "fish"));
    const atShore = { ...probe.state.clearing.position };
    worldDevStore.triggerLife("idle");
    assert.equal(probe.state.fishingPreview, undefined);
    assert.equal(probe.state.journeyTravel.phase, "fishing");
    assert.ok(probe.state.journeyTravel.ending, "DEV stopping uses the same catch cleanup as a confirmed journey");
    assert.deepEqual(probe.state.clearing.position, atShore, "stop never teleports home");
    clock.until(() => probe.state.journeyTravel.phase === "returning", "DEV stop finishes the current catch first");
    clock.until(() => !probe.state.journeyTravel, "DEV stop completes its return even with autoLife off", 500);
    assert.deepEqual(probe.state.clearing.position, home);
    const confirmed = { id: "confirmed-cave", routeId: "cave", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
    scene.configure({ ...initial, economyJourney: confirmed });
    worldDevStore.triggerScenario("fishing");
    assert.equal(probe.state.fishingPreview, undefined, "a local rehearsal cannot steal a server-owned actor");
    assert.equal(probe.state.explorationId, confirmed.id);
    assert.equal(sampleHero(scene, env, pixelSprite).body, undefined);
    scene.configure({ ...initial, economyJourney: confirmed, serverNow: 700_000 });
    assert.equal(probe.state.fishingPreview, undefined, "a rejected rehearsal is not queued behind a real job");
    assert.equal(probe.state.explorationId, null);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("Plesk DEV direction previews share time, camera point and body taps without moving the hero", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "dev-plesk-preview" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const home = { ...probe.state.clearing.position }, clock = sceneClock(env);
    worldDevStore.triggerResident("walk", true);
    const previewStarted = probe.state.residentPreview.startedAt;
    const center = circle.inspectPoint("plesk");
    assert.equal(circle.hitResident(center.x, center.y), "plesk");
    const paint = view => { const target = env.surface(); view.paintWorld(target.context); return target.calls; };
    const front = paint(circle);
    worldDevStore.patch({ residentDirection: "left" });
    const left = paint(circle);
    assert.notDeepEqual(left, front, "direction changes the resident's procedural body");
    assert.equal(probe.state.residentPreview.startedAt, previewStarted, "direction selection preserves the current preview clock");
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.deepEqual(paint(world), paint(circle));
    assert.deepEqual(world.inspectPoint("plesk"), center);
    assert.equal(world.hitResident(center.x, center.y), "plesk");
    clock.advance(.5);
    assert.notDeepEqual(paint(world), left, "walking frames advance through the shared renderer");
    assert.deepEqual(probe.state.clearing.position, home);
    assert.equal(probe.state.journeyTravel, undefined, "testing a resident does not start a player expedition");
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("premount Plesk preview keeps its camera target and animates after geometry replaces the session", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 820, width: 120, height: 120 },
    anchor: { x: 660, y: 940 }, entry: { x: 660, y: 950 }, hitArea: [], collision: [], initialLevel: 1,
    states: [1, 2].map(level => ({ level, label: `Level ${level}`, image: `/preview-home-${level}.webp` })) };
  const overrides = residentFixture();
  overrides.sites = [site];
  overrides.navigation = { ...livingNavigation, obstacles: [{ id: "level-one-stone", when: { siteId: "home", level: 1 },
    points: [{ x: 575, y: 615 }, { x: 585, y: 615 }, { x: 585, y: 625 }, { x: 575, y: 625 }] }] };
  const { createMapEngine, connectForestSession, previewWorldScene, TILED_WORLD, worldDevStore } = await modules(overrides);
  const env = browser(), probes = []; let engine;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    worldDevStore.triggerResident("walk", true);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "premount-resident" };
    const canvas = env.surface(400), loading = createMapEngine(canvas, initial, () => {}, []);
    env.finishPath("/test-ground.webp"); await flush(); env.finishPath("/preview-home-1.webp"); await flush(); engine = await loading;
    const currentProbe = level => {
      const probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: level }), "circle", 100_000, 0, () => {});
      probes.push(probe); return probe;
    };
    let probe = currentProbe(1);
    assert.ok(probe.state.residentPreview, "a preview selected before mounting gets a persistent start clock");
    const projection = mapProjection(canvas);
    approximately(projection.left + 690 * projection.zoom, 200, "the premount resident camera centers its actual x");
    approximately(projection.top + 682 * projection.zoom, 200, "the premount resident camera centers its body y");
    const residentSprite = () => canvas.calls.findLast(call => call.method === "drawImage" && call.args.length === 5
      && call.args[0]?.width === 48 && call.args[0]?.height === 48)?.args[0];
    const clock = sceneClock(env), first = residentSprite(); clock.advance(.4);
    assert.notEqual(residentSprite(), first, "premount preview does not stay at frame zero");
    const previous = probe.state;
    worldDevStore.patch({ levels: { home: 2 } }); env.finishPath("/preview-home-2.webp"); await flush();
    probe = currentProbe(2);
    assert.notEqual(probe.state, previous, "the changed obstacle creates a new scene session");
    assert.ok(probe.state.residentPreview, "an existing DEV selection receives a start clock in the new geometry");
    const replaced = residentSprite(); clock.advance(.4);
    assert.notEqual(residentSprite(), replaced, "a geometry handoff cannot freeze the resident rehearsal");
  } finally { engine?.dispose(); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});

test("premount DEV fishing starts the approach once and preserves the absolute shore camera", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(fishingFixture());
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false }); worldDevStore.triggerScenario("fishing");
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "premount-fishing" };
    const canvas = env.surface(400), loading = createMapEngine(canvas, initial, () => {}, []);
    env.finish(); await flush(); engine = await loading;
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    assert.equal(probe.state.journeyTravel.phase, "leaving", "the rehearsal demonstrates walking even on a fresh mount");
    const jobId = probe.state.journeyTravel.jobId, began = probe.state.fishingPreview.startedAt;
    const projection = mapProjection(canvas);
    approximately(projection.left + 690 * projection.zoom, 200, "premount camera centers shore x");
    approximately(projection.top + 682 * projection.zoom, 200, "premount camera centers shore body y");
    const clock = sceneClock(env); clock.advance(1);
    const feet = { ...probe.state.clearing.position };
    engine.update({ ...initial, paused: true }); engine.update(initial);
    assert.equal(probe.state.journeyTravel.jobId, jobId);
    assert.equal(probe.state.fishingPreview.startedAt, began, "resume consumes no second rehearsal event");
    assert.deepEqual(probe.state.clearing.position, feet);
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("DEV cooking shares one clock across cameras and read-only renders, control edits and pauses never restart it", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, cookingPreviewFrame } = await modules({ navigation: livingNavigation });
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "cooking-two-cameras" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const clock = sceneClock(env), feet = { ...probe.state.clearing.position };
    worldDevStore.triggerCooking("sequence", true);
    assert.ok(probe.state.cookingPreview);
    assert.notEqual(probe.state.cookingPreview.startedAt, null);
    const started = { ...probe.state.cookingPreview };
    clock.advance(1);
    const first = cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview);
    assert.equal(first.action, "prepare"); assert.ok(first.phase > 0);
    const paint = view => { const target = env.surface(); view.paintWorld(target.context); return target.calls; };
    const beforeRead = structuredClone(probe.state);
    const firstPaint = paint(circle); paint(circle); circle.position(); circle.inspectPoint("pet"); circle.hitPet(.5, .5);
    assert.deepEqual(probe.state, beforeRead, "rendering and inspecting cannot consume or finish a cooking gesture");
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.deepEqual(probe.state.cookingPreview, started, "opening a second camera preserves the rehearsal start");
    assert.deepEqual(paint(world), firstPaint);
    worldDevStore.patch({ waterBreeze: false, waterFish: "off" });
    assert.deepEqual(probe.state.cookingPreview, started, "unrelated DEV preferences cannot replay the event");
    clock.step();
    const beforeClock = probe.state.elapsed;
    clock.advance(.5);
    approximately(probe.state.elapsed - beforeClock, .5, "two cameras advance a single shared cooking clock");
    assert.deepEqual(paint(world), paint(circle));
    assert.deepEqual(probe.state.clearing.position, feet, "cooking stays at the actual outdoor feet");
    worldDevStore.patch({ paused: true });
    const frozen = structuredClone(probe.state); clock.advance(2);
    assert.deepEqual(probe.state, frozen); assert.equal(env.frames.size, 0);
    worldDevStore.patch({ paused: false, reducedMotion: "on" });
    const still = structuredClone(probe.state); clock.advance(2);
    assert.deepEqual(probe.state, still); assert.equal(env.frames.size, 0);
    const stillPaint = paint(world); assert.deepEqual(paint(circle), stillPaint);
    worldDevStore.patch({ reducedMotion: "off", cookingPreview: null });
    assert.equal(probe.state.cookingPreview, undefined);
    assert.equal(probe.state.clearing.frozen, false);
    assert.deepEqual(probe.state.clearing.position, feet, "cancel releases the visible actor without teleporting");
    assert.equal(cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview), null);
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("DEV cooking finishes once, repeats only explicitly and cannot create inventory or expedition progress", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, cookingPreviewFrame } = await modules({ navigation: livingNavigation });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "cooking-one-shot",
      onGardenHarvestEvent() { assert.fail("a cooking rehearsal cannot claim production"); } };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const clock = sceneClock(env), basketBefore = structuredClone(probe.state.life.garden.basket);
    worldDevStore.triggerCooking("prepare");
    const firstId = probe.state.cookingPreview.id;
    assert.equal(probe.state.memory.enabled, false, "a rehearsal cannot save fake meals to account memory");
    clock.advance(7.5);
    assert.equal(probe.state.cookingPreview, undefined);
    assert.equal(probe.state.clearing.frozen, true, "automatic life remains deliberately disabled after the rehearsal ends");
    assert.equal(cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview), null);
    scene.configure({ ...initial, paused: true }); scene.configure(initial);
    assert.equal(probe.state.cookingPreview, undefined, "a consumed one-shot does not restart on resuming the view");
    worldDevStore.triggerCooking("prepare", true);
    assert.ok(probe.state.cookingPreview.id > firstId);
    clock.advance(15);
    assert.ok(probe.state.cookingPreview); assert.equal(probe.state.clearing.frozen, true);
    assert.equal(probe.state.journeyTravel, undefined); assert.ok(!probe.state.explorationId);
    assert.deepEqual(probe.state.life.garden.basket, basketBefore, "preview utensils cannot consume or refill the real berry basket");
    worldDevStore.triggerPose("greet");
    assert.equal(probe.state.cookingPreview, undefined, "a selected hero gesture immediately removes cooking props");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("confirmed expeditions interrupt cooking and a rejected rehearsal is never queued behind the real job", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, cookingPreviewFrame } = await modules(fishingFixture());
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "cooking-job-priority" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerCooking("stir", true); clock.advance(.5);
    assert.ok(probe.state.cookingPreview);
    const confirmed = { id: "cooking-interrupted-by-shore", routeId: "shore", startedAt: new Date(100_000).toISOString(),
      finishesAt: new Date(700_000).toISOString() };
    scene.configure({ ...initial, economyJourney: confirmed });
    assert.equal(probe.state.cookingPreview, undefined, "the server-owned departure removes local props immediately");
    assert.equal(probe.state.journeyTravel.jobId, confirmed.id);
    assert.equal(cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview), null);
    const travel = probe.state.journeyTravel, feet = { ...probe.state.clearing.position };
    worldDevStore.triggerCooking("serve");
    assert.equal(probe.state.cookingPreview, undefined);
    assert.equal(probe.state.journeyTravel, travel); assert.deepEqual(probe.state.clearing.position, feet);
    scene.configure({ ...initial, economyJourney: null, cancelledExplorations: [confirmed.id] });
    clock.until(() => !probe.state.journeyTravel, "real cancellation completes its safe return", 500);
    assert.equal(probe.state.cookingPreview, undefined, "rejected cooking never starts after the expedition releases the actor");
    assert.equal(cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview), null);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("cooking waits for outdoor feet and a real tap finishes the current cycle without replaying the request", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, cookingPreviewFrame, clearingActivityFrame } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "cooking-indoor-exit" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    worldDevStore.triggerLife("home-sleep");
    const clock = sceneClock(env);
    clock.until(() => probe.state.clearing.stage === "home-sleep", "the actor reaches indoor sleep", 500);
    worldDevStore.patch({ autoLife: false });
    const indoorFeet = { ...probe.state.clearing.position };
    worldDevStore.triggerCooking("sequence", true);
    assert.ok(probe.state.cookingPreview);
    assert.equal(probe.state.cookingPreview.startedAt, null, "no utensils appear while the actor is indoors");
    assert.deepEqual(probe.state.clearing.position, indoorFeet, "the rehearsal requests the existing doorway exit without teleporting");
    assert.equal(cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview), null);
    clock.until(() => Boolean(probe.state.cookingPreview && probe.state.cookingPreview.startedAt !== null),
      "explicit doorway travel continues even with automatic life disabled", 300);
    const frame = cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview);
    const actor = clearingActivityFrame(probe.state.clearing);
    assert.ok(frame); assert.equal(actor.opacity, 1); assert.ok(!actor.residing && !actor.lift);
    assert.ok(distanceBetween(probe.state.clearing.position, indoorFeet) > 0, "the actor actually left the indoor position");
    assert.deepEqual({ x: frame.x, y: frame.y }, probe.state.clearing.position);
    const startedAt = probe.state.cookingPreview.startedAt;
    scene.notice();
    assert.equal(probe.state.cookingPreview.startedAt, startedAt, "tap does not break the visible cooking gesture");
    const attentionAt = probe.state.cookingPreview.attentionAt;
    clock.advance(1); scene.notice();
    assert.equal(probe.state.cookingPreview.attentionAt, attentionAt, "repeat taps do not extend the cycle");
    clock.until(() => !probe.state.cookingPreview, "cooking completes before greeting", 650);
    clock.advance(1);
    assert.equal(probe.state.cookingPreview, undefined, "a tap does not leave the consumed preview queued for another start");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});


test("production props use one confirmed job across both cameras, preserve ready until claim and reject stale background work", async () => {
  const campfires=[{ id: "clearing-campfire", position: { x: 680, y: 665 }, seat: { x: 640, y: 684 }, radius: 10 }];
  const { mountHabitat, connectForestSession, TILED_WORLD, forestProductionFrames } = await modules({ campfires, navigation: livingNavigation });
  const env=browser(), views=[]; let probe;
  try {
    const end=Date.parse("2026-10-05T12:00:00Z"), owner="1234-5678-ABCD";
    const production={ ownerPublicId:owner, revision:5, jobs:[{ id:"confirmed-dryer", stationId:"dryer", stationLevel:1,
      recipeId:"dry_berries", startedAt:new Date(end-7200000).toISOString(), finishesAt:new Date(end).toISOString() }] };
    const initial={ ...options, serverNow:end-1000, presenceKey:`zhiv:mochlik:presence:${owner}`, economyProduction:production };
    const callbacks={ activity() {}, ready() {}, failure:assert.fail };
    const circle=mountHabitat(env.surface(),initial,callbacks); views.push(circle);
    const world=mountHabitat(env.surface(),{ ...initial,view:"world" },callbacks); views.push(world);
    env.finishPath("/test-ground.webp"); await flush();
    probe=connectForestSession(initial.presenceKey,TILED_WORLD,"circle",end-1000,0,()=>{}, { persistence:false, sync:false });
    const state=probe.state, clearing=structuredClone(state.clearing), fire=structuredClone(state.life.campfires);
    assert.equal(state.economyProduction.revision,5);
    for (const view of views) {
      const surface=env.surface(); view.paintWorld(surface.context);
      assert.ok(surface.calls.some(call => call.method==="translate" && Math.abs(call.args[0]-680)<.01 && Math.abs(call.args[1]-(665-40*.13))<.01),"the installed real dryer job paints the anchored cooking prop");
    }
    const ready=forestProductionFrames(state.economyProduction,TILED_WORLD,{},end,0);
    assert.equal(ready[0].phase,"ready");
    world.setTime(end+1000); world.paintWorld(env.surface().context);
    assert.equal(state.economyProduction.jobs.length,1,"reaching the timer cannot claim or delete food");
    world.configure({ ...initial,view:"world",serverNow:end+1000,economyProduction:{ ...production,revision:6,jobs:[] } });
    circle.configure({ ...initial,backgrounded:true });
    assert.deepEqual(state.economyProduction.jobs,[],"a background circle cannot resurrect a claimed job");
    for (const view of views) {
      const surface=env.surface(); view.paintWorld(surface.context);
      assert.ok(!surface.calls.some(call => call.method==="translate" && Math.abs(call.args[0]-680)<.01 && Math.abs(call.args[1]-(665-40*.13))<.01),"both cameras stop drawing the claimed cooking prop");
    }
    world.dispose(); views.pop(); circle.configure(initial); await flush();
    assert.deepEqual(state.economyProduction.jobs,[],"camera handoff retains the removal revision");
    assert.deepEqual(state.life.campfires,fire,"cooking is a visual projection and does not kindle weather-owned fire state");
    assert.deepEqual(state.clearing,clearing,"a multi-hour job never forces the hero into cooking animation or movement");
  } finally { probe?.release(); views.forEach(view=>view.dispose()); env.restore(); }
});

test("quarry production keeps one visible work sign by day and night, including static or absent actor frames", async () => {
  const quarry={id:"quarry",label:"Шахта",initialLevel:1,bounds:{x:660,y:590,width:55,height:48},
    anchor:{x:688,y:638},entry:{x:680,y:640},doorway:{x:686,y:625},collision:[],hitArea:[],
    states:[{level:1,label:"Шахта",image:"/test-quarry.webp"}]};
  const {paintNewMap,TILED_WORLD,NEW_MAP_PET_SIZE,WORLD_DEV_DEFAULTS}=await modules({sites:[quarry]});
  const env=browser();
  try {
    const production={ownerPublicId:"worker",revision:1,jobs:[{id:"stone",stationId:"quarry",stationLevel:1,
      recipeId:"quarry_stone",startedAt:new Date(100_000).toISOString(),finishesAt:new Date(700_000).toISOString()}]};
    const cue={x:quarry.anchor.x,y:quarry.bounds.y-NEW_MAP_PET_SIZE*.12};
    const count=(now,still,night,mining=null,showBuildings=true,view="circle",jobs=production)=>{
      const surface=env.surface();
      paintNewMap(surface.context,new Map(),{...options,view,reducedMotion:still,economyProduction:jobs},7,false,now,night?1:0,
        {scene:TILED_WORLD,actorAway:true,mining,state:{...WORLD_DEV_DEFAULTS,showBuildings,timeOfDay:night?"night":"day"}});
      return surface.calls.filter(call=>call.method==="ellipse" && call.args[0]===cue.x && call.args[1]===cue.y).length;
    };
    const mining={...quarry.entry,size:NEW_MAP_PET_SIZE,opacity:0,scale:1,pose:"idle",frame:0,direction:"back",
      working:true,workCue:cue,doorway:quarry.doorway,elapsed:7};
    for(const still of [false,true]) for(const night of [false,true]) {
      assert.equal(count(200_000,still,night),1,"ordinary production has a sign even when another activity owns the hero");
      assert.equal(count(200_000,still,night,mining),1,"the worker and production must not draw duplicate signs");
      assert.equal(count(700_000,still,night),0,"finished jobs stop the work sign without requiring a claim");
      assert.equal(count(200_000,still,night,mining,true,"world"),0,"the full map has a production badge instead of a duplicate work sign");
      assert.equal(count(700_000,still,night,mining,true,"world"),0,"a ready production badge is not covered by the expedition's work sign");
      assert.equal(count(200_000,still,night,mining,true,"world",{...production,jobs:[]}),1,"an expedition without production keeps its map work sign");
    }
    assert.equal(count(99_999,false,false),0,"future jobs do not pretend to work early");
    assert.equal(count(200_000,false,false,mining,false),0,"hidden buildings have no orphan work sign");
    assert.equal(count(200_000,false,false,{...mining,working:false}),0,"the worker still on the road does not pretend to be inside");
  }finally{env.restore();}
});

test("ordinary quarry production walks from base, shares the miner across cameras and yields safely to an expedition", async () => {
  const quarry={id:"quarry",label:"Шахта",initialLevel:1,bounds:{x:660,y:590,width:55,height:48},
    anchor:{x:688,y:638},entry:{x:680,y:640},doorway:{x:686,y:625},collision:[],hitArea:[],
    states:[{level:1,label:"Шахта",image:"/test-quarry.webp"}]};
  const loaded=await modules({...fishingFixture(),sites:[quarry],destinations:[
    {id:"fishing",position:{x:690,y:700},pauseSeconds:15},
    {id:"quarry",position:{x:674,y:649},pauseSeconds:15}]});
  const {mountHabitat,connectForestSession,TILED_WORLD,worldDevStore,forestJourneyActorAway}=loaded;
  const env=browser(),views=[];let probe;
  try {
    worldDevStore.patch({...quietClearing,autoLife:false});
    const owner="mine-worker",production={ownerPublicId:owner,revision:1,jobs:[{id:"quarry-production",stationId:"quarry",stationLevel:1,
      recipeId:"quarry_stone",startedAt:new Date(100_000).toISOString(),finishesAt:new Date(700_000).toISOString()}]};
    const original=structuredClone(production),initial={...options,reducedMotion:false,serverNow:100_000,
      presenceKey:`zhiv:mochlik:presence:${owner}`,economyProduction:production};
    const callbacks={activity(){},ready(){},failure:assert.fail};
    const circle=mountHabitat(env.surface(),initial,callbacks);views.push(circle);
    env.finish();await flush();env.finish();await flush();
    probe=connectForestSession(initial.presenceKey,TILED_WORLD,"circle",100_000,0,()=>{});
    const clock=sceneClock(env),home={...probe.state.clearing.home};
    assert.equal(probe.state.journeyTravel.phase,"leaving","a first mounted production receipt still shows departure");
    assert.deepEqual(probe.state.clearing.position,home);
    clock.until(()=>probe.state.journeyTravel.phase==="working","ordinary stone production reaches the mine",1000);
    const feet={...probe.state.clearing.position},travel=probe.state.journeyTravel;
    const world=mountHabitat(env.surface(),{...initial,view:"world"},callbacks);views.push(world);await flush();
    assert.strictEqual(probe.state.journeyTravel,travel);assert.deepEqual(probe.state.clearing.position,feet);
    assert.equal(env.frames.size,1,"both cameras share the same worker clock");
    const painted=env.surface(),cue=probe.state.journeyTravel.mining.workCue;
    world.paintWorld(painted.context);
    assert.equal(painted.calls.filter(call=>call.method==="ellipse" && call.args[0]===cue.x && call.args[1]===cue.y).length,0,
      "the full map delegates this production roof to its screen-space timer badge");
    const expedition={id:"higher-priority-shore",routeId:"shore",startedAt:new Date(100_000).toISOString(),
      finishesAt:new Date(700_000).toISOString(),rewards:{fish:4}};
    const next={...initial,economyJourney:expedition};
    world.configure({...next,view:"world"});circle.configure({...next,backgrounded:true});
    assert.equal(probe.state.journeyTravel.phase,"exiting");assert.deepEqual(probe.state.clearing.position,feet);
    assert.equal(forestJourneyActorAway(probe.state,expedition,100_000),false);
    clock.until(()=>probe.state.journeyTravel?.phase==="fishing","the new expedition starts after a physical return from the mine",2000);
    assert.equal(probe.state.journeyTravel.jobId,expedition.id);
    assert.deepEqual(production,original,"a visual worker cannot alter production dates, output or claim state");
  }finally{views.forEach(view=>view.dispose());probe?.release();worldDevStore.reset();env.restore();}
});

const builderFixture = () => ({
  ...residentFixture(),
  sites: [{ id: "workshop", label: "Мастерская", initialLevel: 1,
    bounds: { x: 600, y: 620, width: 40, height: 35 }, anchor: { x: 620, y: 648 }, entry: { x: 620, y: 670 },
    hitArea: [{ x: 600, y: 620 }, { x: 640, y: 620 }, { x: 640, y: 655 }, { x: 600, y: 655 }],
    collision: [{ x: 602, y: 633 }, { x: 638, y: 633 }, { x: 638, y: 650 }, { x: 602, y: 650 }],
    states: [{ level: 1, label: "Мастерская", image: "/test-builder-workshop.webp" }] }],
});
const confirmedConstruction = (ownerPublicId, revision = 1, jobs) => ({ ownerPublicId, revision,
  jobs: jobs ?? [{ id: "confirmed-workshop", stationId: "workshop", targetLevel: 2,
    startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() }],
});

test("builder work shares one route and clock across cameras; painting and hit tests cannot progress it", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, builderSpriteRig } = await modules(builderFixture());
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const construction = confirmedConstruction("builder-shared"), original = structuredClone(construction);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000,
      presenceKey: "zhiv:mochlik:presence:builder-shared", economyConstruction: construction };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush(); env.finishPath("/test-builder-workshop.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const mind = probe.state.builderMind, clock = sceneClock(env);
    assert.ok(mind); assert.equal(mind.job.id, "confirmed-workshop");
    assert.equal(mind.action, "walk");
    const first = { ...mind.position }; clock.advance(.5); assert.notDeepEqual(mind.position, first);
    const beforeMount = structuredClone(mind);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.strictEqual(probe.state.builderMind, mind); assert.deepEqual(mind, beforeMount);
    assert.equal(env.frames.size, 1, "two cameras elect one active clock");
    for (let pass = 0; pass < 4; pass++) for (const view of [circle, world]) {
      const painted = env.surface(); view.paintWorld(painted.context);
      assert.ok(painted.calls.some(call => call.method === "drawImage" && builderSpriteRig(call.args[0])), "the real builder sprite is painted");
      const point = view.inspectPoint("builder"); assert.ok(point); view.hitResident(point.x, point.y);
    }
    assert.deepEqual(mind, beforeMount, "sampling cannot advance builder route, action, or decisions");
    const elapsed = mind.elapsed, sharedElapsed = probe.state.elapsed;
    clock.advance(.4);
    approximately(mind.elapsed - elapsed, probe.state.elapsed - sharedElapsed, "one shared builder simulation step per world step");
    clock.until(() => mind.action === "work", "the builder reaches the confirmed workshop and starts working", 600);
    assert.equal(mind.target.id, "workshop");
    assert.equal(probe.state.explorationId, null, "construction does not assign an expedition to Mochlik");
    assert.deepEqual(construction, original, "the animation cannot edit a confirmed job or its timestamps");
    const handoff = structuredClone(mind); world.dispose(); circle.configure(initial);
    assert.deepEqual(mind, handoff, "returning to the circle preserves the builder at his work spot");
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("construction removals fence stale cameras and changing accounts cannot inherit another owner's builder job", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(builderFixture());
  const env = browser(), views = [], probes = [];
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const old = confirmedConstruction("builder-fence", 5), initial = { ...options, reducedMotion: false, serverNow: 100_000,
      presenceKey: "zhiv:mochlik:presence:builder-fence", economyConstruction: old };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush(); env.finishPath("/test-builder-workshop.webp"); await flush();
    const probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {}); probes.push(probe);
    assert.equal(probe.state.builderMind.job.id, old.jobs[0].id);
    const removed = confirmedConstruction("builder-fence", 6, []);
    const world = mountHabitat(env.surface(), { ...initial, view: "world", economyConstruction: removed }, callbacks); views.push(world); await flush();
    assert.equal(probe.state.economyConstruction.revision, 6); assert.equal(probe.state.builderMind.job, null);
    circle.configure(initial);
    assert.equal(probe.state.economyConstruction.revision, 6); assert.equal(probe.state.builderMind.job, null, "the background camera cannot resurrect collected construction");
    const beforeOwnerChange = structuredClone(probe.state.builderMind);
    const other = { ...initial, presenceKey: "zhiv:mochlik:presence:builder-other", view: "world" };
    world.configure(other);
    const next = connectForestSession(other.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {}); probes.push(next);
    assert.notStrictEqual(next.state.builderMind, probe.state.builderMind);
    assert.equal(next.state.economyConstruction, undefined, "a mismatched cached account snapshot is rejected");
    assert.equal(next.state.builderMind.job, null);
    assert.deepEqual(probe.state.builderMind, beforeOwnerChange, "switching accounts cannot mutate the preceding resident");
    const accepted = confirmedConstruction("builder-other", 1);
    world.configure({ ...other, economyConstruction: accepted });
    assert.equal(next.state.builderMind.job.id, accepted.jobs[0].id);
    accepted.jobs[0].stationId = "quarry";
    assert.equal(next.state.economyConstruction.jobs[0].stationId, "workshop", "accepted account data is copied at the boundary");
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});

test("reduced motion and hidden views freeze builder feet while confirmed completion can still refresh", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(builderFixture());
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000,
      presenceKey: "zhiv:mochlik:presence:builder-frozen", economyConstruction: confirmedConstruction("builder-frozen") };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); env.finishPath("/test-builder-workshop.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const mind = probe.state.builderMind, clock = sceneClock(env); clock.advance(.5);
    scene.configure({ ...initial, reducedMotion: true, serverNow: 800_000 });
    const feet = { ...mind.position }, elapsed = mind.elapsed;
    assert.equal(mind.ready, true, "the server deadline is independent of the paused cosmetic clock");
    clock.advance(2); assert.deepEqual(mind.position, feet); assert.equal(mind.elapsed, elapsed);
    assert.deepEqual(scene.inspectPoint("builder"), { x: feet.x, y: feet.y - 20 });
    scene.configure({ ...initial, serverNow: 800_000, backgrounded: true });
    const backgrounded = structuredClone(mind); clock.advance(2); assert.deepEqual(mind, backgrounded);
    scene.configure({ ...initial, serverNow: 800_000 }); env.visibility(true);
    const hidden = structuredClone(mind); clock.advance(2); assert.deepEqual(mind, hidden);
    env.visibility(false); clock.advance(.5); assert.ok(mind.elapsed > hidden.elapsed, "visibility resumes the same resident");
    assert.equal(mind.job.id, "confirmed-workshop", "an expired but unclaimed build remains assigned");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("builder taps open his conversation without touching Pleska or Mochlik; camera gestures stay inert", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "builder-taps" };
    const canvas = env.surface(400), residents = [];
    const loading = createMapEngine(canvas, initial, assert.fail, [], undefined, {}, { onResident: id => residents.push(id) });
    env.finish(); await flush(); engine = await loading; engine.control("overview");
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const builder = probe.state.builderMind, seller = structuredClone(probe.state.pleskMind);
    const touch = () => { const projection = mapProjection(canvas); return { pointerId: 1, pointerType: "touch", button: 0,
      clientX: projection.left + builder.position.x * projection.zoom, clientY: projection.top + (builder.position.y - 20) * projection.zoom }; };
    const send = (name, point) => canvas.events.get(name)({ ...point, type: name });
    const before = structuredClone(builder); let point = touch();
    send("pointerdown", point); send("pointermove", { ...point, clientX: point.clientX + 30 }); send("pointerup", { ...point, clientX: point.clientX + 30 }); engine.control("overview");
    point = touch(); send("pointerdown", point); send("pointercancel", point);
    const second = { ...point, pointerId: 2, clientX: point.clientX + 35 };
    send("pointerdown", point); send("pointerdown", second); send("pointermove", { ...second, clientX: second.clientX + 10 });
    send("pointerup", point); send("pointerup", { ...second, clientX: second.clientX + 10 }); engine.control("overview");
    assert.deepEqual(residents, []); assert.deepEqual(builder, before);
    point = touch(); send("pointerdown", point); send("pointerup", point);
    assert.deepEqual(residents, ["builder"]); assert.equal(builder.noticePending, true);
    assert.deepEqual(probe.state.pleskMind, seller); assert.equal(probe.state.reaction, 0);
    const clock = sceneClock(env); clock.advance(.1); assert.equal(builder.action, "greet");
    assert.deepEqual(probe.state.pleskMind.position, seller.position, "a builder greeting cannot move the merchant");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("a loaded geometry handoff clones builder progress and a late camera joins without rewinding it", async () => {
  const authored = builderFixture(), site = authored.sites[0], shift = -10;
  site.states.push({ level: 2, label: "Большая мастерская", image: "/test-builder-workshop-2.webp", geometry: {
    bounds: { ...site.bounds, x: site.bounds.x + shift }, anchor: { ...site.anchor, x: site.anchor.x + shift },
    entry: { ...site.entry, x: site.entry.x + shift },
    hitArea: site.hitArea.map(point => ({ ...point, x: point.x + shift })),
    collision: site.collision.map(point => ({ ...point, x: point.x + shift })),
  } });
  const { mountHabitat, connectForestSession, previewWorldScene, TILED_WORLD, worldDevStore } = await modules(authored);
  const env = browser(), views = [], probes = [];
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, economyBuildings: { workshop: 1 },
      presenceKey: "zhiv:mochlik:presence:builder-geometry", economyConstruction: confirmedConstruction("builder-geometry", 5) };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush(); env.finishPath("/test-builder-workshop.webp"); await flush();
    const oldProbe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { workshop: 1 }), "circle", 100_000, 0, () => {}); probes.push(oldProbe);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    const clock = sceneClock(env); clock.advance(.5);
    const oldMind = oldProbe.state.builderMind, beforeLoad = structuredClone(oldMind);
    const completed = { ...initial, view: "world", economyBuildings: { workshop: 2 },
      economyConstruction: confirmedConstruction("builder-geometry", 6, []) };
    world.configure(completed); assert.deepEqual(oldMind.position, beforeLoad.position, "pending art does not teleport the worker");
    env.finishPath("/test-builder-workshop-2.webp"); await flush();
    const newProbe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { workshop: 2 }), "circle", 100_000, 0, () => {}); probes.push(newProbe);
    const newMind = newProbe.state.builderMind;
    assert.notStrictEqual(newMind, oldMind, "different geometry sessions cannot mutate one builder object");
    assert.deepEqual(newMind.position, beforeLoad.position, "the committed footprint retains the worker's current feet");
    assert.equal(newMind.job, null); assert.equal(newProbe.state.economyConstruction.revision, 6);
    world.configure({ ...completed, paused: true });
    circle.configure(initial);
    const frozen = structuredClone(newMind); clock.advance(.5);
    assert.deepEqual(newMind, frozen, "a stale active circle cannot move the paused builder on the new map");
    world.configure(completed); clock.advance(.5);
    const beforeJoin = structuredClone(newMind);
    circle.configure({ ...completed, view: "circle" }); await flush();
    assert.strictEqual(newProbe.state.builderMind, newMind, "late camera does not replace the existing map builder");
    assert.deepEqual(newMind, beforeJoin, "joining preserves the newer job fence, clock and feet");
    assert.equal(newMind.job, null); assert.equal(env.frames.size, 1);
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});
