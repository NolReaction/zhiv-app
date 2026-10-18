import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { mapGuideCamera, minerArrivalGuideTarget, leaftailArrivalGuideTarget, drawMapGuideTarget } = await vite.ssrLoadModule("/features/world/scene/map-guide-target.ts");
const { observeMapGuideInset } = await vite.ssrLoadModule("/features/world/scene/map-guide-inset.ts");
const { worldToScreen } = await vite.ssrLoadModule("/features/world/scene/camera.ts");
const { interactiveMapObjects } = await vite.ssrLoadModule("/features/world/scene/site-interactions.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { default: authored } = await vite.ssrLoadModule("/features/world/tiled/forest.generated.json");

test("miner arrival frames the moving helmet and feet above the coach without changing the quarry", () => {
  const point = { x: 650, y: 250, size: 42 }, before = { ...point };
  for (const view of [{ width: 393, height: 665, top: 120, bottom: 220 }, { width: 1280, height: 900, top: 100, bottom: 250 }]) {
    const target = minerArrivalGuideTarget(point), camera = mapGuideCamera(target, view, authored, view);
    assert.equal(target.place, "quarry"); assert.equal(target.id, "kamneshmyg-arrival");
    for (const corner of target.hitArea) {
      const screen = worldToScreen(corner, camera, view);
      assert.ok(screen.x >= 0 && screen.x <= view.width);
      assert.ok(screen.y >= view.top && screen.y <= view.height - view.bottom);
    }
    assert.deepEqual(point, before);
  }
  for (const bad of [{ ...point, x: NaN }, { ...point, size: 0 }]) assert.equal(minerArrivalGuideTarget(bad), undefined);
});

test("real garden, workshop, orders board and market fit between HUD and coach on phone, landscape and desktop", () => {
  const cases = [
    { width: 320, height: 568, top: 110, bottom: 200 },
    { width: 393, height: 665, top: 120, bottom: 220 },
    { width: 844, height: 390, top: 72, bottom: 130 },
    { width: 1280, height: 900, top: 100, bottom: 250 },
  ];
  for (const level of [0, 1, 2]) {
    const scene = previewWorldScene(authored, { ...initialPreviewLevels(authored), workshop: level });
    for (const place of ["garden", "workshop", "bulletin-board", "market"]) {
      const object = interactiveMapObjects(scene).find(object => object.place === place);
      assert.ok(object);
      for (const view of cases) {
        const camera = mapGuideCamera(object, view, scene, view);
        for (const point of object.hitArea) {
          const screen = worldToScreen(point, camera, view);
          assert.ok(screen.x >= 0 && screen.x <= view.width, `${place} level ${level} fits horizontally at ${view.width}`);
          assert.ok(screen.y >= view.top && screen.y <= view.height - view.bottom,
            `${place} level ${level} stays above the guide at ${view.width}: ${screen.y}`);
        }
      }
    }
  }
});

function paintedGuide(elapsed, reducedMotion = false) {
  const path = [], strokes = [];
  const context = { globalAlpha: .8, saved: null,
    save() { this.saved = this.globalAlpha; }, restore() { this.globalAlpha = this.saved; },
    beginPath() {}, closePath() {}, moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); },
    stroke() { strokes.push({ alpha: this.globalAlpha, width: this.lineWidth, color: this.strokeStyle }); },
  };
  const target = { ...minerArrivalGuideTarget({ x: 650, y: 250, size: 42 }), id: "tutorial-building" };
  const original = structuredClone(target);
  drawMapGuideTarget(context, target, { x: 650, y: 250, zoom: 2 }, { width: 393, height: 665 }, elapsed, reducedMotion);
  assert.deepEqual(target, original, "the authored click and framing geometry is never animated");
  assert.equal(context.globalAlpha, .8, "guide paint restores the caller's canvas state");
  return { path, strokes };
}

test("both new residents keep camera framing without painting an arrival square", () => {
  for (const target of [minerArrivalGuideTarget, leaftailArrivalGuideTarget]) {
    const object = target({ x: 650, y: 250, size: 42 }), original = structuredClone(object);
    assert.ok(object.hitArea.length >= 3);
    assert.ok(mapGuideCamera(object, { width: 393, height: 665 }, authored, { top: 120, bottom: 220 }).zoom > 0);
    for (const still of [false, true]) {
      const context = new Proxy({}, { get() { throw new Error("resident framing must not paint a square"); } });
      drawMapGuideTarget(context, object, { x: 650, y: 250, zoom: 2 }, { width: 393, height: 665 }, 1, still);
      assert.deepEqual(object, original);
    }
  }
});

test("map guide slowly pulses bright paint on the existing active clock with stable geometry", () => {
  const bright = paintedGuide(0), dim = paintedGuide(.9), next = paintedGuide(1.8);
  assert.deepEqual(dim.path, bright.path);
  assert.deepEqual(next, bright, "the slow pulse completes one smooth cycle in 1.8 active seconds");
  assert.deepEqual(dim.strokes.map(stroke => stroke.width), bright.strokes.map(stroke => stroke.width));
  assert.equal(dim.strokes[0].alpha, bright.strokes[0].alpha, "the dark backing stays legible");
  assert.ok(dim.strokes[1].alpha < bright.strokes[1].alpha);
  assert.ok(dim.strokes[1].alpha >= .8 * .5, "the highlighted contour never disappears");
});

test("reduced motion keeps the map guide fully visible and static at any clock value", () => {
  const first = paintedGuide(0, true);
  assert.deepEqual(paintedGuide(.9, true), first);
  assert.deepEqual(paintedGuide(100, true), first);
  assert.ok(first.strokes.every(stroke => stroke.alpha === .8));
});

function observeEnvironment(run) {
  const originals = new Map(), frames = new Map(), observers = []; let id = 0;
  const install = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const name of ["ResizeObserver", "MutationObserver"]) install(name, class {
    nodes = new Map();
    constructor(callback) { this.callback = callback; observers.push(this); this.name = name; }
    observe(node, options) { this.nodes.set(node, options); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); }
  });
  install("requestAnimationFrame", callback => { frames.set(++id, callback); return id; });
  install("cancelAnimationFrame", key => frames.delete(key));
  const world = { coach: null, querySelector() { return this.coach; } };
  const canvas = { clientHeight: 665, getBoundingClientRect: () => ({ bottom: 665, height: 665 }) };
  const notify = (node, kind) => observers.filter(observer => observer.nodes.has(node)
    && (kind === "resize" ? observer.name === "ResizeObserver" : observer.nodes.get(node)?.[kind]))
    .forEach(observer => observer.callback([]));
  const flush = () => { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback()); };
  const card = top => ({ top, getBoundingClientRect() { return { top: this.top, height: 170 }; } });
  try { run({ world, canvas, card, notify, flush, frames, observers }); }
  finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

test("map guide measures late coaches, replacement and same-size position changes after layout", () => observeEnvironment(({ world, canvas, card, notify, flush, frames }) => {
  const values = [], stop = observeMapGuideInset(world, canvas, value => values.push(value));
  try {
    flush(); assert.deepEqual(values, [0]);
    world.coach = card(420); notify(world, "childList");
    flush(); assert.deepEqual(values, [0, 257], "a late mounted card reserves the real occupied space");
    world.coach.top = 350; notify(world.coach, "attributes");
    notify(world.coach, "attributes"); notify(canvas, "resize");
    assert.equal(frames.size, 1, "a burst of style and resize changes shares one measurement");
    flush(); assert.equal(values.at(-1), 327, "top-only CSS positioning needs no resize to update the inset");
    notify(world.coach, "resize"); flush();
    world.coach.top = 300; notify(world.coach, "attributes"); flush();
    assert.deepEqual(values, [0, 257, 327, 377], "position applied after an earlier resize is measured too");
    notify(world, "childList"); assert.equal(frames.size, 0, "unrelated child changes do not schedule layout work");
    const previous = world.coach;
    world.coach = card(460); notify(world, "childList"); flush(); assert.equal(values.at(-1), 217);
    notify(previous, "attributes"); assert.equal(frames.size, 0, "a replaced card no longer affects the camera");
    world.coach = null; notify(world, "childList"); flush(); assert.equal(values.at(-1), 0);
  } finally { stop(); }
}));

test("map guide observer stops pending measurements and all observers when the course pauses", () => observeEnvironment(({ world, canvas, card, notify, flush, frames, observers }) => {
  world.coach = card(400);
  const values = [], stop = observeMapGuideInset(world, canvas, value => values.push(value));
  assert.equal(frames.size, 1); stop();
  assert.equal(frames.size, 0); assert.ok(observers.every(observer => observer.nodes.size === 0));
  notify(world, "childList"); notify(world.coach, "attributes"); notify(canvas, "resize"); flush();
  assert.deepEqual(values, [], "no camera work survives the disposed lesson");
}));

test("a coach mounting during overscan measures the fixed root in local CSS pixels", () => observeEnvironment(({ world, card, notify, flush, frames, observers }) => {
  const surface = { clientHeight: 665, getBoundingClientRect: () => ({ bottom: 600, height: 532 }) };
  const canvas = { clientHeight: 729, getBoundingClientRect() { throw new Error("the moving canvas is not the viewport"); } };
  world.coach = card(400);
  const values = [], stop = observeMapGuideInset(world, surface, value => values.push(value));
  try {
    flush(); assert.deepEqual(values, [262], "account for an ancestor's scale using the root's height");
    assert.ok(observers.some(observer => observer.name === "ResizeObserver" && observer.nodes.has(surface)));
    notify(canvas, "resize"); assert.equal(frames.size, 0, "overscan backing changes do not remeasure the coach");
    world.coach.top = 360; notify(world.coach, "attributes"); flush();
    assert.deepEqual(values, [262, 312], "a moving coach still updates against the same visible area");
    notify(surface, "resize"); flush(); assert.deepEqual(values, [262, 312]);
  } finally { stop(); }
}));
