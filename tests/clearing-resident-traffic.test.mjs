import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createClearingActivity, advanceClearingActivity, requestClearingPoint, isClearingAtPoint,
  setClearingNavigationObstacle, baseClearingNavigation, requestClearingSleep } =
  await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { canTraverse, canTraverseWorldObstacle, isWalkable } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { canTraverseResidents, residentClearance } = await vite.ssrLoadModule("/features/world/resident-traffic.ts");
const point = (x, y) => ({ x, y });
const rect = (x, y, width, height) => [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
const scene = () => ({ schemaVersion: 1, id: "resident-clearing", width: 400, height: 400,
  terrain: [], sites: [], paths: [], focus: { x: 30, y: 30, width: 340, height: 340 },
  actor: { spawn: point(170, 220), size: 40 },
  navigation: { version: 1, cellSize: 5, areas: [{ id: "grass", points: rect(100, 100, 220, 220) }],
    obstacles: [], interests: [] } });
const conditions = { enabled: true, blocked: false, dusk: 0, rain: 0 };
const builder = { id: "builder", position: point(220, 220), size: 40, moving: false };
function step(state, options = conditions) {
  const before = { ...state.position };
  advanceClearingActivity(state, .025, options);
  assert.ok(Math.hypot(before.x - state.position.x, before.y - state.position.y) <= state.size * .36 * .025 + .001,
    `discontinuous feet at ${state.stage}`);
  assert.ok(canTraverseWorldObstacle(state.navigation, before, state.position), "a resident never overrides the parked basket");
  return before;
}
function walk(state, target, options = conditions, seconds = 40) {
  for (let time = 0; time < seconds && !isClearingAtPoint(state, target); time += .025) {
    const before = step(state, options);
    assert.ok(canTraverse(state.navigation, before, state.position), "detour stays on ordinary walkable ground");
    assert.ok(canTraverseResidents(before, state.position, state.size, options.occupants, "mochlik"), "swept step leaves room for the resident");
  }
  assert.ok(isClearingAtPoint(state, target), `${state.stage}: ${state.behavior.reason}`);
}

test("Mochlik walks around a stationary builder without changing his held destination or moving the builder", () => {
  const state = createClearingActivity(scene(), 1), target = point(285, 220), options = { ...conditions, occupants: [builder] };
  const snapshot = structuredClone(builder), base = state.navigation, grid = base.grid.walkable.slice();
  assert.equal(requestClearingPoint(state, target), true);
  let deviated = false;
  for (let time = 0; time < 40 && !isClearingAtPoint(state, target); time += .025) {
    const before = step(state, options);
    assert.equal(requestClearingPoint(state, target), true);
    assert.deepEqual(state.requestedPoint, target);
    assert.ok(canTraverseResidents(before, state.position, state.size, options.occupants, "mochlik"));
    assert.ok(canTraverse(base, before, state.position));
    deviated ||= Math.abs(state.position.y - target.y) > residentClearance(state.size, builder.size) * .8;
  }
  assert.ok(isClearingAtPoint(state, target), state.behavior.reason); assert.ok(deviated);
  assert.deepEqual(builder, snapshot); assert.equal(state.navigation, base); assert.deepEqual(base.grid.walkable, grid);
});

test("a resident detour preserves the already parked basket and the session's navigation profile", () => {
  const state = createClearingActivity(scene(), 2), target = point(285, 220), base = baseClearingNavigation(state);
  assert.equal(setClearingNavigationObstacle(state, rect(228, 231, 18, 15)), true);
  const parked = state.navigation, options = { ...conditions, occupants: [builder] };
  assert.equal(requestClearingPoint(state, target), true);
  walk(state, target, options);
  assert.equal(state.navigation, parked); assert.equal(baseClearingNavigation(state), base);
  assert.equal(isWalkable(state.navigation, point(235, 237)), false);
  setClearingNavigationObstacle(state, null); assert.equal(state.navigation, base);
});

test("an occupied goal waits without completing or losing its route, then resumes from the same feet", () => {
  const state = createClearingActivity(scene(), 3), target = point(220, 220), options = { ...conditions, occupants: [builder] };
  assert.equal(requestClearingPoint(state, target), true);
  for (let time = 0; time < 10; time += .025) step(state, options);
  assert.equal(state.behavior.reason, "waiting-for-resident");
  const feet = { ...state.position }, walked = state.walked, progress = state.distance, elapsed = state.elapsed;
  for (let time = 0; time < 50; time += .025) step(state, options);
  assert.deepEqual(state.position, feet); assert.equal(state.walked, walked); assert.equal(state.distance, progress);
  assert.ok(state.elapsed > elapsed + 49); assert.deepEqual(state.requestedPoint, target);
  assert.equal(state.stage, "free-walk"); assert.equal(isClearingAtPoint(state, target), false);
  walk(state, target);
});

test("detouring the home approach preserves the exact porch suffix and sleeping doorway", () => {
  const source = scene();
  source.sites = [{ id: "home", entry: point(260, 164), doorway: point(260, 151), collision: rect(245, 130, 30, 34) }];
  source.actor.spawn = point(260, 270);
  const state = createClearingActivity(source, 4), worker = { ...builder, position: point(260, 218) };
  const options = { ...conditions, homeAvailable: true, occupants: [worker] };
  assert.equal(requestClearingSleep(state), true);
  const initial = state.activeInteraction.route, departure = structuredClone(state.activeInteraction.departure);
  const protectedTail = initial.points.filter((_, index) => initial.distances[index] > initial.navigationLength + .001);
  assert.ok(protectedTail.length > 0, "fixture exercises the protected threshold");
  let detoured = false;
  for (let time = 0; time < 40 && state.stage !== "home-sleep"; time += .025) {
    const before = { ...state.position }, previousStage = state.stage;
    advanceClearingActivity(state, .025, options);
    assert.ok(Math.hypot(before.x - state.position.x, before.y - state.position.y) <= state.size * .36 * .025 + .001);
    if (previousStage === "homebound") assert.ok(canTraverseResidents(before, state.position, state.size, options.occupants, "mochlik"));
    if (state.activeInteraction.route !== initial) {
      detoured = true;
      assert.deepEqual(state.activeInteraction.departure, departure);
      assert.deepEqual(state.activeInteraction.route.points.slice(-protectedTail.length), protectedTail);
    }
  }
  assert.ok(detoured); assert.equal(state.stage, "home-sleep"); assert.deepEqual(state.position, source.sites[0].doorway);
});

test("a resident exposed at old overlapping feet allows a bounded escape instead of trapping the route", () => {
  const state = createClearingActivity(scene(), 5), target = point(285, 220);
  const neighbour = { ...builder, position: point(168, 220) }, options = { ...conditions, occupants: [neighbour] };
  assert.equal(requestClearingPoint(state, target), true);
  walk(state, target, options);
});

function roamingScene() {
  const source = scene();
  source.navigation.interests = [{ id: "worker-place", position: point(240, 220), activity: "look" }];
  return source;
}
function beginNaturalRoam(source, seed = 1) {
  const state = createClearingActivity(source, seed);
  for (let time = 0; time < 5 && state.stage !== "free-walk"; time += .025) step(state);
  assert.equal(state.freePurpose, "roam");
  return state;
}

test("random free-roam selection cannot reserve a persistent builder's occupied work spot", () => {
  const source = roamingScene(), baseline = beginNaturalRoam(source);
  const worker = { ...builder, position: { ...baseline.freeRoute.points.at(-1) } }, original = structuredClone(worker);
  const state = createClearingActivity(source, 1), options = { ...conditions, occupants: [worker] };
  let released = false, moved = false;
  for (let time = 0; time < 25; time += .025) {
    const before = step(state, options);
    assert.ok(canTraverse(state.navigation, before, state.position));
    assert.ok(canTraverseResidents(before, state.position, state.size, options.occupants, "mochlik"));
    if (state.stage === "free-walk" && state.freePurpose === "roam") {
      const target = state.freeRoute.points.at(-1);
      assert.ok(canTraverseResidents(target, target, state.size, options.occupants, "mochlik"), "cosmetic grass choices cannot reserve the worker's feet");
    }
    released ||= state.behavior.reason === "roaming-place-occupied";
    moved ||= Math.hypot(state.position.x - state.home.x, state.position.y - state.home.y) > 10;
  }
  assert.ok(released, "the known seeded grass choice is occupied");
  assert.ok(moved, "normal bounded decisions find another place instead of freezing the actor");
  assert.deepEqual(worker, original, "a roaming decision cannot displace a working neighbour");
});

test("a free-roam goal occupied after departure is released from current feet without completing its activity", () => {
  const source = roamingScene(), state = beginNaturalRoam(source);
  for (let time = 0; time < .3; time += .025) step(state);
  const feet = { ...state.position }, target = { ...state.freeRoute.points.at(-1) }, intention = { ...state.behavior.mind.intention };
  const worker = { ...builder, position: target }, original = structuredClone(worker);
  step(state, { ...conditions, occupants: [worker] });
  assert.deepEqual(state.position, feet, "releasing an optional destination never restores previous coordinates");
  assert.equal(state.stage, "clearing"); assert.equal(state.freeRoute, null); assert.equal(state.freePurpose, null);
  assert.equal(state.behavior.target, null); assert.equal(state.behavior.mind.intention, null);
  assert.ok(state.waitSeconds >= 2.8, "the next choice respects the ordinary pause, without a per-frame search loop");
  assert.equal(state.behavior.mind.recent.at(-1)?.key, intention.key);
  assert.equal(state.behavior.mind.recent.at(-1)?.outcome, "interrupted", "unreached activity earns no completion");
  assert.deepEqual(worker, original);
});
