import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createClearingActivity, advanceClearingActivity, clearingActivityFrame, clearingNavigationFrame,
  canStartClearingLife, canStartClearingInteraction, isClearingAtHome, returnClearingHome,
  requestClearingPoint, releaseClearingPoint, isClearingAtPoint, requestClearingSleep,
  requestClearingBush, noticeClearingActivity } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { canTraverse, isWalkable } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { chooseForestGoal, createForestBehavior } = await vite.ssrLoadModule("/features/world/forest-behavior.ts");
const point = (x, y) => ({ x, y });
const rect = (x, y, width, height) => [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
const conditions = { enabled: true, blocked: false, dusk: 0, rain: 0 };
const scene = () => ({ schemaVersion: 1, id: "free-clearing", width: 400, height: 400,
  terrain: [], sites: [], focus: { x: 50, y: 50, width: 300, height: 300 },
  actor: { spawn: point(200, 210), size: 40 },
  paths: [{ id: "legacy-look", behavior: "clearing", activity: "look", points: [point(200, 210), point(185, 210), point(180, 190)] }],
  navigation: { version: 1, cellSize: 5, areas: [{ id: "grass", points: rect(140, 145, 140, 140) }],
    obstacles: [{ id: "stone", points: rect(215, 190, 10, 40) }], interests: [
      { id: "east", position: point(250, 210), activity: "look" },
      { id: "south", position: point(200, 255), activity: "sniff" },
      { id: "north", position: point(175, 180), activity: "groom" },
    ] } });
function step(state, options = conditions) {
  const before = { ...state.position };
  advanceClearingActivity(state, .025, options);
  assert.ok(Math.hypot(before.x - state.position.x, before.y - state.position.y) <= state.size * .36 * .025 + .001,
    `unexpected jump at ${state.stage}`);
}
function until(state, predicate, options = conditions, limit = 80) {
  for (let elapsed = 0; elapsed < limit && !predicate(state); elapsed += .025) step(state, options);
  assert.ok(predicate(state), `condition not reached: ${state.stage}`);
}
function advance(state, seconds, options = conditions) {
  for (let elapsed = 0; elapsed < seconds; elapsed += .025) step(state, options);
}

test("free point requests detour around obstacles, preserve gait and hold arrival for the queued action", () => {
  const state = createClearingActivity(scene(), 17), destination = point(250, 210);
  assert.equal(state.navigationEnabled, true);
  assert.equal(requestClearingPoint(state, destination), true);
  assert.ok(state.freeRoute.points.length >= 3, "the stone prevents a straight approach");
  assert.deepEqual(state.freeRoute.points[0], state.position);
  let firstSpeed = 0;
  for (let i = 0; i < 3000 && !isClearingAtPoint(state, destination); i++) {
    const before = { ...state.position }, progress = state.distance;
    assert.equal(requestClearingPoint(state, destination), true, "repeated requests retain the same route");
    assert.equal(state.distance, progress);
    step(state);
    if (i === 0) firstSpeed = state.speed;
    assert.ok(canTraverse(state.navigation, before, state.position));
    assert.ok(isWalkable(state.navigation, state.position));
  }
  assert.ok(firstSpeed > 0 && firstSpeed < state.size * .36);
  assert.ok(isClearingAtPoint(state, destination));
  assert.equal(canStartClearingLife(state), true);
  assert.equal(canStartClearingInteraction(state), true);
  const gait = state.walked;
  advance(state, 30);
  assert.deepEqual(state.position, destination); assert.equal(state.walked, gait);
  releaseClearingPoint(state);
  until(state, s => s.stage === "free-walk");
  assert.deepEqual(state.freeRoute.points[0], destination, "next plan starts at the actual current feet");
});

test("autonomous activities stay at their endpoint and choose varied connected goals without resetting to spawn", () => {
  const state = createClearingActivity(scene(), 3), goals = new Set();
  let completed = 0, stationaryFeet = null;
  for (let i = 0; i < 8000 && completed < 6; i++) {
    const previousStage = state.stage, before = { ...state.position };
    step(state);
    assert.ok(isWalkable(state.navigation, state.position));
    if (previousStage !== "free-walk" && state.stage === "free-walk") {
      goals.add(state.freeRoute.id);
      assert.deepEqual(state.freeRoute.points[0], stationaryFeet ?? state.home);
    }
    if (previousStage === "activity" && state.stage === "clearing") {
      completed++; stationaryFeet = before;
      assert.deepEqual(state.position, before);
      assert.ok(Math.hypot(before.x - state.home.x, before.y - state.home.y) > 1);
      assert.equal(canStartClearingLife(state), true);
    }
  }
  assert.equal(completed, 6); assert.ok(goals.size >= 4);
  assert.ok(state.behavior.recent.length <= 8);
});

test("returning from a free excursion uses navigation from current feet and reentrant requests keep progressing", () => {
  const state = createClearingActivity(scene(), 5), destination = point(250, 210);
  requestClearingPoint(state, destination); until(state, s => isClearingAtPoint(s, destination));
  returnClearingHome(state);
  assert.equal(state.freePurpose, "home");
  assert.deepEqual(state.freeRoute.points[0], destination);
  for (let elapsed = 0; elapsed < 40 && !isClearingAtHome(state); elapsed += .025) {
    returnClearingHome(state);
    const before = { ...state.position }; step(state);
    assert.ok(canTraverse(state.navigation, before, state.position));
  }
  assert.ok(isClearingAtHome(state)); assert.deepEqual(state.position, state.home);
});

test("blocked and disabled navigation frames freeze the route, feet and distance clock", () => {
  const state = createClearingActivity(scene(), 5);
  requestClearingPoint(state, point(250, 210)); advance(state, 1);
  const before = JSON.stringify({ position: state.position, distance: state.distance, elapsed: state.elapsed, walked: state.walked });
  for (const options of [{ ...conditions, blocked: true }, { ...conditions, enabled: false }]) {
    advance(state, 10, options);
    assert.equal(JSON.stringify({ position: state.position, distance: state.distance, elapsed: state.elapsed, walked: state.walked }), before);
    assert.equal(clearingActivityFrame(state).pose, "idle");
  }
  step(state); assert.equal(clearingActivityFrame(state).pose, "walk");
});

test("unreachable requests are rejected without replacing an active route and debug snapshots cannot mutate it", () => {
  const state = createClearingActivity(scene(), 5);
  requestClearingPoint(state, point(250, 210)); advance(state, 1);
  const before = { route: state.freeRoute, position: { ...state.position }, distance: state.distance };
  assert.equal(requestClearingPoint(state, point(220, 210)), false);
  assert.equal(state.freeRoute, before.route); assert.deepEqual(state.position, before.position); assert.equal(state.distance, before.distance);
  const frame = clearingNavigationFrame(state);
  frame.path[0].x = -100; frame.target.x = -100;
  assert.notEqual(state.freeRoute.points[0].x, -100); assert.notEqual(state.freeRoute.points.at(-1).x, -100);
});

test("a tap cancels an explicit approach at its real location before stationary attention", () => {
  const state = createClearingActivity(scene(), 5);
  requestClearingPoint(state, point(250, 210)); advance(state, 1);
  const feet = { ...state.position };
  assert.equal(noticeClearingActivity(state), true);
  assert.equal(noticeClearingActivity(state), false);
  releaseClearingPoint(state);
  assert.equal(state.stage, "attention", "cancelling the queued action must not erase the tap response");
  until(state, s => s.stage !== "attention");
  assert.equal(state.stage, "clearing"); assert.equal(state.requestedPoint, null); assert.deepEqual(state.position, feet);
});

test("switching between free navigation and legacy routes returns safely before changing owners", () => {
  const state = createClearingActivity(scene(), 5), legacy = { ...conditions, navigationMode: "routes" };
  requestClearingPoint(state, point(250, 210)); until(state, s => isClearingAtPoint(s, point(250, 210)));
  step(state, legacy);
  assert.equal(state.navigationEnabled, true); assert.equal(state.freePurpose, "home");
  until(state, s => !s.navigationEnabled, legacy);
  assert.ok(isClearingAtHome(state));
  until(state, s => s.stage === "outbound" && s.distance > 10, legacy);
  step(state);
  assert.equal(state.navigationEnabled, false); assert.equal(state.stage, "return");
  until(state, s => s.navigationEnabled);
  assert.ok(isClearingAtHome(state));
});

test("free roaming returns to spawn before using the existing authored home and bush transitions", () => {
  for (const kind of ["home", "bush"]) {
    const source = scene();
    if (kind === "home") {
      source.sites.push({ id: "home", entry: point(225, 175), doorway: point(225, 165), collision: rect(215, 143, 30, 25) });
      source.paths.push({ id: "home-route", behavior: "home", siteId: "home", points: [point(200, 210), point(205, 185), point(225, 175)] });
    } else {
      source.bushes = [{ id: "bush", entry: point(180, 190), hide: point(165, 175), points: rect(150, 135, 40, 50) }];
      source.paths.unshift({ id: "bush-route", behavior: "clearing", activity: "bush", bushId: "bush",
        points: [point(200, 210), point(185, 210), point(180, 190)] });
    }
    const state = createClearingActivity(source, 5), options = { ...conditions, homeAvailable: true };
    requestClearingPoint(state, point(250, 250)); until(state, s => isClearingAtPoint(s, point(250, 250)), options);
    assert.equal(kind === "home" ? requestClearingSleep(state) : requestClearingBush(state), true);
    assert.equal(state.freePurpose, "home");
    until(state, s => s.stage === (kind === "home" ? "homebound" : "outbound"), options);
    assert.deepEqual(state.position, state.home);
    assert.equal(canStartClearingInteraction(state), false);
    // Jump geometry has its own speed and lift; the ordinary walk bound above stops at its entry.
    if (kind === "home") until(state, s => s.stage === "home-sleep", options);
    else until(state, s => s.stage === "bush-prepare", options);
  }
});

test("unknown navigation versions preserve the legacy controller", () => {
  const source = scene(); source.navigation.version = 2;
  const state = createClearingActivity(source, 5);
  assert.equal(state.navigationEnabled, false); assert.equal(state.navigation, null);
  assert.equal(requestClearingPoint(state, point(250, 210)), false);
  until(state, s => s.stage === "outbound"); assert.equal(state.routes[state.routeIndex].id, "legacy-look");
});

test("behavior memory reduces recent repeats and refuses rest in rain, after waking or during its own cooldown", () => {
  const state = createClearingActivity(scene(), 5);
  const context = { position: state.home, size: state.size, elapsed: 10, awakeUntil: 0, dusk: 1, rain: 0, random: () => .5 };
  const interests = [{ id: "soft-grass", position: point(180, 210), activity: "rest" },
    { id: "flowers", position: point(200, 230), activity: "look" }];
  const memory = createForestBehavior();
  assert.equal(chooseForestGoal(state.navigation, interests, memory, context).id, "soft-grass");
  assert.ok(memory.restUntil > context.elapsed);
  assert.equal(chooseForestGoal(state.navigation, interests, memory, { ...context, elapsed: 11 }).id, "flowers");
  for (const change of [{ rain: 1 }, { awakeUntil: 30 }]) {
    assert.equal(chooseForestGoal(state.navigation, interests, createForestBehavior(), { ...context, ...change }).id, "flowers");
  }
  const lookInterests = interests.map(interest => ({ ...interest, activity: "look" })), repeated = createForestBehavior();
  const first = chooseForestGoal(state.navigation, lookInterests, repeated, context);
  const next = chooseForestGoal(state.navigation, lookInterests, repeated, { ...context, elapsed: 11 });
  assert.notEqual(first.id, next.id);
});

test("an unavailable return destination waits with a retry deadline instead of re-planning every frame", () => {
  const state = createClearingActivity(scene(), 5);
  requestClearingPoint(state, point(250, 210)); until(state, s => isClearingAtPoint(s, point(250, 210)));
  // Model a stale anchor after a world edit: the only permissible response is to stay on safe grass.
  state.home = point(220, 210);
  returnClearingHome(state);
  assert.equal(state.behavior.reason, "home-unreachable");
  assert.ok(state.navigationRetryAt > state.elapsed);
  const seed = state.seed, position = { ...state.position };
  for (let i = 0; i < 20; i++) { returnClearingHome(state); step(state); }
  assert.equal(state.seed, seed, "no repeated wait reset or path decision inside the backoff window");
  assert.deepEqual(state.position, position);
});
