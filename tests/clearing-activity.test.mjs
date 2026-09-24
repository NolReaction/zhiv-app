import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createClearingActivity, advanceClearingActivity, clearingActivityFrame,
  clearingRouteDiagnostics, isClearingAtHome, returnClearingHome, noticeClearingActivity,
  requestClearingSleep, canStartClearingLife, CLEARING_HOME_IDLE_SECONDS, CLEARING_AWAKE_GRACE_SECONDS } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const conditions = { enabled: true, blocked: false, dusk: 0, rain: 0 };
const point = (x, y) => ({ x, y });
const route = (id = "first", activity = "look") => ({ id, behavior: "clearing", activity,
  points: [point(200, 210), point(185, 210), point(180, 190)] });
const scene = (paths = [route()]) => ({ schemaVersion: 1, id: "test", width: 400, height: 400,
  terrain: [], sites: [], focus: { x: 50, y: 50, width: 300, height: 300 },
  actor: { spawn: point(200, 210), size: 40 }, paths });
const advance = (state, seconds, options = conditions) => {
  for (let elapsed = 0; elapsed < seconds - 1e-8; elapsed += .025) advanceClearingActivity(state, Math.min(.025, seconds - elapsed), options);
};
const until = (state, predicate, limit = 60, options = conditions) => {
  for (let t = 0; t < limit && !predicate(state); t += .025) advanceClearingActivity(state, .025, options);
  assert.ok(predicate(state), `condition not reached: ${state.stage}`);
};
const rect = (x, y, width, height) => [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
const onRoute = p => Math.abs(p.y - 210) < 1e-7 && p.x >= 185 - 1e-7 && p.x <= 200 + 1e-7
  || Math.abs((p.x - 185) * 20 - (p.y - 210) * 5) < 1e-7 && p.y >= 190 - 1e-7 && p.y <= 210 + 1e-7;

test("the authored clearing routes are safe, copied and start exactly at the feet", () => {
  const state = createClearingActivity(TILED_WORLD, 1);
  assert.ok(state.routes.length >= 3, "the shipped forest must have real local routes");
  assert.ok(state.diagnostics.every(item => item.valid), JSON.stringify(state.diagnostics));
  assert.deepEqual(state.position, TILED_WORLD.actor.spawn);
  for (const item of state.routes) assert.deepEqual(item.points[0], TILED_WORLD.actor.spawn);
  const nearby = scene(); nearby.paths[0].points[0].x += .7;
  const normalized = createClearingActivity(nearby, 1);
  assert.deepEqual(normalized.routes[0].points[0], nearby.actor.spawn);
  nearby.paths[0].points[1].x = 0;
  assert.equal(normalized.routes[0].points[1].x, 185, "active routes are cached snapshots, not mutable editor references");
});

test("only explicit clearing paths activate movement; unsafe paths have useful diagnostics", () => {
  const cases = [
    ["start-away-from-spawn", s => { s.paths[0].points[0].x += 2; }],
    ["invalid-points", s => { s.paths[0].points[1].x = NaN; }],
    ["invalid-points", s => { s.paths[0].points.length = 1; }],
    ["outside-clearing-radius", s => { s.paths[0].points[1].x = 270; }],
    ["outside-focus", s => { s.focus = { x: 140, y: 150, width: 120, height: 100 }; s.paths[0].points[1] = point(166, 210); }],
    ["invalid-length", s => { s.paths[0].points = [point(200, 210), point(200, 210)]; }],
    ["invalid-activity", s => { s.paths[0].activity = "fishing"; }],
    ["invalid-pause", s => { s.paths[0].pauseSeconds = 100; }],
  ];
  for (const [reason, change] of cases) {
    const source = scene(); change(source);
    const state = createClearingActivity(source, 1);
    assert.equal(state.routes.length, 0, reason); assert.equal(state.diagnostics[0].reason, reason);
  }
  const disabled = scene([{ ...route(), behavior: undefined }]);
  assert.deepEqual(clearingRouteDiagnostics(disabled), []);
  const state = createClearingActivity(disabled, 1), poses = new Set();
  for (let i = 0; i < 1600; i++) {
    advanceClearingActivity(state, .025, conditions); poses.add(clearingActivityFrame(state).pose);
    assert.deepEqual(state.position, disabled.actor.spawn);
  }
  assert.ok(poses.size >= 4, "no fabricated path: local idle actions still make the hero alive");
});

test("collision validation catches thin crossed obstacles and raw water even inside an exclusion", () => {
  for (const obstacle of [rect(190, 209, .1, 2), rect(190, 213.5, .1, 2)]) {
    const source = scene(); source.sites = [{ id: "home", collision: obstacle }];
    assert.equal(clearingRouteDiagnostics(source)[0].reason, "building-collision");
  }
  const source = scene();
  source.water = { surfaces: [{ id: "river", points: rect(190, 209, .1, 2) }],
    exclusions: [{ id: "leaf", points: rect(180, 200, 30, 20) }] };
  assert.equal(clearingRouteDiagnostics(source)[0].reason, "water-collision");
});

test("stroll accelerates, follows its polyline, performs an action and returns without teleporting", () => {
  const state = createClearingActivity(scene(), 1); advance(state, 2.4);
  assert.equal(state.stage, "home"); assert.deepEqual(state.position, state.home);
  const stages = new Set(), poses = new Set(), maxStep = state.size * .36 * .025;
  let moved = false, completed = false;
  for (let i = 0; i < 2000 && !completed; i++) {
    const previous = { ...state.position }, previousStage = state.stage;
    advanceClearingActivity(state, .025, conditions);
    stages.add(state.stage); poses.add(clearingActivityFrame(state).pose);
    const travel = Math.hypot(state.position.x - previous.x, state.position.y - previous.y);
    assert.ok(travel <= maxStep + .001, `jump of ${travel}`); assert.ok(onRoute(state.position));
    moved ||= travel > 0;
    if (previousStage === "return" && state.stage === "home") completed = true;
  }
  assert.ok(moved && completed); assert.deepEqual(stages, new Set(["home", "outbound", "activity", "return"]));
  assert.ok(poses.has("walk") && poses.has("wonder") && (poses.has("stretch") || poses.has("scratch")));
  assert.equal(isClearingAtHome(state), true); assert.deepEqual(state.position, state.home);
  assert.equal(state.speed, 0);
});

test("manual/blocked/reduced frames freeze feet, phase and gait and resume smoothly", () => {
  const state = createClearingActivity(scene(), 3); advance(state, 3.6);
  assert.equal(state.stage, "outbound");
  const before = { position: { ...state.position }, elapsed: state.elapsed, distance: state.distance, walked: state.walked };
  for (const options of [{ ...conditions, enabled: false }, { ...conditions, blocked: true }]) {
    advance(state, 10, options);
    assert.deepEqual({ position: state.position, elapsed: state.elapsed, distance: state.distance, walked: state.walked }, before);
    assert.equal(clearingActivityFrame(state).pose, "idle");
  }
  assert.equal(clearingActivityFrame(state, { still: true }).pose, "idle");
  advanceClearingActivity(state, .025, conditions);
  assert.ok(state.distance > before.distance); assert.equal(clearingActivityFrame(state).pose, "walk");
});

test("forced return safely reverses from halfway or an endpoint and repeated requests do not stall it", () => {
  for (const endpoint of [false, true]) {
    const state = createClearingActivity(scene([route("rest", "rest")]), 1);
    if (endpoint) until(state, s => s.stage === "activity"); else advance(state, 3.6);
    const previous = { ...state.position }, distanceBefore = state.distance;
    returnClearingHome(state);
    assert.deepEqual(state.position, previous); assert.equal(state.distance, distanceBefore);
    assert.equal(state.stage, "return"); assert.deepEqual(state.steps, []);
    for (let i = 0; i < 1000 && !isClearingAtHome(state); i++) {
      returnClearingHome(state);
      const before = { ...state.position };
      advanceClearingActivity(state, .025, conditions);
      assert.ok(onRoute(state.position));
      assert.ok(Math.hypot(state.position.x - before.x, state.position.y - before.y) <= .361);
    }
    assert.equal(isClearingAtHome(state), true);
  }
});

test("route choice avoids consecutive repeats and walk frames follow distance", () => {
  const paths = [route("look"), route("sniff", "sniff"), route("rest", "rest")];
  const state = createClearingActivity(scene(paths), 17); let previous = -1, count = 0;
  for (let i = 0; i < 20_000 && count < 12; i++) {
    const stage = state.stage;
    advanceClearingActivity(state, .025, conditions);
    if (stage === "home" && state.stage === "outbound") {
      assert.notEqual(state.routeIndex, previous); previous = state.routeIndex; count++;
    }
    if (state.stage === "outbound" && state.speed > .05) {
      assert.equal(clearingActivityFrame(state).frame, Math.floor(state.walked / (state.size * .075)) % 4);
    }
  }
  assert.equal(count, 12);
});

test("night walks are slower, a rest has waking stages, and rain includes a shake", () => {
  const day = createClearingActivity(scene(), 1), night = createClearingActivity(scene(), 1);
  advance(day, 4); advance(night, 4, { ...conditions, dusk: 1 });
  assert.ok(night.distance < day.distance && night.distance > 0);
  const rest = createClearingActivity(scene([route("rest", "rest")]), 1);
  until(rest, s => s.stage === "activity");
  const poses = [];
  while (rest.stage === "activity") {
    const pose = clearingActivityFrame(rest).pose;
    if (poses.at(-1) !== pose) poses.push(pose);
    advanceClearingActivity(rest, .025, conditions);
  }
  assert.deepEqual(poses, ["yawn", "drowsy", "sleep", "drowsy", "stretch", "blink"]);
  const wet = createClearingActivity(scene([route("sniff", "sniff")]), 1);
  until(wet, s => s.stage === "activity", 60, { ...conditions, rain: 1 });
  assert.ok(wet.steps.some(step => step.pose === "shake"));
});

test("invalid and very large time deltas cannot jump the hero after suspension", () => {
  const state = createClearingActivity(scene(), 1); advance(state, 3.6);
  const snapshot = structuredClone(state);
  for (const dt of [NaN, Infinity, -2, 0]) advanceClearingActivity(state, dt, conditions);
  assert.deepEqual(state, snapshot);
  advanceClearingActivity(state, 60_000, conditions);
  assert.ok(state.elapsed - snapshot.elapsed <= .1000001);
  assert.ok(Math.hypot(state.position.x - snapshot.position.x, state.position.y - snapshot.position.y) <= state.size * .036 + .001);
});

const residenceScene = () => ({ ...scene([route("rest", "rest"), {
  id: "home-approach", behavior: "home", siteId: "home",
  points: [point(200, 210), point(215, 204), point(225, 192)],
}]), sites: [{ id: "home", entry: point(225, 192), doorway: point(230, 182),
  collision: rect(221, 155, 35, 29) }] });
const homeConditions = { ...conditions, homeAvailable: true };

test("touching an endpoint nap wakes, stretches, greets and discards the nap with an awake grace", () => {
  const state = createClearingActivity(scene([route("rest", "rest")]), 1);
  until(state, s => clearingActivityFrame(s).pose === "sleep");
  const feet = { ...state.position }, poses = [];
  assert.equal(noticeClearingActivity(state), true);
  assert.equal(state.stage, "attention"); assert.deepEqual(state.position, feet);
  while (state.stage === "attention") {
    const frame = clearingActivityFrame(state);
    assert.equal(frame.attention, true); assert.deepEqual(state.position, feet);
    if (poses.at(-1) !== frame.pose) poses.push(frame.pose);
    advanceClearingActivity(state, .025, conditions);
  }
  assert.deepEqual(poses, ["drowsy", "stretch", "greet", "blink"]);
  assert.equal(state.stage, "return"); assert.equal(state.steps.length, 0);
  for (let elapsed = 0; elapsed < CLEARING_AWAKE_GRACE_SECONDS - 3; elapsed += .025) {
    advanceClearingActivity(state, .025, conditions);
    assert.ok(!["sleep", "drowsy", "yawn"].includes(clearingActivityFrame(state).pose), "cannot re-enter the interrupted nap");
  }
});

test("walking attention keeps the authored position and repeated touches cannot loop its first frame", () => {
  const state = createClearingActivity(scene(), 3); advance(state, 3.6);
  const feet = { ...state.position }, progress = state.distance;
  assert.equal(noticeClearingActivity(state), true);
  for (let i = 0; i < 50; i++) {
    assert.equal(noticeClearingActivity(state), false);
    advanceClearingActivity(state, .025, conditions);
    assert.deepEqual(state.position, feet); assert.equal(state.distance, progress);
  }
  until(state, s => s.stage === "outbound");
  assert.equal(noticeClearingActivity(state), false, "brief cooldown lets the previous response finish");
  advance(state, .25);
  assert.ok(state.distance > progress); assert.ok(onRoute(state.position));
});

test("inactivity finishes the current return then walks through the authored door and stays inside", () => {
  const state = createClearingActivity(residenceScene(), 2);
  assert.ok(state.homeRoute); assert.ok(state.diagnostics.every(item => item.valid), JSON.stringify(state.diagnostics));
  let previous = { ...state.position }, entered = false, doorMoved = false;
  for (let t = 0; t < CLEARING_HOME_IDLE_SECONDS + 40 && !clearingActivityFrame(state).homeSleeping; t += .025) {
    const before = state.stage;
    advanceClearingActivity(state, .025, homeConditions);
    if (t < CLEARING_HOME_IDLE_SECONDS - .03) assert.equal(clearingActivityFrame(state).residing, false);
    if (state.stage === "homebound" && before !== "homebound") assert.deepEqual(state.position, state.home, "approach starts at outdoor anchor");
    const movement = Math.hypot(state.position.x - previous.x, state.position.y - previous.y);
    assert.ok(movement <= state.size * .36 * .025 + .001, `unexpected jump ${movement}`);
    if (state.stage === "entering") { entered = true; doorMoved ||= movement > 0; }
    previous = { ...state.position };
  }
  assert.ok(entered && doorMoved); assert.equal(clearingActivityFrame(state).homeSleeping, true);
  assert.equal(clearingActivityFrame(state).opacity, 0); assert.deepEqual(state.position, state.doorway);
  assert.equal(canStartClearingLife(state), false); assert.equal(isClearingAtHome(state), false);
  const sleepingFeet = { ...state.position }; advance(state, 300, homeConditions);
  assert.deepEqual(state.position, sleepingFeet); assert.equal(state.stage, "home-sleep");
});

test("a sleeping resident exits the same doorway, greets once and returns outdoors without warping", () => {
  const state = createClearingActivity(residenceScene(), 1);
  assert.equal(requestClearingSleep(state), true);
  until(state, s => s.stage === "home-sleep", 30, homeConditions);
  assert.equal(noticeClearingActivity(state), true);
  let previous = { ...state.position }, sawWake = false, sawReturn = false;
  for (let t = 0; t < 30 && !isClearingAtHome(state); t += .025) {
    const frame = clearingActivityFrame(state);
    assert.equal(frame.attention, true, "wake remains active until the actor has returned outside");
    assert.notEqual(frame.pose, "drowsy", "an actor who has walked out of the house must not curl up again before greeting");
    sawWake ||= frame.pose === "greet"; sawReturn ||= state.stage === "home-return";
    advanceClearingActivity(state, .025, homeConditions);
    assert.ok(Math.hypot(state.position.x - previous.x, state.position.y - previous.y) <= state.size * .36 * .025 + .001);
    previous = { ...state.position };
  }
  assert.ok(sawWake && sawReturn); assert.equal(isClearingAtHome(state), true);
  assert.equal(clearingActivityFrame(state).opacity, 1); assert.equal(clearingActivityFrame(state).attention, false);
  assert.ok(state.idleSeconds < 30);
});

test("a tap halfway through entering reverses both fade and doorstep coordinates continuously", () => {
  const state = createClearingActivity(residenceScene(), 4);
  requestClearingSleep(state); until(state, s => s.stage === "entering" && s.doorProgress > .4, 30, homeConditions);
  const before = clearingActivityFrame(state), progress = state.doorProgress;
  noticeClearingActivity(state);
  const after = clearingActivityFrame(state);
  assert.deepEqual({ x: after.x, y: after.y, opacity: after.opacity }, { x: before.x, y: before.y, opacity: before.opacity });
  advanceClearingActivity(state, .025, homeConditions);
  assert.ok(state.doorProgress < progress); assert.ok(clearingActivityFrame(state).opacity > before.opacity);
  until(state, isClearingAtHome, 30, homeConditions);
});

test("paused, blocked and manual time cannot retire the hero, but explicitly eligible prop time counts", () => {
  for (const change of [{ enabled: false }, { blocked: true }, { blocked: true, idleEligible: false }]) {
    const state = createClearingActivity(residenceScene(), 1);
    advance(state, 400, { ...homeConditions, ...change });
    assert.equal(state.idleSeconds, 0); assert.equal(state.stage, "home");
  }
  const state = createClearingActivity(residenceScene(), 1);
  advance(state, 190, { ...homeConditions, blocked: true, idleEligible: true });
  assert.equal(state.stage, "home"); assert.ok(state.idleSeconds >= CLEARING_HOME_IDLE_SECONDS);
  assert.equal(canStartClearingLife(state), false, "do not start another prop routine once retirement is due");
  advanceClearingActivity(state, .025, homeConditions);
  assert.equal(state.stage, "homebound");
});

test("missing or unsafe home routes keep the actor outdoors, and only the short own threshold may overlap", () => {
  for (const makeUnsafe of [
    s => { s.paths.pop(); },
    s => { s.paths[1].siteId = "other"; },
    s => { s.paths[1].points.at(-1).x += 1; },
    s => { s.sites[0].doorway.x += 30; },
    s => { s.sites[0].collision = rect(207, 199, 3, 15); },
    s => { s.sites.push({ id: "other", collision: rect(226, 183, 5, 5) }); },
    s => { s.water = { surfaces: [{ points: rect(226, 183, 5, 5) }], exclusions: [] }; },
  ]) {
    const source = residenceScene(); makeUnsafe(source);
    const state = createClearingActivity(source, 1);
    assert.equal(state.homeRoute, null, JSON.stringify(state.diagnostics));
    assert.equal(requestClearingSleep(state), false);
    advance(state, 250, homeConditions);
    assert.equal(clearingActivityFrame(state).residing, false); assert.equal(clearingActivityFrame(state).opacity, 1);
  }
});

test("forced return wakes home sleep, repeated requests progress, and missing building safely exits", () => {
  for (const hideBuilding of [false, true]) {
    const state = createClearingActivity(residenceScene(), 1);
    requestClearingSleep(state); until(state, s => s.stage === "home-sleep", 30, homeConditions);
    for (let t = 0; t < 30 && !isClearingAtHome(state); t += .025) {
      if (!hideBuilding) returnClearingHome(state);
      advanceClearingActivity(state, .025, { ...homeConditions, homeAvailable: !hideBuilding });
    }
    assert.equal(isClearingAtHome(state), true); assert.equal(clearingActivityFrame(state).opacity, 1);
  }
});

test("reduced-motion attention completes wake immediately without a stuck hidden reaction", () => {
  const state = createClearingActivity(residenceScene(), 1);
  requestClearingSleep(state); until(state, s => s.stage === "home-sleep", 30, homeConditions);
  assert.equal(noticeClearingActivity(state, { still: true }), true);
  assert.equal(state.stage, "home-return");
  assert.deepEqual(state.position, state.homeRoute.points.at(-1));
  const frame = clearingActivityFrame(state, { still: true });
  assert.equal(frame.homeSleeping, false); assert.equal(frame.opacity, 1); assert.equal(frame.pose, "idle");
  advance(state, 30, { ...homeConditions, enabled: false });
  assert.deepEqual(state.position, state.homeRoute.points.at(-1));
  const outside = createClearingActivity(scene([route("nap", "rest")]), 1);
  until(outside, s => clearingActivityFrame(s).pose === "sleep");
  noticeClearingActivity(outside, { still: true });
  assert.equal(outside.stage, "return"); assert.equal(outside.steps.length, 0);
});

test("switching to reduced motion settles an already-running attention or exit", () => {
  const state = createClearingActivity(scene([route("nap", "rest")]), 1);
  until(state, s => clearingActivityFrame(s).pose === "sleep");
  noticeClearingActivity(state); advance(state, .2);
  noticeClearingActivity(state, { still: true });
  assert.equal(state.stage, "return"); assert.equal(clearingActivityFrame(state).attention, false);
  const resident = createClearingActivity(residenceScene(), 1);
  requestClearingSleep(resident); until(resident, s => s.stage === "home-sleep", 30, homeConditions);
  noticeClearingActivity(resident); advance(resident, .3, homeConditions);
  noticeClearingActivity(resident, { still: true });
  assert.equal(resident.stage, "home-return"); assert.equal(clearingActivityFrame(resident).attention, false);
  assert.equal(clearingActivityFrame(resident).opacity, 1);
});

test("a requested sleep cannot leave a permanent retirement flag when the home is unavailable", () => {
  const state = createClearingActivity(residenceScene(), 1);
  assert.equal(requestClearingSleep(state), true);
  advanceClearingActivity(state, .025, { ...homeConditions, homeAvailable: false });
  assert.equal(state.retiring, false); assert.equal(canStartClearingLife(state), true);
});

test("rain replaces an exposed outdoor nap with grooming", () => {
  const state = createClearingActivity(scene([route("nap", "rest")]), 5);
  until(state, s => s.stage === "activity", 30, { ...conditions, rain: 1 });
  assert.ok(state.steps.some(step => step.pose === "groom"));
  assert.ok(state.steps.every(step => !["yawn", "drowsy", "sleep"].includes(step.pose)));
});
