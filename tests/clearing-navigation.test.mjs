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
  requestClearingBush, requestClearingOutside, noticeClearingActivity } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
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

function interactionScene({ routes = true, porch = false } = {}) {
  const source = scene();
  source.sites.push({ id: "home", entry: point(225, porch ? 168 : 175), doorway: point(225, 155),
    collision: rect(215, 140, 30, 28) });
  source.bushes = [{ id: "bush", entry: point(180, 190), hide: point(165, 175), points: rect(150, 135, 40, 50) }];
  source.paths.push({ id: "home-route", behavior: "home", siteId: "home",
    points: [point(200, 210), point(205, 185), source.sites[0].entry] });
  source.paths.unshift({ id: "bush-route", behavior: "clearing", activity: "bush", bushId: "bush",
    points: [point(200, 210), point(185, 210), point(180, 190)] });
  if (!routes) source.paths = [];
  return source;
}
const homeConditions = { ...conditions, homeAvailable: true };
function untilInteraction(state, predicate, options = homeConditions, limit = 80) {
  for (let elapsed = 0; elapsed < limit && !predicate(state); elapsed += .025) {
    const before = { ...state.position };
    advanceClearingActivity(state, .025, options);
    assert.ok(Math.hypot(before.x - state.position.x, before.y - state.position.y) <= state.size * .04,
      `discontinuous transition at ${state.stage}`);
  }
  assert.ok(predicate(state), `condition not reached: ${state.stage}`);
}

test("home and bush approaches begin at current feet and keep precise entry markers with or without Routes", () => {
  for (const routes of [true, false]) for (const kind of ["home", "bush"]) {
    const source = interactionScene({ routes }), state = createClearingActivity(source, 5), origin = point(250, 250);
    requestClearingPoint(state, origin); until(state, s => isClearingAtPoint(s, origin), homeConditions);
    assert.equal(kind === "home" ? requestClearingSleep(state) : requestClearingBush(state), true);
    assert.equal(state.stage, kind === "home" ? "homebound" : "outbound");
    assert.deepEqual(state.position, origin);
    assert.deepEqual(state.activeInteraction.route.points[0], origin);
    assert.equal(state.activeInteraction.route.points.some(p => p.x === state.home.x && p.y === state.home.y), false,
      "the old spawn is not inserted into an autonomous approach");
    assert.equal(canStartClearingInteraction(state), false);
    until(state, s => s.stage === (kind === "home" ? "home-sleep" : "bush-prepare"), homeConditions);
    assert.deepEqual(state.position, kind === "home" ? source.sites[0].doorway : source.bushes[0].entry);
  }
});

test("a completed bush visit settles at its entry and a woken resident settles at the safe porch dock", () => {
  for (const kind of ["home", "bush"]) {
    const state = createClearingActivity(interactionScene({ routes: false, porch: true }), 4);
    assert.equal(kind === "home" ? requestClearingSleep(state) : requestClearingBush(state), true);
    if (kind === "home") {
      untilInteraction(state, s => s.stage === "home-sleep");
      assert.equal(noticeClearingActivity(state), true);
    }
    untilInteraction(state, s => s.stage === "clearing" && !s.activeInteraction);
    assert.ok(isWalkable(state.navigation, state.position));
    assert.ok(Math.hypot(state.position.x - state.home.x, state.position.y - state.home.y) > 10);
    assert.equal(state.routeKind, "clearing"); assert.equal(state.bushRequested, false);
    assert.equal(state.retiring, false); assert.equal(state.waking, false);
    const expected = kind === "home" ? state.interactions.home.dock : state.interactions.bushes[0].entry;
    assert.deepEqual(state.position, expected);
  }
});

test("tapping either dynamic approach stops on its current safe ground without a spawn detour", () => {
  for (const kind of ["home", "bush"]) {
    const state = createClearingActivity(interactionScene({ routes: false }), 4);
    requestClearingPoint(state, point(250, 250)); until(state, s => isClearingAtPoint(s, point(250, 250)), homeConditions);
    if (kind === "home") requestClearingSleep(state); else requestClearingBush(state);
    advance(state, .6, homeConditions);
    const before = { ...state.position };
    assert.equal(noticeClearingActivity(state), true);
    assert.equal(noticeClearingActivity(state), false);
    assert.deepEqual(state.position, before);
    until(state, s => s.stage === "clearing", homeConditions);
    assert.deepEqual(state.position, before);
    assert.equal(state.activeInteraction, null); assert.equal(state.retiring, false); assert.equal(state.bushRequested, false);
  }
});

test("a tap halfway across the porch bridge reverses only its short unsafe tail before greeting", () => {
  const state = createClearingActivity(interactionScene({ routes: false, porch: true }), 7);
  requestClearingSleep(state);
  until(state, s => s.stage === "homebound" && !isWalkable(s.navigation, s.position), homeConditions);
  const feet = { ...state.position }, dock = { ...state.interactions.home.dock };
  assert.equal(noticeClearingActivity(state), true);
  assert.deepEqual(state.position, feet); assert.equal(state.freePurpose, "interaction-exit");
  assert.equal(state.stage, "free-walk", "a greeting must not strand the feet inside the collision margin");
  until(state, s => s.stage === "attention", homeConditions);
  assert.deepEqual(state.position, dock);
  until(state, s => s.stage === "clearing", homeConditions);
  assert.equal(state.activeInteraction, null);
});

test("explicit return and DEV mode changes still reach spawn physically after dynamic house or bush visits", () => {
  for (const kind of ["home", "bush"]) for (const modeChange of [false, true]) {
    const state = createClearingActivity(interactionScene({ porch: true }), 9);
    if (kind === "home") requestClearingSleep(state); else requestClearingBush(state);
    untilInteraction(state, s => s.stage === (kind === "home" ? "home-sleep" : "bush-hidden"));
    const options = modeChange ? { ...homeConditions, navigationMode: "routes" } : homeConditions;
    if (!modeChange) returnClearingHome(state);
    untilInteraction(state, s => modeChange ? !s.navigationEnabled : isClearingAtHome(s), options);
    assert.deepEqual(state.position, state.home);
    assert.equal(state.activeInteraction, null);
  }
});

test("switching between bush and house completes the current transition then plans from its outside endpoint", () => {
  for (const first of ["home", "bush"]) {
    const state = createClearingActivity(interactionScene({ routes: false, porch: true }), 13);
    if (first === "home") requestClearingSleep(state); else requestClearingBush(state);
    untilInteraction(state, s => s.stage === (first === "home" ? "home-sleep" : "bush-hidden"));
    assert.equal(first === "home" ? requestClearingBush(state) : requestClearingSleep(state), true);
    untilInteraction(state, s => s.activeInteraction?.kind === (first === "home" ? "bush" : "home"));
    const expected = first === "home" ? state.interactions.home.dock : state.interactions.bushes[0].entry;
    assert.deepEqual(state.activeInteraction.route.points[0], expected);
    untilInteraction(state, s => s.stage === (first === "home" ? "bush-hidden" : "home-sleep"));
  }
});

test("an outside request finishes an airborne bush jump or doorway transit once and remains near that interaction", () => {
  for (const kind of ["home", "bush"]) {
    const state = createClearingActivity(interactionScene({ routes: false, porch: true }), 12);
    if (kind === "home") requestClearingSleep(state); else requestClearingBush(state);
    untilInteraction(state, s => kind === "home" ? s.stage === "entering" && s.doorProgress > .3 : s.stage === "bush-enter" && s.bushProgress > .3);
    for (let time = 0; time < 15 && !canStartClearingInteraction(state); time += .025) {
      requestClearingOutside(state);
      const feet = { ...state.position };
      advanceClearingActivity(state, .025, homeConditions);
      assert.ok(Math.hypot(feet.x - state.position.x, feet.y - state.position.y) < state.size * .04);
    }
    assert.ok(canStartClearingInteraction(state)); assert.equal(state.activeInteraction, null);
    assert.deepEqual(state.position, kind === "home" ? state.interactions.home.dock : state.interactions.bushes[0].entry);
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
  memory.mind.needs.energy = .15;
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

test("inactivity plans the home approach from the current point without waiting for a return to spawn", () => {
  const state = createClearingActivity(interactionScene({ routes: false, porch: true }), 33), origin = point(250, 250);
  requestClearingPoint(state, origin); until(state, s => isClearingAtPoint(s, origin), homeConditions);
  state.idleSeconds = 179.99;
  step(state, homeConditions);
  assert.equal(state.stage, "homebound"); assert.equal(state.retiring, true);
  assert.deepEqual(state.activeInteraction.route.points[0], origin);
  until(state, s => s.stage === "home-sleep", homeConditions);
});

test("paused dynamic approaches keep geometry and reduced-motion wake never strands a hidden actor", () => {
  for (const kind of ["home", "bush"]) {
    const state = createClearingActivity(interactionScene({ routes: false, porch: true }), 21);
    if (kind === "home") requestClearingSleep(state); else requestClearingBush(state);
    advance(state, .5, homeConditions);
    const route = state.activeInteraction.route, position = { ...state.position }, progress = state.distance;
    for (const options of [{ ...homeConditions, blocked: true }, { ...homeConditions, enabled: false }]) {
      advance(state, 2, options);
      assert.equal(state.activeInteraction.route, route);
      assert.deepEqual(state.position, position); assert.equal(state.distance, progress);
    }
    untilInteraction(state, s => s.stage === (kind === "home" ? "home-sleep" : "bush-hidden"));
    assert.equal(noticeClearingActivity(state, { still: true }), true);
    assert.equal(clearingActivityFrame(state, { still: true }).opacity, 1);
    const outside = { ...state.position };
    advance(state, 2, { ...homeConditions, enabled: false });
    assert.deepEqual(state.position, outside);
    untilInteraction(state, s => s.stage === "clearing");
    assert.ok(isWalkable(state.navigation, state.position));
    assert.equal(state.activeInteraction, null); assert.equal(state.retiring, false);
  }
});

test("an unreachable special request preserves the actor's existing ordinary walk", () => {
  const source = interactionScene({ routes: false });
  source.navigation.areas = [{ id: "main", points: rect(190, 185, 90, 100) },
    { id: "house", points: rect(210, 145, 50, 35) }, { id: "bush", points: rect(145, 150, 40, 50) }];
  const state = createClearingActivity(source, 27);
  assert.ok(state.interactions.home); assert.ok(state.interactions.bushes.length);
  requestClearingPoint(state, point(250, 250)); advance(state, .5, homeConditions);
  const route = state.freeRoute, position = { ...state.position }, progress = state.distance;
  for (const request of [requestClearingSleep, requestClearingBush]) {
    assert.equal(request(state), false);
    assert.equal(state.freeRoute, route); assert.deepEqual(state.position, position); assert.equal(state.distance, progress);
    assert.equal(state.activeInteraction, null); assert.equal(state.retiring, false); assert.equal(state.bushRequested, false);
  }
});

test("a renewed bush request supersedes queued sleep without restarting the current airborne jump", () => {
  const state = createClearingActivity(interactionScene({ routes: false, porch: true }), 55);
  requestClearingBush(state);
  untilInteraction(state, s => s.stage === "bush-enter" && s.bushProgress > .3);
  const feet = { ...state.position }, phase = state.stageElapsed;
  assert.equal(requestClearingSleep(state), true); assert.equal(state.retiring, true);
  assert.equal(requestClearingBush(state), true); assert.equal(state.retiring, false);
  assert.deepEqual(state.position, feet); assert.equal(state.stageElapsed, phase);
  let exited = false, returned = false;
  for (let elapsed = 0; elapsed < 20 && !returned; elapsed += .025) {
    advanceClearingActivity(state, .025, homeConditions);
    assert.notEqual(state.routeKind, "home");
    exited ||= state.stage === "bush-exit";
    returned ||= exited && state.stage === "bush-hidden";
  }
  assert.ok(returned, "the last request starts a fresh visit only after the previous jump and exit finish");
});
