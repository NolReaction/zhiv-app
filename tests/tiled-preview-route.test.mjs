import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createPreviewRoute } = await vite.ssrLoadModule("/features/world/tiled/preview-route.ts");
const { createFixedWorldRenderer } = await vite.ssrLoadModule("/features/world/tiled/renderer.ts");

const scene = {
  schemaVersion: 1, id: "route-test", width: 500, height: 500, terrain: [], sites: [],
  actor: { spawn: { x: 250, y: 300 }, size: 36 }, focus: { x: 200, y: 200, width: 100, height: 100 },
  paths: [
    { id: "river-bank", points: [{ x: 20, y: 20 }, { x: 124, y: 20 }, { x: 124, y: 124 }] },
    { id: "forest-edge", points: [{ x: 350, y: 350 }, { x: 454, y: 350 }] },
  ],
};
const position = route => { const { x, y } = route.at(0, true); return { x, y }; };

test("authored actor stands at spawn before selection and after reset, including maps without routes", () => {
  for (const paths of [scene.paths, []]) {
    const route = createPreviewRoute({ ...scene, paths });
    assert.deepEqual(position(route), scene.actor.spawn);
    assert.deepEqual(route.status(), { pathId: null, moving: false, error: null });
    assert.equal(route.start(false), false);
    assert.equal(route.reverse(false), false);
  }
  const route = createPreviewRoute(scene);
  route.select("river-bank"); route.start(false); route.advance(1); route.reset();
  assert.deepEqual(position(route), scene.actor.spawn);
  assert.equal(route.status().pathId, null);
  assert.equal(route.moving(), false);
});

test("any authored line can be selected; selection never starts walking or connects routes", () => {
  const route = createPreviewRoute(scene);
  assert.deepEqual(route.choices.map(path => path.id), ["river-bank", "forest-edge"]);
  assert.equal(route.select("river-bank"), true);
  assert.deepEqual(position(route), { x: 20, y: 20 });
  route.advance(20);
  assert.deepEqual(position(route), { x: 20, y: 20 });
  assert.equal(route.start(false), true);
  route.advance(1);
  assert.deepEqual(position(route), { x: 72, y: 20 });
  route.advance(2);
  assert.deepEqual(position(route), { x: 124, y: 72 }, "movement follows the corner instead of a diagonal shortcut");
  assert.equal(route.select("forest-edge"), true);
  assert.deepEqual(position(route), { x: 350, y: 350 });
  assert.equal(route.moving(), false);
  assert.equal(route.start(false), true);
  route.advance(1);
  assert.deepEqual(position(route), { x: 402, y: 350 });
});

test("reversal uses the current line position, can reverse again, and never overshoots an endpoint", () => {
  const route = createPreviewRoute(scene);
  route.select("river-bank"); route.start(false); route.advance(3);
  assert.equal(route.reverse(false), true);
  assert.deepEqual(position(route), { x: 124, y: 72 });
  route.advance(1);
  assert.deepEqual(position(route), { x: 124, y: 20 });
  assert.equal(route.at(1, true).direction, "left");
  route.reverse(false); route.advance(100);
  assert.deepEqual(position(route), { x: 124, y: 124 });
  assert.equal(route.moving(), false);
  route.start(false); route.advance(1);
  assert.deepEqual(position(route), { x: 72, y: 20 }, "start can replay a completed route");
});

test("instant playback and settling reach the requested endpoint without animated frames", () => {
  const route = createPreviewRoute(scene);
  route.select("river-bank"); route.start(true);
  assert.deepEqual(position(route), { x: 124, y: 124 });
  assert.equal(route.moving(), false);
  route.reverse(true);
  assert.deepEqual(position(route), { x: 20, y: 20 });
  route.start(false); route.advance(1); route.settle();
  assert.deepEqual(position(route), { x: 124, y: 124 });
  assert.equal(route.at(2, false).walking, false);
  assert.equal(route.at(2, false).frame, 0);
});

test("invalid, out-of-bounds and colliding routes stay disabled at spawn", () => {
  const collision = [{ x: 70, y: 30 }, { x: 80, y: 30 }, { x: 80, y: 80 }, { x: 70, y: 80 }];
  const invalid = [
    { id: "empty", points: [] },
    { id: "point", points: [{ x: 10, y: 10 }] },
    { id: "zero", points: [{ x: 10, y: 10 }, { x: 10, y: 10 }] },
    { id: "outside", points: [{ x: 20, y: 20 }, { x: 520, y: 20 }] },
    { id: "not-finite", points: [{ x: 20, y: 20 }, { x: NaN, y: 20 }] },
    { id: "across-building", points: [{ x: 20, y: 50 }, { x: 120, y: 50 }] },
    { id: "clipped-feet", points: [{ x: 20, y: 26 }, { x: 120, y: 26 }] },
  ];
  const route = createPreviewRoute({ ...scene, paths: invalid, sites: [{ id: "obstacle", collision }] });
  for (const { id } of [...invalid, { id: "unknown" }]) {
    assert.equal(route.select(id), false, id);
    assert.ok(route.status().error, id);
    assert.equal(route.start(false), false, id);
    assert.equal(route.reverse(true), false, id);
    route.advance(100);
    assert.deepEqual(position(route), scene.actor.spawn, id);
  }
});

test("duplicate vertices and invalid elapsed values cannot break route sampling", () => {
  const route = createPreviewRoute({ ...scene, paths: [{ id: "duplicates", points: [{ x: 20, y: 20 }, { x: 20, y: 20 }, { x: 124, y: 20 }, { x: 124, y: 20 }] }] });
  route.select("duplicates"); route.start(false);
  for (const time of [NaN, Infinity, -100]) route.advance(time);
  assert.deepEqual(position(route), { x: 20, y: 20 });
  route.advance(100);
  assert.deepEqual(position(route), { x: 124, y: 20 });
});

test("legacy home-walk calls still travel between the home endpoint and the other endpoint", () => {
  const route = createPreviewRoute({ ...scene, actor: undefined, sites: [{ id: "home", entry: { x: 124, y: 20 }, collision: [] }],
    paths: [{ id: "home-walk", points: [{ x: 20, y: 20 }, { x: 124, y: 20 }] }] });
  assert.equal(route.walkTo("unknown", false), false);
  assert.deepEqual(position(route), { x: 124, y: 20 });
  assert.equal(route.stroll(false), true);
  route.advance(1);
  assert.deepEqual(position(route), { x: 72, y: 20 });
  assert.equal(route.walkTo("home", true), true);
  assert.deepEqual(position(route), { x: 124, y: 20 });
});

function canvasEnvironment(t) {
  const frames = new Map(); let nextFrame = 0;
  const context = () => {
    const calls = [];
    return new Proxy({ calls, drawImage() {}, createRadialGradient: () => ({ addColorStop() {} }),
      bezierCurveTo: (...args) => calls.push({ method: "bezierCurveTo", args }),
    }, { get: (target, key) => key in target ? target[key] : () => {} });
  };
  class Canvas extends EventTarget {
    width = 100; height = 100; clientWidth = 100; clientHeight = 100;
    dataset = {}; style = {}; context = context();
    getContext() { return this.context; }
    getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100 }; }
    hasPointerCapture() { return false; }
  }
  const document = Object.assign(new EventTarget(), { hidden: false, createElement: () => new Canvas() });
  class Observer { observe() {} disconnect() {} }
  const replacements = {
    document, window: { devicePixelRatio: 1 }, ResizeObserver: Observer, IntersectionObserver: Observer,
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  for (const [key, value] of Object.entries(replacements)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  return { world: new Canvas(), circle: new Canvas(), frames, tick(now) {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now));
  } };
}
const options = { levels: {}, night: false, debug: false, selectedSiteId: null, reducedMotion: false };

test("renderer stays idle by default, settles on reduced motion, and cancels pending animation on reset/dispose", async t => {
  const env = canvasEnvironment(t), statuses = [];
  const renderer = await createFixedWorldRenderer(env.world, env.circle, scene, options, { onRouteChange: value => statuses.push(value) });
  assert.equal(env.frames.size, 0);
  assert.equal(env.world.dataset.actorX, "250");
  assert.equal(env.world.dataset.actorY, "300");
  assert.equal(env.world.dataset.actorSize, "36");
  renderer.selectPath("river-bank");
  assert.equal(env.frames.size, 0);
  renderer.startPath(); env.tick(100); env.tick(180);
  assert.ok(Number(env.world.dataset.actorX) > 20);
  assert.equal(env.circle.dataset.actorX, env.world.dataset.actorX);
  renderer.update({ ...options, reducedMotion: true });
  assert.equal(env.frames.size, 0);
  assert.equal(env.world.dataset.actorX, "124");
  assert.equal(env.world.dataset.actorY, "124");
  assert.equal(env.world.dataset.actorMoving, "false");
  renderer.reversePath();
  assert.equal(env.world.dataset.actorX, "20");
  assert.equal(env.world.dataset.actorY, "20");
  renderer.update(options); renderer.startPath();
  assert.equal(env.frames.size, 1);
  renderer.resetPath();
  assert.equal(env.frames.size, 0);
  assert.equal(env.world.dataset.actorX, "250");
  assert.equal(env.world.dataset.pathId, "");
  renderer.selectPath("forest-edge"); renderer.startPath();
  const lateCallback = [...env.frames.values()][0], frame = env.world.dataset.frame;
  renderer.dispose();
  assert.equal(env.frames.size, 0);
  lateCallback(250);
  assert.equal(env.world.dataset.frame, frame, "an already queued callback cannot draw after disposal");
  assert.equal(renderer.startPath(), false);
  assert.ok(statuses.some(status => status.moving));
  assert.ok(statuses.some(status => !status.moving && status.pathId === null));
});

test("aborting an active preview cancels RAF and its remaining controls", async t => {
  const env = canvasEnvironment(t), controller = new AbortController();
  const renderer = await createFixedWorldRenderer(env.world, env.circle, scene, options, {}, controller.signal);
  renderer.selectPath("river-bank"); renderer.startPath();
  assert.equal(env.frames.size, 1);
  controller.abort();
  assert.equal(env.frames.size, 0);
  assert.equal(renderer.selectPath("forest-edge"), false);
  assert.equal(renderer.reversePath(), false);
});

test("night torches animate while the actor stands still and stop on pause, reduced motion, day or disposal", async t => {
  const env = canvasEnvironment(t);
  const litScene = { ...scene, lights: [{ id: "path-torch", kind: "torch", position: { x: 270, y: 260 },
    radius: 70, intensity: 1, color: "#ffcc88", flicker: .1 }] };
  const renderer = await createFixedWorldRenderer(env.world, env.circle, litScene, options);
  t.after(() => renderer.dispose());
  assert.equal(env.frames.size, 0, "daytime fixtures alone do not keep an animation loop running");
  const night = { ...options, night: true };
  renderer.update(night);
  assert.equal(env.frames.size, 1, "a flickering light starts the night clock without a selected route");
  const flame = canvas => canvas.context.calls.slice(-2).map(call => call.args);
  const initialFlame = flame(env.world), initialFrame = env.world.dataset.frame;
  env.tick(100); env.tick(180);
  assert.notEqual(env.world.dataset.frame, initialFrame);
  assert.notDeepEqual(flame(env.world), initialFlame, "elapsed time changes the flame geometry rather than repainting a frozen torch");
  assert.deepEqual(flame(env.circle), flame(env.world), "both views use the same light animation time");
  assert.equal(env.world.dataset.actorMoving, "false");
  assert.equal(env.world.dataset.actorX, "250");
  assert.equal(env.world.dataset.actorY, "300");
  for (const stopped of [{ ...night, paused: true }, { ...night, reducedMotion: true }, options]) {
    renderer.update(stopped);
    const frame = env.world.dataset.frame, stillFlame = flame(env.world);
    assert.equal(env.frames.size, 0);
    env.tick(500);
    assert.equal(env.world.dataset.frame, frame);
    assert.deepEqual(flame(env.world), stillFlame);
    renderer.update(night);
    assert.equal(env.frames.size, 1, "returning to animated night resumes exactly one clock");
  }
  const lateCallback = [...env.frames.values()][0], finalFrame = env.world.dataset.frame;
  renderer.dispose();
  assert.equal(env.frames.size, 0);
  lateCallback(1000);
  assert.equal(env.world.dataset.frame, finalFrame, "a queued light tick cannot repaint a disposed preview");
});
