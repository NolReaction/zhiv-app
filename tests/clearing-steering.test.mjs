import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createClearingActivity, advanceClearingActivity, clearingActivityFrame, requestClearingPoint,
  releaseClearingPoint, isClearingAtPoint, requestClearingSleep, requestClearingBush,
  noticeClearingActivity, canStartClearingInteraction } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { canTraverse, isWalkable, findWorldPath } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const point = (x, y) => ({ x, y });
const rect = (x, y, width, height) => [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const conditions = { enabled: true, blocked: false, homeAvailable: true, dusk: 0, rain: 0 };
const destination = point(270, 210);
function scene() {
  return { schemaVersion: 1, id: "steering-clearing", width: 400, height: 400, terrain: [], sites: [], paths: [],
    focus: { x: 50, y: 50, width: 300, height: 300 }, actor: { spawn: point(170, 210), size: 40 },
    navigation: { version: 1, cellSize: 5, areas: [{ id: "grass", points: rect(100, 100, 200, 200) }],
      obstacles: [{ id: "stone", points: rect(215, 185, 12, 60) }], interests: [] } };
}
function advance(state, dt, options = conditions, traversable = true) {
  const before = { ...state.position };
  advanceClearingActivity(state, dt, options);
  assert.ok(distance(before, state.position) <= state.size * .36 * Math.min(dt, .1) + 1e-6,
    `walking skipped ahead during ${state.stage}`);
  if (traversable) assert.ok(canTraverse(state.navigation, before, state.position),
    `frame chord crossed a boundary: ${JSON.stringify(before)} to ${JSON.stringify(state.position)}`);
}
function until(state, predicate, options = conditions, inspect = () => {}, seconds = 60) {
  for (let elapsed = 0; elapsed < seconds && !predicate(state); elapsed += .025) {
    advanceClearingActivity(state, .025, options);
    inspect();
  }
  assert.ok(predicate(state), `timed out in ${state.stage}`);
}
function segmentDistance(p, a, b) {
  const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / lengthSquared)) : 0;
  return distance(p, point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
}

test("autonomous walking rounds a real detour, protects every frame chord and arrives exactly across frame rates", () => {
  for (const frameTimes of [[1 / 60], [.1], [.016, .1, .033, .075]]) {
    const state = createClearingActivity(scene(), 19);
    const raw = findWorldPath(state.navigation, state.position, destination);
    assert.ok(raw.length > 2, "the fixture must require a detour");
    assert.equal(requestClearingPoint(state, destination), true);
    const prepared = state.freeRoute;
    let maximumDeviation = 0, maximumSpeed = 0, elapsed = 0, steps = 0, previousDirection = null;
    const turns = [];
    while (!isClearingAtPoint(state, destination) && elapsed < 45) {
      const dt = frameTimes[steps++ % frameTimes.length]; elapsed += dt;
      advance(state, dt);
      maximumSpeed = Math.max(maximumSpeed, state.speed);
      maximumDeviation = Math.max(maximumDeviation,
        Math.min(...raw.slice(1).map((end, i) => segmentDistance(state.position, raw[i], end))));
      if (state.stage === "free-walk" && state.direction !== previousDirection) {
        turns.push(state.direction); previousDirection = state.direction;
      }
      if (!isClearingAtPoint(state, destination)) assert.equal(state.freeRoute, prepared, "following a curve must not rebuild the path every frame");
    }
    assert.ok(isClearingAtPoint(state, destination));
    assert.ok(maximumDeviation > .02, "the actual feet must follow rounded geometry, not the original sharp corners");
    assert.ok(maximumSpeed > state.size * .2);
    assert.ok(turns.length <= 5, `sprite facing flickered around one detour: ${turns}`);
    assert.deepEqual(state.position, destination);
    assert.equal(state.speed, 0);
    const walked = state.walked;
    for (let i = 0; i < 20; i++) advance(state, .1);
    assert.deepEqual(state.position, destination); assert.equal(state.walked, walked);
  }
});

test("curved travel freezes, retargets from real feet and cancels on a tap without snapping to old corners", () => {
  const state = createClearingActivity(scene(), 23);
  requestClearingPoint(state, destination);
  for (let i = 0; i < 42; i++) advance(state, .1);
  const feet = { ...state.position }, route = state.freeRoute, traveled = state.distance;
  for (const options of [{ ...conditions, blocked: true }, { ...conditions, enabled: false }]) {
    for (let i = 0; i < 10; i++) advance(state, .1, options);
    assert.deepEqual(state.position, feet); assert.equal(state.freeRoute, route); assert.equal(state.distance, traveled);
    assert.equal(clearingActivityFrame(state, { still: true }).pose, "idle");
  }
  const target = point(180, 270);
  assert.equal(requestClearingPoint(state, target), true);
  assert.deepEqual(state.freeRoute.points[0], feet);
  assert.deepEqual(state.position, feet);
  for (let i = 0; i < 15; i++) advance(state, .1);
  const tapped = { ...state.position };
  assert.equal(noticeClearingActivity(state), true);
  releaseClearingPoint(state);
  until(state, current => current.stage === "clearing", conditions, () => assert.deepEqual(state.position, tapped));
  assert.equal(state.freeRoute, null);
  assert.ok(isWalkable(state.navigation, state.position));
  assert.equal(requestClearingPoint(state, destination), true);
  until(state, current => isClearingAtPoint(current, destination), conditions);
});

test("steering keeps the real Tiled porch corridor and bush launch and landing markers exact without Routes", () => {
  for (const dusk of [0, 1]) for (const kind of ["home", "bush"]) {
    const source = structuredClone(TILED_WORLD); source.paths = [];
    const state = createClearingActivity(source, 31), options = { ...conditions, dusk };
    const origin = point(665, 701);
    assert.equal(requestClearingPoint(state, origin), true);
    until(state, current => isClearingAtPoint(current, origin), options);
    assert.equal(kind === "home" ? requestClearingSleep(state) : requestClearingBush(state), true);
    const entry = kind === "home" ? state.interactions.home.entry : state.interactions.bushes[0].entry;
    let before = { ...state.position };
    until(state, current => current.stage === (kind === "home" ? "entering" : "bush-prepare"), options, () => {
      if (isWalkable(state.navigation, before) && isWalkable(state.navigation, state.position)) {
        assert.ok(canTraverse(state.navigation, before, state.position));
      } else {
        assert.equal(kind, "home", "a bush approach cannot use the home's collision exception");
        const dock = state.interactions.home.dock;
        assert.ok(segmentDistance(state.position, dock, entry) < 1e-6, "the porch connector must stay straight");
      }
      before = { ...state.position };
    });
    assert.deepEqual(state.position, entry);
    until(state, current => current.stage === (kind === "home" ? "home-sleep" : "bush-hidden"), options);
    if (kind === "home") assert.deepEqual(state.position, state.interactions.home.doorway);
    else assert.deepEqual(state.position, state.interactions.bushes[0].hide);
    assert.equal(noticeClearingActivity(state), true);
    until(state, current => canStartClearingInteraction(current), options);
    assert.deepEqual(state.position, kind === "home" ? state.interactions.home.dock : entry);
    assert.ok(isWalkable(state.navigation, state.position));
  }
});

test("circle to world ownership transfers the same steering progress without resetting position or gait", () => {
  const source = scene(), key = "steering-camera-handoff";
  const circle = connectForestSession(key, source, "circle", 0, 0, () => {});
  const world = connectForestSession(key, source, "world", 0, 0, () => {});
  try {
    circle.configure("circle", true);
    const state = circle.state.clearing;
    assert.equal(requestClearingPoint(state, destination), true);
    for (let i = 0; i < 42; i++) advance(state, .1);
    const route = state.freeRoute, frame = clearingActivityFrame(state), traveled = state.distance, walked = state.walked;
    world.configure("world", true);
    assert.equal(circle.isOwner(), false); assert.equal(world.isOwner(), true);
    assert.equal(world.state.clearing, state);
    assert.deepEqual(clearingActivityFrame(world.state.clearing), frame);
    assert.equal(state.distance, traveled); assert.equal(state.walked, walked); assert.equal(state.freeRoute, route);
    advance(world.state.clearing, .1);
    world.release();
    assert.equal(circle.isOwner(), true);
    assert.equal(circle.state.clearing.freeRoute, route);
    until(state, current => isClearingAtPoint(current, destination));
  } finally { world.release(); circle.release(); }
});

test("starting a visit already at its exact entry handles a zero-length approach and remains pausable", () => {
  for (const kind of ["home", "bush"]) {
    const source = scene(), entry = { ...source.actor.spawn };
    if (kind === "home") source.sites = [{ id: "home", entry, doorway: point(170, 190), collision: rect(155, 175, 30, 20) }];
    else source.bushes = [{ id: "bush", entry, hide: point(157, 199), points: rect(140, 185, 25, 28) }];
    const state = createClearingActivity(source, 29);
    assert.equal(kind === "home" ? requestClearingSleep(state) : requestClearingBush(state), true);
    const route = state.activeInteraction.route;
    assert.equal(route.length, 0, "the visit should not invent a detour for an already reached entry");
    advanceClearingActivity(state, .025, conditions);
    assert.equal(state.stage, kind === "home" ? "entering" : "bush-prepare");
    assert.deepEqual(state.position, entry);
    const before = { position: { ...state.position }, elapsed: state.stageElapsed, distance: state.distance, walked: state.walked };
    for (let i = 0; i < 5; i++) advanceClearingActivity(state, .1, { ...conditions, blocked: true });
    assert.deepEqual({ position: state.position, elapsed: state.stageElapsed, distance: state.distance, walked: state.walked }, before);
    until(state, current => current.stage === (kind === "home" ? "home-sleep" : "bush-hidden"), conditions, () => {
      assert.ok([state.position.x, state.position.y, state.distance, state.walked, state.speed].every(Number.isFinite));
    });
  }
});
