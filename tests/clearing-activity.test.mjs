import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createClearingActivity, advanceClearingActivity, clearingActivityFrame,
  clearingRouteDiagnostics, isClearingAtHome, returnClearingHome } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
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
  assert.ok(poses.has("walk") && poses.has("wonder") && poses.has("stretch"));
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
