import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-leaftail-boat-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { leaftailBoatRoute } = await vite.ssrLoadModule("/features/world/characters/leaftail/leaftail-boat-navigation.ts");
const { createLeaftailBoatArrival, configureLeaftailBoatArrival, advanceLeaftailBoatArrival, leaftailBoatArrivalFrame,
  leaftailBoatArrivalOccupant, settleLeaftailBoatArrival } = await vite.ssrLoadModule("/features/world/characters/leaftail/leaftail-boat-arrival.ts");
const { drawLeaftailBoatArrival } = await vite.ssrLoadModule("/features/world/characters/leaftail/leaftail-boat-painter.ts");
const { canTraverse, isWalkable } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { isForestWater } = await vite.ssrLoadModule("/features/world/environment/water/forest-water.ts");
const scene = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), home: 3, quarry: 1 });
const permission = { unlocked: true, confirmed: true, seen: false, allowArrival: true };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const setup = () => { const state = createLeaftailBoatArrival(scene); configureLeaftailBoatArrival(state, scene, permission); return state; };
const live = state => ["sailing", "landing", "walking", "greeting"].includes(state.phase);
function finish(state, env = {}) { for (let i = 0; i < 1000 && live(state); i++) advanceLeaftailBoatArrival(state, .1, env); }

test("actual Tiled supports a water-only boat, explicit supported shore crossing and ordinary path to the caravan", () => {
  const before = JSON.stringify(scene), route = leaftailBoatRoute(scene);
  assert.ok(route); assert.equal(leaftailBoatRoute(scene), route, "water flood is cached per geometry");
  assert.ok(route.sail.length > 300); assert.equal(route.landing.length, 40); assert.ok(route.walk.length > 600);
  assert.ok(route.sail.points[0].y > scene.height - 25, "arrival comes from the map's lower river edge");
  assert.ok(isForestWater(scene, route.dock)); assert.equal(isForestWater(scene, route.land), false);
  for (const path of [route.sail, route.landing, route.walk]) for (let i = 1; i < path.points.length; i++)
    assert.ok(canTraverse(path === route.sail ? route.water : path === route.landing ? route.shore : route.ground, path.points[i - 1], path.points[i]));
  assert.equal(isWalkable(route.ground, route.dock), false, "the boat does not widen everyone's walking area");
  assert.equal(isWalkable(route.ground, route.land), true);
  assert.equal(JSON.stringify(scene), before, "no Water, collisions or authored geometry is changed");
});

test("confirmed unlock plus presentation permission is required; persisted arrival never sails twice", () => {
  for (const patch of [{ unlocked: false }, { confirmed: false }, { allowArrival: false }]) {
    const state = createLeaftailBoatArrival(scene); configureLeaftailBoatArrival(state, scene, { ...permission, ...patch });
    advanceLeaftailBoatArrival(state, .5); assert.equal(state.phase, "waiting"); assert.equal(leaftailBoatArrivalFrame(state), null);
  }
  const state = createLeaftailBoatArrival(scene); configureLeaftailBoatArrival(state, scene, { ...permission, seen: true });
  assert.equal(state.completed, true); assert.equal(leaftailBoatArrivalFrame(state), null); assert.equal(leaftailBoatArrivalOccupant(state), null);
  configureLeaftailBoatArrival(state, scene, permission); assert.equal(state.phase, "complete");
});

test("the full arrival uses continuous feet, finishes the greeting and leaves the exact handoff point", () => {
  const state = setup(), seen = new Set(), before = JSON.stringify(scene); let previousPhase = state.phase;
  for (let i = 0; i < 1000 && live(state); i++) {
    const from = { ...state.position }, phase = state.phase, frame = leaftailBoatArrivalFrame(state), elapsed = state.elapsed;
    assert.deepEqual(leaftailBoatArrivalFrame(state), frame, "multiple camera reads are side-effect free"); assert.equal(state.elapsed, elapsed);
    assert.equal(leaftailBoatArrivalOccupant(state) === null, phase === "sailing", "there are no grounded feet on the river");
    advanceLeaftailBoatArrival(state, .1); seen.add(state.phase);
    assert.ok(distance(from, state.position) <= 4.800001, `${phase}: no teleport or duplicated movement budget`);
    if (state.phase === phase) assert.ok(canTraverse(phase === "sailing" ? state.route.water : phase === "landing" ? state.route.shore : state.route.ground, from, state.position));
    if (state.phase === "walking" && previousPhase !== "walking") assert.ok(distance(state.position, state.route.land) < 4);
    if (phase === "sailing") assert.ok(isForestWater(scene, from));
    if (frame.phase === "greeting") assert.equal(frame.boat.opacity, 0, "the moored boat never pops back at the far-away greeting");
    previousPhase = state.phase;
  }
  for (const phase of ["landing", "walking", "greeting", "complete"]) assert.ok(seen.has(phase));
  assert.equal(state.completed, true); assert.ok(state.elapsed > 25 && state.elapsed < 45);
  assert.deepEqual(state.position, state.route.target); assert.equal(leaftailBoatArrivalFrame(state), null);
  assert.equal(JSON.stringify(scene), before);
});

test("hidden, paused, reduced-motion and inactive views freeze both the boat and its active clock", () => {
  const state = setup(); advanceLeaftailBoatArrival(state, .5);
  for (const env of [{ hidden: true }, { paused: true }, { reducedMotion: true }, { active: false }]) {
    const before = JSON.stringify(state);
    for (let i = 0; i < 600; i++) advanceLeaftailBoatArrival(state, .5, env);
    assert.equal(JSON.stringify(state), before);
  }
  const before = JSON.stringify(state); advanceLeaftailBoatArrival(state, NaN); advanceLeaftailBoatArrival(state, -1); assert.equal(JSON.stringify(state), before);
  assert.equal(settleLeaftailBoatArrival(state), true, "an explicit accessible introduction can settle after confirmed unlock");
  assert.equal(state.completed, true); assert.deepEqual(state.position, state.route.target);
});

test("a resident at the landing is respected and the same route resumes once the bank clears", () => {
  const state = setup();
  while (state.phase === "sailing") advanceLeaftailBoatArrival(state, .1);
  const other = { id: "plesk", position: { ...state.route.land }, size: 43 }, from = { ...state.position };
  for (let i = 0; i < 300; i++) advanceLeaftailBoatArrival(state, .1, { occupants: [other] });
  assert.equal(state.phase, "landing"); assert.match(state.reason, /ждёт/); assert.ok(distance(state.position, other.position) > 24);
  assert.ok(distance(from, state.position) < state.route.landing.length);
  finish(state); assert.equal(state.completed, true);
});

test("camera/visual geometry replacement preserves physical feet and cannot repeat a completed arrival", () => {
  const state = setup(); advanceLeaftailBoatArrival(state, .5); const before = { ...state.position }, progress = state.distance, age = state.age;
  const replacement = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), home: 3, quarry: 1 });
  configureLeaftailBoatArrival(state, replacement, permission); assert.deepEqual(state.position, before); assert.equal(state.phase, "sailing"); assert.equal(state.age, age); assert.equal(state.distance, progress);
  finish(state); assert.equal(state.completed, true);
  configureLeaftailBoatArrival(state, scene, permission); assert.equal(state.phase, "complete");
});

test("missing or obstructed shore geometry fails closed, with a useful hand-tuning reason", () => {
  const missing = { ...scene, water: undefined }, state = createLeaftailBoatArrival(missing);
  configureLeaftailBoatArrival(state, missing, permission); assert.equal(state.phase, "blocked"); assert.match(state.reason, /причал/);
  assert.equal(settleLeaftailBoatArrival(state), false); assert.equal(state.completed, false); assert.equal(leaftailBoatArrivalFrame(state), null);
  const blocked = { ...scene, navigation: { ...scene.navigation, obstacles: [...scene.navigation.obstacles,
    { id: "temporary-shore-wall", points: [{ x: 880, y: 920 }, { x: 904, y: 920 }, { x: 904, y: 940 }, { x: 880, y: 940 }] }] } };
  assert.equal(leaftailBoatRoute(blocked), null);
});


test("boat painting clips the seated feet, avoids ground shadows and remains read-only across cameras", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = { createElement: () => ({ width: 48, height: 48, getContext: () => ({ fillStyle: "", fillRect() {} }) }) };
  try {
    const state = setup(); advanceLeaftailBoatArrival(state, .5);
    const frame = leaftailBoatArrivalFrame(state), before = JSON.stringify(state), calls = [], stack = [];
    const ctx = { globalAlpha: .6, fillStyle: "#000", strokeStyle: "#000", imageSmoothingEnabled: true,
      save() { stack.push({ globalAlpha: this.globalAlpha, fillStyle: this.fillStyle, imageSmoothingEnabled: this.imageSmoothingEnabled }); },
      restore() { Object.assign(this, stack.pop()); } };
    for (const name of ["translate", "rotate", "beginPath", "ellipse", "stroke", "moveTo", "lineTo", "closePath", "fill", "fillRect", "rect", "clip", "drawImage"])
      ctx[name] = (...args) => calls.push({ name, args });
    drawLeaftailBoatArrival(ctx, frame, false); drawLeaftailBoatArrival(ctx, frame, false);
    assert.equal(calls.filter(call => call.name === "drawImage").length, 2, "one seated trader per camera");
    assert.equal(calls.filter(call => call.name === "clip").length, 2, "the gunwale masks the lower legs");
    assert.equal(calls.filter(call => call.name === "ellipse").length, 4, "only two water wake rings per camera, no grounded ellipse");
    assert.equal(stack.length, 0); assert.equal(ctx.globalAlpha, .6); assert.equal(ctx.imageSmoothingEnabled, true);
    assert.equal(JSON.stringify(state), before, "drawing never advances or completes the arrival");
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
  }
});


test("reduced-motion introduction waits for an unoccupied safe endpoint", () => {
  const state = setup(), before = { ...state.position }, neighbour = { id: "plesk", size: 43, position: { ...state.route.target } };
  assert.equal(settleLeaftailBoatArrival(state, [neighbour]), false);
  assert.equal(state.completed, false); assert.equal(state.phase, "sailing"); assert.deepEqual(state.position, before);
  assert.equal(settleLeaftailBoatArrival(state, [{ ...neighbour, position: { x: neighbour.position.x + 80, y: neighbour.position.y } }]), true);
  assert.equal(state.completed, true); assert.deepEqual(state.position, state.route.target);
});

test("geometry handoffs share the completion acknowledgement fence", () => {
  const state = setup(), replacement = { ...state, position: { ...state.position } };
  assert.equal(replacement.completionNotice, state.completionNotice);
  replacement.completionNotice.pending = {};
  assert.equal(state.completionNotice.pending, replacement.completionNotice.pending);
  state.completionNotice.delivered = true; assert.equal(replacement.completionNotice.delivered, true);
  const restored = createLeaftailBoatArrival(scene);
  configureLeaftailBoatArrival(restored, scene, { ...permission, seen: true });
  assert.equal(restored.completionNotice.delivered, true, "a restored preference already acknowledges the completed introduction");
});
