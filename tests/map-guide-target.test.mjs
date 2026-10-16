import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { mapGuideCamera, minerArrivalGuideTarget } = await vite.ssrLoadModule("/features/world/scene/map-guide-target.ts");
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
