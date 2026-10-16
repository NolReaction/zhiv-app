import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";


const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = {
  schemaVersion: 1, id: "test-scene", width: 1254, height: 1254,
  terrain: [{ id: "ground", image: "/test-ground.webp", bounds: { x: 0, y: 0, width: 1254, height: 1254 } }],
  focus: { x: 455, y: 480, width: 350, height: 350 },
  actor: { spawn: { x: 630, y: 660 }, size: 36 }, sites: [], paths: [], lights: [], destinations: [],
  water: { surfaces: [], exclusions: [] }, bushes: [], campfires: [], basket: undefined, navigation: undefined, habitats: undefined,
  shadowCasters: undefined, shadowReceivers: undefined,
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
  const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "node_modules/.vite-scene-map-interactions",
    // These fixtures load server modules only. Client dependency discovery can
    // outlive fake scene clocks and keep server.close() waiting after the checks.
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { default: scene } = await vite.ssrLoadModule("/features/world/tiled/forest.generated.json");
    Object.assign(scene, structuredClone(fixture), override);
    // This canvas fixture has no audio files. Keep the real controller/runtime,
    // but do not start the application-wide audio transport in scene timer tests.
    // Asset preparation and cancellation have their own audio-runtime/world-audio tests.
    const { AUDIO_CATALOG } = await vite.ssrLoadModule("/features/audio/catalog/catalog.ts");
    for (const asset of AUDIO_CATALOG.assets) asset.status = "pending";
    const loaded = {
      ...await vite.ssrLoadModule("/features/mochlik/scene.ts"),
      ...await vite.ssrLoadModule("/features/world/scene/map-engine.ts"),
      ...await vite.ssrLoadModule("/features/world/scene/art.ts"),
      ...await vite.ssrLoadModule("/features/world/scene/presentation.ts"),
      ...await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts"),
      ...await vite.ssrLoadModule("/features/world/dev/world-lighting-editor-store.ts"),
      ...await vite.ssrLoadModule("/features/world/dev/world-lighting-editor-map.ts"),
      ...await vite.ssrLoadModule("/features/world/dev/world-studio-keyboard.ts"),
      ...await vite.ssrLoadModule("/features/mochlik/pixel-sprite.ts"),
      ...await vite.ssrLoadModule("/features/world/state/forest-session.ts"),
      ...await vite.ssrLoadModule("/features/world/tiled/preview-state.ts"),
      ...await vite.ssrLoadModule("/features/world/navigation/navigation.ts"),
      ...await vite.ssrLoadModule("/features/world/simulation/clearing-activity.ts"),
      ...await vite.ssrLoadModule("/features/world/navigation/resident-traffic.ts"),
      ...await vite.ssrLoadModule("/features/world/scene/new-map-scene.ts"),
      ...await vite.ssrLoadModule("/features/world/characters/social/forest-conversations.ts"),
      ...await vite.ssrLoadModule("/features/audio/runtime/audio-service.ts"),
      ...await vite.ssrLoadModule("/features/world/state/economy/economy-scene-state.ts"),
      ...await vite.ssrLoadModule("/features/world/state/economy/economy-production-state.ts"),
      ...await vite.ssrLoadModule("/features/world/state/forest-observer.ts"),
      ...await vite.ssrLoadModule("/features/activity/transport-state.ts"),
      ...await vite.ssrLoadModule("/features/world/activities/journeys/forest-journey-travel.ts"),
      ...await vite.ssrLoadModule("/features/world/activities/fishing/forest-fishing-painter.ts"),
      ...await vite.ssrLoadModule("/features/world/dev/forest-cooking-preview.ts"),
      ...await vite.ssrLoadModule("/features/world/characters/builder/builder-sprite.ts"),
      ...await vite.ssrLoadModule("/features/world/characters/builder/builder-mind.ts"),
      ...await vite.ssrLoadModule("/features/world/characters/builder/builder-navigation.ts"),
      ...await vite.ssrLoadModule("/lib/check-in-api.ts"),
    };
    builderRigForHero.set(loaded.pixelSprite, loaded.builderSpriteRig);
    return loaded;
  } finally { await vite.close(); }
}

function browser() {
  const saved = new Map(), pending = [], requests = [], timers = new Map(), frames = new Map(), observers = [];
  const displayedCalls = [];
  const documentEvents = new Map();
  let id = 0, frameTime = 0;
  const install = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  function surface(width = 320, height = width, offscreen = false) {
    const calls = [], events = new Map(), captured = new Set();
    if (!offscreen) displayedCalls.push(calls);
    const context = new Proxy({
      createRadialGradient: () => ({ addColorStop() {} }),
      createLinearGradient: () => ({ addColorStop() {} }),
      getTransform: () => undefined,
      measureText: text => ({ width: String(text).length * 6 }),
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
  install("document", { hidden: false, createElement: () => surface(320, 320, true),
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
      // Disposed Vite graphs can retain a fake canvas through sprite/session
      // closures. Large frame histories have no meaning after this browser
      // ends; keep only reusable offscreen sprite recordings intact.
      displayedCalls.forEach(calls => { calls.length = 0; });
      pending.length = 0; requests.length = 0; timers.clear(); frames.clear(); documentEvents.clear();
      observers.forEach(observer => observer.nodes.clear()); observers.length = 0;
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    },
  };
}

function mapProjection(canvas, width = fixture.width, height = fixture.height) {
  // Screen-space speech resets its transform after the world. Read the entire
  // most recent draw, so overlays cannot replace the camera's projection.
  const frameStart = canvas.calls.findLastIndex(call => call.method === "fillRect"
    && call.args[0] === 0 && call.args[1] === 0
    && call.args[2] === canvas.clientWidth && call.args[3] === canvas.clientHeight);
  assert.ok(frameStart >= 0, "the map painted its viewport background");
  const frame = canvas.calls.slice(frameStart);
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

function waterPointer(canvas, point, pointerId = 1) {
  const projection = mapProjection(canvas);
  return { pointerId, pointerType: "touch", button: 0,
    clientX: projection.left + point.x * projection.zoom, clientY: projection.top + point.y * projection.zoom };
}

const sendWaterPointer = (target, type, point) => target.events.get(type)({ ...point, type });

const waterRectangle = (x, y, width, height = width) => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];
const waterPhysicsFixture = () => ({ water: {
  surfaces: [{ id: "test-river", points: waterRectangle(900, 900, 200) }],
  exclusions: [{ id: "test-dry-island", points: waterRectangle(945, 945, 30) }],
} });
const waterEnergy = state => state ? [...state.heights, ...state.velocities].reduce((sum, value) => sum + value * value, 0) : 0;

const approximately = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} ≈ ${expected}`);

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
function distanceToContour(point, points) {
  return Math.min(...points.map((a, index) => {
    const b = points[(index + 1) % points.length], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return distanceBetween(point, { x: a.x + dx * t, y: a.y + dy * t });
  }));
}
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

const fishingFixture = () => ({
  navigation: livingNavigation,
  destinations: [{ id: "fishing", position: { x: 690, y: 700 }, pauseSeconds: 15 }],
  water: { surfaces: [{ id: "river", points: [{ x: 705, y: 660 }, { x: 800, y: 660 },
    { x: 800, y: 760 }, { x: 705, y: 760 }] }], exclusions: [] },
  occluders: [],
});

const builderFixture = () => ({
  ...residentFixture(),
  // Keep the workshop's exterior work bay distinct from the merchant's fixed
  // stop; the old tiny fixture placed those two activities only 37px apart.
  destinations: residentFixture().destinations.map(destination => ({ ...destination,
    position: { ...destination.position, y: 720 } })),
  sites: [{ id: "workshop", label: "Мастерская", initialLevel: 1,
    bounds: { x: 600, y: 620, width: 40, height: 35 }, anchor: { x: 620, y: 648 }, entry: { x: 620, y: 670 },
    hitArea: [{ x: 600, y: 620 }, { x: 640, y: 620 }, { x: 640, y: 655 }, { x: 600, y: 655 }],
    collision: [{ x: 602, y: 633 }, { x: 638, y: 633 }, { x: 638, y: 650 }, { x: 602, y: 650 }],
    states: [{ level: 1, label: "Мастерская", image: "/test-builder-workshop.webp" }] }],
});
const builderHomeFixture = () => ({ id: "builder-home", label: "Дом Шишколапа", initialLevel: 1,
  bounds: { x: 660, y: 615, width: 50, height: 45 }, anchor: { x: 685, y: 655 },
  entry: { x: 685, y: 680 }, doorway: { x: 685, y: 648 },
  hitArea: [{ x: 660, y: 615 }, { x: 710, y: 615 }, { x: 710, y: 660 }, { x: 660, y: 660 }],
  collision: [{ x: 665, y: 627 }, { x: 705, y: 627 }, { x: 705, y: 657 }, { x: 665, y: 657 }],
  states: [{ level: 1, label: "Дом Шишколапа", image: "/test-builder-home.webp" }],
});
const confirmedConstruction = (ownerPublicId, revision = 1, jobs) => ({ ownerPublicId, revision,
  jobs: jobs ?? [{ id: "confirmed-workshop", stationId: "workshop", targetLevel: 2,
    startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() }],
});

function builderMemoryServer(owner, ApiError) {
  let now = 100_000, serial = 0, revision = 0, holder = null, token = null, snapshot = null, holdReads = false;
  const timers = new Map(), receipts = new Map(), reads = [];
  const uuid = () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, "0")}`;
  const view = client => ({ ownerPublicId: owner, revision, snapshot: structuredClone(snapshot),
    serverTime: new Date(now).toISOString(), updatedAt: null,
    lease: { owned: holder === client, token: holder === client ? token : null,
      expiresAt: holder ? new Date(now + 90_000).toISOString() : null } });
  const reject = code => { throw new ApiError(code, 409, { code, message: code }); };
  const environment = { now: () => now, randomUUID: uuid,
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  const transport = {
    async read(_owner, client) {
      if (holdReads) await new Promise(resolve => reads.push(resolve));
      return view(client);
    },
    async command(command) {
      if (receipts.has(command.requestId)) return { ...structuredClone(receipts.get(command.requestId)), replayed: true };
      if (command.expectedRevision !== revision) reject("FOREST_MEMORY_REVISION_CONFLICT");
      if (command.action === "acquire") {
        if (holder && holder !== command.clientId) reject("FOREST_MEMORY_ACTIVE_ELSEWHERE");
        holder = command.clientId; token = uuid();
      } else {
        if (holder !== command.clientId || token !== command.leaseToken) reject("FOREST_MEMORY_LEASE_LOST");
        if (command.action === "save") snapshot = structuredClone(command.snapshot);
        else { holder = null; token = null; }
      }
      revision++;
      const result = { state: view(command.clientId), acceptedRevision: revision, replayed: false };
      receipts.set(command.requestId, structuredClone(result)); return result;
    },
  };
  return {
    environment, transport, now: () => now, snapshot: () => structuredClone(snapshot),
    refence() { holder = null; token = null; revision++; },
    holdReads() { holdReads = true; },
    releaseReads() { holdReads = false; reads.splice(0).forEach(resolve => resolve()); },
    async pump(ms = 0) {
      const until = now + ms;
      for (let limit = 0; ; limit++) {
        assert.ok(limit < 100, "the real memory lease converges without a request loop"); await flush();
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = until; await flush();
    },
  };
}

function treeTouchFixture() {
  return { ...fixture, treeInteractions: [
    { id: "test-crown-touch", frontY: 690, points: waterRectangle(770, 560, 90, 90) },
  ], occluders: [
    { id: "test-canopy", frontY: 690, points: waterRectangle(890, 560, 70, 70) },
    { id: "test-boulder", frontY: 690, points: waterRectangle(890, 560, 70, 70) },
  ] };
}

const studioFocusLayouts = [
  { name: "right panel", view: { width: 1000, height: 700 }, panel: { left: 680, top: 0, width: 320, height: 700 },
    point: { x: 800, y: 650 }, check: point => assert.ok(point.x > 250 && point.x < 420, "focus centers to the left of a right panel") },
  { name: "left panel", view: { width: 1000, height: 700 }, panel: { left: 12, top: 0, width: 300, height: 700 },
    point: { x: 800, y: 650 }, check: point => assert.ok(point.x > 570 && point.x < 740, "focus centers to the right of a left panel") },
  { name: "left panel near the map edge", view: { width: 1000, height: 700 }, panel: { left: 12, top: 0, width: 300, height: 700 },
    point: { x: 20, y: 650 }, check: point => assert.ok(point.x > 328 && point.x < 980, "world clamping keeps an edge target outside the left panel") },
  { name: "bottom panel near the map edge", view: { width: 430, height: 800 }, panel: { left: 0, top: 540, width: 430, height: 260 },
    point: { x: 630, y: 1234 }, check: point => assert.ok(point.y > 16 && point.y < 524, "world clamping keeps an edge target above the bottom panel") },
  { name: "outliner, inspector and toolbar", view: { width: 1200, height: 800 }, panels: [
    { left: 0, top: 90, width: 300, height: 710 }, { left: 880, top: 90, width: 320, height: 710 }, { left: 0, top: 0, width: 1200, height: 90 }],
    point: { x: 800, y: 650 }, check: point => assert.ok(point.x > 316 && point.x < 864 && point.y > 106 && point.y < 784, "focus stays between both side panels below toolbar") },
  { name: "two panels near the map edge", view: { width: 1200, height: 800 }, panels: [
    { left: 0, top: 0, width: 300, height: 800 }, { left: 880, top: 0, width: 320, height: 800 }],
    point: { x: 20, y: 20 }, check: point => assert.ok(point.x > 316 && point.x < 864 && point.y > 16 && point.y < 784, "edge clamp preserves the gap between side panels") },
];

// Small authored exteriors keep these integration checks independent of the
// production map's travel distance while exercising the real shared runtime.
const compactVillagerFixture = () => {
  const polygon = (x, y, width, height) => [{ x, y }, { x: x + width, y },
    { x: x + width, y: y + height }, { x, y: y + height }];
  const site = (id, x, y, initialLevel = 1) => ({ id, label: id, initialLevel,
    bounds: { x: x - 30, y: y - 40, width: 60, height: 45 }, anchor: { x, y }, entry: { x, y: y + 25 },
    doorway: { x, y: y - 4 }, collision: polygon(x - 24, y - 15, 48, 20), hitArea: polygon(x - 30, y - 40, 60, 45),
    states: (id === "quarry" ? [0, 1] : [1]).map(level => ({ level, label: id,
      image: `/test-villager-${id}-${level}.webp` })) });
  return { sites: [site("lopukh-home", 500, 730), site("quarry", 730, 420, 0), site("leaftail-caravan", 830, 710)],
    navigation: { version: 1, cellSize: 10,
      areas: [{ id: "villager-ground", points: polygon(400, 240, 520, 620) }],
      obstacles: [{ id: "north-stone", points: polygon(625, 315, 55, 55) }], interests: [] },
    destinations: [{ id: "quarry", siteId: "quarry", position: { x: 730, y: 445 }, pauseSeconds: 15 }],
    water: { surfaces: [], exclusions: [] }, occluders: [], mushrooms: [] };
};
const confirmedVillagers = (ownerPublicId, revision = 1, quarry = 1, jobs = []) => ({ ownerPublicId, revision,
  buildings: { quarry }, production: { ownerPublicId, revision, jobs } });
async function finishVillagerArtwork(env) {
  for (let pass = 0; pass < 4; pass++) { while (env.pending.length) env.finish(); await flush(); }
}
export {
  approximately,
  browser,
  builderFixture,
  builderHomeFixture,
  builderMemoryServer,
  bushMask,
  bushParticleDraws,
  circlePoint,
  clearingBush,
  clearingBushPath,
  clearingHome,
  clearingHomePath,
  clearingPath,
  compactVillagerFixture,
  confirmedConstruction,
  confirmedVillagers,
  distanceBetween,
  distanceToContour,
  dragMap,
  finishVillagerArtwork,
  fishingFixture,
  fixture,
  flush,
  livingHabitats,
  livingNavigation,
  mapProjection,
  modules,
  options,
  productionSite,
  quietClearing,
  residentFixture,
  sampleFishingHero,
  sampleHero,
  sceneClock,
  sendWaterPointer,
  sourceAndDestination,
  studioFocusLayouts,
  tradingFixture,
  treeTouchFixture,
  waterEnergy,
  waterPhysicsFixture,
  waterPointer,
  waterRectangle
};
