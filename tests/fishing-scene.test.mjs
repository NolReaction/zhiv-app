import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "scene-lifecycle-painter-probe", enforce: "pre", transform(code, id) {
    if (id.endsWith("/fishing-scene-runtime.ts")) return code.replace('import { paintFishingScene } from "./fishing-scene-painter";',
      'function paintFishingScene(ctx,frame,images,viewport,visual){globalThis.__fishingScenePaints.push({frame,images:[...images.keys()],viewport:{...viewport},visual:{...visual}})}');
  } }],
});
after(() => vite.close());
const { fishingSceneGeometry, paintFishingScene } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-painter.ts");
const { mountFishingScene } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-runtime.ts");
const { FishingSceneCanvas } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-canvas.tsx");
const { BOAT_ART_PARTS } = await vite.ssrLoadModule("/features/world/objects/fishing-boat/fishing-boat-artwork.ts");
const { FISHING_WATER_TEXTURE } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-background.ts");
const frame = () => ({ stage: "reeling", castKey: "cast-one", held: false, reel: { bar: 5000, fish: 5500, progress: 2500, zoneWidth: 3200 },
  boat: { repaired: true, upgrades: ["crate", "oars"] }, rodId: "brook_rod" });
const visual = { elapsed: 2, castElapsed: 2, stageElapsed: 2, still: true };

function environment() {
  const saved = new Map(), frames = new Map(), requests = [], observers = [], paints = [];
  let serial = 0, now = 0, rect = { width: 390, height: 844 };
  function install(key, value) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  function target() {
    const handlers = new Map();
    return { handlers, addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
      removeEventListener(name, fn) { handlers.get(name)?.delete(fn); }, dispatch(name, event = {}) { for (const fn of handlers.get(name) ?? []) fn(event); } };
  }
  const calls = [], gradient = { addColorStop() {} };
  const context = new Proxy({}, { get(object, key) { if (key in object) return object[key];
    if (key === "createLinearGradient" || key === "createRadialGradient") return () => gradient;
    return (...args) => calls.push({ method: key, args }); } });
  const document = { ...target(), hidden: false, createElement() { return { width: 48, height: 48, getContext: () => context }; } };
  const media = { ...target(), matches: false };
  const window = { ...target(), devicePixelRatio: 3, matchMedia: () => media };
  const canvas = { ...target(), width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => rect };
  install("document", document); install("window", window); install("__fishingScenePaints", paints);
  install("requestAnimationFrame", callback => { frames.set(++serial, callback); return serial; });
  install("cancelAnimationFrame", id => frames.delete(id));
  install("Image", class { naturalWidth = 1536; naturalHeight = 1024; set src(value) { this.path = value; if (value) requests.push(this); } get src() { return this.path; } });
  for (const name of ["ResizeObserver", "IntersectionObserver"]) install(name, class {
    constructor(callback) { this.callback = callback; this.name = name; this.disconnected = false; observers.push(this); }
    observe() {} disconnect() { this.disconnected = true; }
  });
  return { canvas, context, calls, frames, requests, paints, observers, window, document, media,
    step(milliseconds = 34) { now += milliseconds; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(now)); },
    visibility(hidden) { document.hidden = hidden; document.dispatch("visibilitychange"); },
    intersect(visible) { observers.find(item => item.name === "IntersectionObserver").callback([{ target: canvas, isIntersecting: visible }]); },
    reduced(value) { media.matches = value; media.dispatch("change"); },
    resize(width, height) { rect = { width, height }; observers.find(item => item.name === "ResizeObserver").callback(); },
    finish(path, error = false) { const image = requests.findLast(item => item.path === path); assert.ok(image); if (error) image.onerror?.(); else image.onload?.(); return image; },
    restore() { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } },
  };
}

test("authored boat, hands and surface controls fit portrait and landscape above the control HUD", () => {
  for (const [width, height] of [[320, 568], [390, 844], [820, 375], [820, 390], [1280, 720], [1600, 900]]) {
    const value = frame(), before = structuredClone(value), g = fishingSceneGeometry(width, height, value, visual);
    assert.deepEqual(value, before);
    assert.ok(g.boat.x >= 0 && g.boat.x + 1000 * g.boat.scale <= g.width);
    assert.ok(920 * g.boat.scale * g.scale >= Math.min(width * .26, 170), "the modular boat remains legible at 320px");
    assert.ok(g.hook.y >= g.waterTop && g.hook.y <= g.waterBottom);
    assert.ok(g.fish.y >= g.waterTop && g.fish.y <= g.waterBottom);
    const hud = height < 500 && width > height ? 185 : width < 700 ? 280 : 260;
    assert.ok(g.waterBottom * g.scale <= height - hud, "the depth range stays above the floating controls");
    assert.ok(g.actor.foot.y > g.actor.size && g.actor.foot.x < g.grip.x);
    for (const end of [0, 10000]) {
      const endpoint = fishingSceneGeometry(width, height, { ...value, reel: { ...value.reel, bar: end, fish: end } }, visual);
      assert.ok(endpoint.float.y * endpoint.scale <= height - hud - 24 + 1e-8, "low float endpoint clears the full feedback HUD");
      assert.ok(endpoint.fish.y * endpoint.scale >= 68 - 1e-8, "high fish endpoint clears the landscape header");
    }
  }
});

test("public reel controls move the surface float, fish shadow, pull and rod tension without inventing a catch", () => {
  const value = frame(), base = fishingSceneGeometry(390, 844, value, visual);
  const raised = fishingSceneGeometry(390, 844, { ...value, held: true, reel: { ...value.reel, bar: 9000, fish: 1000, progress: 8500 } }, visual);
  assert.ok(raised.hook.y < base.hook.y); assert.ok(raised.fish.y > base.fish.y);
  assert.ok(raised.hook.x < base.hook.x); assert.ok(raised.tension > base.tension); assert.notDeepEqual(raised.tip, base.tip);
  assert.deepEqual(base.float, base.hook, "the landed float is the controlled position, not a detached decoration");
  assert.deepEqual(raised.float, raised.hook);
  assert.deepEqual(raised.grip, base.grip, "the hand is the rod pivot, not a floating independent prop");
  const stopped = fishingSceneGeometry(390, 844, value, { ...visual, still: true, elapsed: 1000 });
  assert.deepEqual([stopped.boat, stopped.tip, stopped.float, stopped.hook, stopped.fish, stopped.zone],
    [base.boat, base.tip, base.float, base.hook, base.fish, base.zone], "reduced motion retains a stable pose while controls remain public inputs");
  const airborne = fishingSceneGeometry(390, 844, value, { ...visual, still: false, castElapsed: .6 });
  const landed = fishingSceneGeometry(390, 844, value, { ...visual, still: false, castElapsed: 2 });
  assert.ok(airborne.casting); assert.ok(airborne.float.y < airborne.surface); assert.equal(landed.casting, false);
});

test("painting composes real hull modules around Mochlik and never substitutes a procedural boat", () => {
  const env = environment();
  try {
    const images = new Map(["repair", "crate", "oars"].map(id => [BOAT_ART_PARTS[id].src, { id, naturalWidth: 1536, naturalHeight: 1024 }]));
    paintFishingScene(env.context, frame(), images, { width: 390, height: 844, dpr: 2 }, visual);
    const draws = env.calls.filter(call => call.method === "drawImage");
    assert.deepEqual(draws.map(call => call.args[0].id ?? "mochlik"), ["repair", "crate", "mochlik", "repair", "oars"]);
    assert.deepEqual(draws[0].args.slice(1, 5), [...BOAT_ART_PARTS.repair.crop]);
    assert.ok(env.calls.some(call => call.method === "clip"), "front planks occlude the seated feet");
    env.calls.length = 0; paintFishingScene(env.context, frame(), new Map(), { width: 320, height: 568, dpr: 1 }, visual);
    assert.equal(env.calls.some(call => call.method === "drawImage"), false, "missing hull art does not leave a floating actor or drawn replacement hull");
  } finally { env.restore(); }
});

test("the visible surface zone matches domain membership even at both control limits", () => {
  for (const bar of [0, 700, 5000, 9400, 10000]) for (const fish of [0, 1000, 2000, 5000, 8000, 9000, 10000]) {
    const value = frame(); value.reel.bar = bar; value.reel.fish = fish;
    const g = fishingSceneGeometry(390, 844, value, visual);
    const inBand = g.fish.y >= g.zone.y - 1e-8 && g.fish.y <= g.zone.y + g.zone.height + 1e-8;
    assert.equal(inBand, g.aligned, `fish=${fish}, bar=${bar}`);
  }
});

test("canvas runtime caps DPR/frame rate, pauses offscreen and cleans up late image completions", () => {
  const env = environment(), value = { ...frame(), stage: "waiting" }, runtime = mountFishingScene(env.canvas, value);
  try {
    assert.equal(env.canvas.width, 780); assert.equal(env.canvas.height, 1688);
    assert.deepEqual(env.requests.map(image => image.path).sort(), [...["hull.webp", "module-crate.webp", "module-oars.webp"].map(name => "/world/boat/" + name), FISHING_WATER_TEXTURE].sort());
    for (let i = 0; i < 61; i++) env.step(1000 / 60);
    assert.ok(env.paints.length >= 28 && env.paints.length <= 32, "visible painting averages at most 30fps rather than following every RAF");
    const age = env.paints.at(-1).visual.castElapsed, count = env.paints.length;
    env.visibility(true); assert.equal(env.frames.size, 0); env.step(5000); assert.equal(env.paints.length, count);
    env.visibility(false); env.step(); assert.ok(Math.abs(env.paints.at(-1).visual.castElapsed - age) <= 1 / 30,
      "hidden time cannot fast-forward a cast; the last unpainted RAF may add one frame");
    env.intersect(false); assert.equal(env.frames.size, 0); env.intersect(true); env.step();
    env.reduced(true); assert.equal(env.frames.size, 0); assert.equal(env.paints.at(-1).visual.still, true);
    const staticCount = env.paints.length; env.finish("/world/boat/hull.webp"); assert.ok(env.paints.length > staticCount, "image arrival redraws a static scene");
    env.finish("/world/boat/module-crate.webp", true); const failedCount = env.requests.length;
    env.window.dispatch("online"); assert.equal(env.requests.length, failedCount + 1, "a failed part retries only on an explicit recovery event");
    env.resize(320, 568); assert.equal(env.canvas.width, 640); assert.equal(env.canvas.height, 1136);
    const late = env.requests.find(image => image.path.endsWith("module-oars.webp")).onload;
    runtime.dispose(); const disposedCount = env.paints.length; late(); env.step(1000);
    assert.equal(env.frames.size, 0); assert.equal(env.paints.length, disposedCount); assert.ok(env.observers.every(observer => observer.disconnected));
    assert.ok([...env.document.handlers.values(), ...env.window.handlers.values(), ...env.canvas.handlers.values(), ...env.media.handlers.values()].every(handlers => handlers.size === 0));
  } finally { runtime.dispose(); env.restore(); }
});

test("a repeated cast key does not replay; pause, reduced motion and settled outcomes have no endless RAF", () => {
  const env = environment(), value = frame(), runtime = mountFishingScene(env.canvas, value);
  try {
    for (let i = 0; i < 12; i++) env.step(100);
    const age = env.paints.at(-1).visual.castElapsed;
    runtime.update({ ...value, held: true }); env.step(50); assert.ok(env.paints.at(-1).visual.castElapsed >= age);
    runtime.update({ ...value, stage: "paused" }); assert.equal(env.frames.size, 0); const pausedAge = env.paints.at(-1).visual.castElapsed;
    env.step(3000); runtime.update(value); env.step(); assert.equal(env.paints.at(-1).visual.castElapsed, pausedAge);
    runtime.update({ ...value, castKey: "cast-two" }); env.step(34); assert.ok(env.paints.at(-1).visual.castElapsed < .1);
    runtime.update({ ...value, castKey: "cast-one" }); env.step(34); assert.ok(env.paints.at(-1).visual.castElapsed > 0, "an old key remains seen");
    runtime.update({ ...value, stage: "caught" }); for (let i = 0; i < 25; i++) env.step(100); assert.equal(env.frames.size, 0);
    runtime.update({ ...value, stage: "pending" }); assert.equal(env.frames.size, 0);
    runtime.update({ ...value, stage: "expired" }); assert.equal(env.frames.size, 0);
    const html = renderToStaticMarkup(createElement(FishingSceneCanvas, { frame: value, className: "fishingViewport" }));
    assert.match(html, /<canvas[^>]+class="fishingViewport"/); assert.match(html, /aria-hidden="true"/);
    assert.doesNotMatch(html, /<button|<img|<svg/);
  } finally { runtime.dispose(); env.restore(); }
});
