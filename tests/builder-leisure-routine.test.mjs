import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const load = path => vite.ssrLoadModule(`/features/world/${path}.ts`);
const { createBuilderMind, advanceBuilderMind, noticeBuilderMind, requestBuilderVisit, BUILDER_MIND_LIMITS } =
  await load("characters/builder/builder-mind");
const { builderLocalPlaces, builderRoute } = await load("characters/builder/builder-navigation");
const { canTraverse, isWalkable } = await load("navigation/navigation");
const { canTraverseResidents } = await load("navigation/resident-traffic");
const { TILED_WORLD } = await load("scene/presentation");
const { previewWorldScene } = await load("tiled/preview-state");
const now = Date.parse("2026-10-17T10:00:00Z");
const construction = jobs => ({ ownerPublicId: "builder-habits", revision: jobs.length ? 1 : 2, jobs });
const empty = construction([]);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const world = () => previewWorldScene(TILED_WORLD, { home: 3, workshop: 1, quarry: 1, woodlot: 3 });

function step(mind, scene, env = {}, dt = .05) {
  const before = { ...mind.position }, nav = builderLocalPlaces(scene).navigation;
  advanceBuilderMind(mind, scene, dt, { now, construction: empty, ...env });
  assert.ok(isWalkable(nav, mind.position), "actual Tiled ground supports every visible step");
  assert.ok(canTraverse(nav, before, mind.position), "the real route never cuts the building or water");
  assert.ok(distance(before, mind.position) <= 34 * Math.min(dt, 1) + 1e-7, "waiting and resume never teleport");
  if (env.occupants) assert.ok(canTraverseResidents(before, mind.position, 40, env.occupants, "builder"));
}

function nearGoal(scene, facade = false) {
  const places = builderLocalPlaces(scene), mind = createBuilderMind(scene);
  const goal = places.wander.find(stop => facade ? stop.id.startsWith("builder-look-") : stop.id === "clearing-grass-look");
  const full = builderRoute(places, mind.position, [goal]);
  assert.ok(full, "authored route connects the clearing and the chosen stop");
  mind.position = { ...full.path.points.findLast(point => distance(point, goal.position) > 60) };
  const selected = builderRoute(places, mind.position, [goal]);
  assert.ok(selected); mind.route = selected.path; mind.target = selected.target; mind.action = "walk";
  return mind;
}

test("temporary occupied optional goal is retained, then reached from the same feet after the neighbour leaves", () => {
  const scene = world(), mind = nearGoal(scene), target = structuredClone(mind.target);
  const neighbour = { id: "test-neighbour", position: { ...target.position }, size: 40 };
  let firstWait = null;
  for (let at = 0; at < 8; at += .05) {
    step(mind, scene, { occupants: [neighbour] });
    assert.deepEqual(mind.target, target, "a short blockage cannot replace a meaningful optional target");
    if (mind.trafficWaiting) firstWait ??= mind.elapsed;
    if (firstWait !== null && mind.elapsed - firstWait > 1) break;
  }
  assert.ok(firstWait !== null); assert.equal(mind.idleAvoid, null);
  const decisions = mind.decisions;
  for (let at = 0; at < 10 && mind.route; at += .05) step(mind, scene);
  assert.equal(mind.route, null); assert.deepEqual(mind.position, target.position);
  assert.equal(mind.decisions, decisions, "resume uses the same checked route without a new decision");
});

test("a continuous optional blockage gets a bounded checked retreat and cools that destination down", () => {
  const scene = world(), mind = nearGoal(scene), target = structuredClone(mind.target);
  const neighbour = { id: "test-neighbour", position: { ...target.position }, size: 40 };
  let waitedAt = null, gaveUpAt = null;
  for (let at = 0; at < 12; at += .05) {
    step(mind, scene, { occupants: [neighbour] });
    if (mind.trafficWaiting) waitedAt ??= mind.elapsed;
    if (mind.target?.id === "builder-yield") gaveUpAt ??= mind.elapsed;
    if (gaveUpAt !== null && !mind.route) break;
  }
  assert.ok(waitedAt !== null && gaveUpAt !== null);
  assert.ok(gaveUpAt - waitedAt >= BUILDER_MIND_LIMITS.trafficPatience - .06);
  assert.ok(gaveUpAt - waitedAt < 4);
  assert.equal(mind.idleAvoid.id, target.id); assert.ok(mind.idleAvoid.until > mind.elapsed + 20);
  mind.wait = 0;
  step(mind, scene, { occupants: [neighbour] });
  assert.notEqual(mind.target?.id, target.id, "the next optional decision skips the failed destination");
  assert.equal(mind.job, null); assert.equal(mind.socialVisit, null); assert.ok(mind.decisions <= 2);
});

test("a completely enclosed free builder defers the optional goal at his current feet instead of waiting forever", () => {
  const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  const scene = { ...world(), width: 400, height: 300, terrain: [], sites: [], water: undefined, campfires: [], bushes: [],
    actor: { spawn: { x: 60, y: 150 }, size: 50 }, destinations: [{ id: "builder-rest", position: { x: 120, y: 150 } }],
    navigation: { version: 1, cellSize: 6, areas: [{ id: "test-clearing", points: rect(0, 0, 400, 300) }],
      obstacles: [], interests: [{ id: "blocked-stroll", position: { x: 300, y: 150 }, activity: "look" }] } };
  const places = builderLocalPlaces(scene), mind = createBuilderMind(scene), feet = { ...mind.position };
  const target = places.wander.find(stop => stop.id === "blocked-stroll"), route = builderRoute(places, feet, [target]);
  assert.ok(route); mind.target = route.target; mind.route = route.path; mind.action = "walk";
  const occupants = Array.from({ length: 8 }, (_, index) => ({ id: `parked-${index}`, size: 40,
    position: { x: feet.x + Math.cos(index * Math.PI / 4) * 24.5, y: feet.y + Math.sin(index * Math.PI / 4) * 24.5 } }));
  for (let index = 0; index < 32; index++) {
    const angle = index * Math.PI / 16, candidate = { x: feet.x + Math.cos(angle) * 34, y: feet.y + Math.sin(angle) * 34 };
    assert.equal(canTraverseResidents(feet, candidate, 40, occupants, "builder"), false, "every escape direction is occupied");
  }
  let waitedAt = null, deferredAt = null;
  for (let at = 0; at < 6; at += .05) {
    const before = { ...mind.position }; step(mind, scene, { occupants });
    if (mind.trafficWaiting) waitedAt ??= mind.elapsed;
    if (!mind.route) { deferredAt = mind.elapsed; assert.deepEqual(mind.position, before, "giving up does not move the feet"); break; }
  }
  assert.ok(waitedAt !== null && deferredAt !== null);
  assert.ok(deferredAt - waitedAt >= BUILDER_MIND_LIMITS.trafficPatience - .06 && deferredAt - waitedAt < 4);
  assert.equal(mind.action, "idle"); assert.equal(mind.target, null); assert.equal(mind.route, null);
  assert.equal(mind.trafficWaiting, false); assert.equal(mind.blocked, false);
  assert.equal(mind.idleAvoid.id, target.id); assert.ok(mind.idleAvoid.until - mind.elapsed >= 29.99);
  assert.ok(distance(mind.position, target.position) > 100, "the deferred destination was never reached");
  assert.equal(mind.job, null); assert.equal(mind.socialVisit, null); assert.equal(mind.sleepPhase, "awake");
  const parked = { ...mind.position };
  for (let at = 0; at < 1; at += .05) step(mind, scene, { occupants });
  assert.deepEqual(mind.position, parked); assert.equal(mind.route, null);
});

test("a checked optional escape that becomes occupied also defers, retaining its original goal and cooldown", () => {
  const scene = world(), mind = nearGoal(scene), target = structuredClone(mind.target);
  const neighbour = { id: "parked-goal", position: { ...target.position }, size: 40 };
  for (let at = 0; at < 12 && mind.target?.id !== "builder-yield"; at += .05) step(mind, scene, { occupants: [neighbour] });
  assert.equal(mind.target?.id, "builder-yield"); assert.ok(mind.route, "the first blockage selects an actual checked escape");
  const centre = { ...mind.position }, originalCooldown = structuredClone(mind.idleAvoid);
  assert.equal(originalCooldown.id, target.id);
  const occupants = Array.from({ length: 8 }, (_, index) => ({ id: `newly-parked-${index}`, size: 40,
    position: { x: centre.x + Math.cos(index * Math.PI / 4) * 24.5, y: centre.y + Math.sin(index * Math.PI / 4) * 24.5 } }));
  const startedAt = mind.elapsed;
  for (let at = 0; at < 6 && mind.route; at += .05) {
    const before = { ...mind.position }; step(mind, scene, { occupants });
    if (!mind.route) assert.deepEqual(mind.position, before, "the second deferral remains at actual feet");
  }
  assert.equal(mind.route, null, "a newly blocked escape has the same bounded patience as the original optional walk");
  assert.ok(mind.elapsed - startedAt < 4);
  assert.equal(mind.target, null); assert.equal(mind.action, "idle"); assert.equal(mind.trafficWaiting, false);
  assert.deepEqual(mind.idleAvoid, originalCooldown, "do not overwrite either original goal ID or original expiry with builder-yield");
  assert.equal(mind.job, null); assert.equal(mind.socialVisit, null); assert.equal(mind.sleepPhase, "awake");
});

test("facade stops remain in the bounded actual place list and finish with a short inspection", () => {
  const scene = world(), places = builderLocalPlaces(scene), mind = nearGoal(scene, true);
  const facades = places.wander.filter(stop => stop.id.startsWith("builder-look-"));
  const withoutInterests = structuredClone(scene); withoutInterests.navigation.interests = [];
  const roleOnly = builderLocalPlaces(withoutInterests).wander.filter(stop => stop.id.startsWith("builder-look-"));
  assert.ok(roleOnly.length >= 2, "the current map has reachable facade stops");
  assert.deepEqual(facades.map(stop => stop.id), roleOnly.map(stop => stop.id), "generic interests cannot truncate reachable role places");
  assert.ok(facades.some(stop => stop.id === "builder-look-lopukh-home"));
  for (const facade of facades) {
    assert.ok(builderRoute(places, places.rest.position, [facade]));
    for (const site of scene.sites) assert.ok(distance(facade.position, site.entry) >= 45 - 1e-7, "facade pause leaves doors free");
  }
  for (let at = 0; at < 15 && mind.route; at += .05) step(mind, scene);
  assert.equal(mind.route, null); assert.equal(mind.action, "inspect");
  const feet = { ...mind.position };
  for (let at = 0; at < 2; at += .05) step(mind, scene);
  assert.deepEqual(mind.position, feet); assert.equal(mind.action, "inspect");
  for (let at = 0; at < 1; at += .05) step(mind, scene);
  assert.equal(mind.action, "idle"); assert.deepEqual(mind.position, feet);
});

test("only actual confirmed work ending at its exterior produces a finish inspection, and the next job wins", () => {
  const scene = world(), mind = createBuilderMind(scene, { awaitConstruction: true });
  const order = { id: "built-house", stationId: "home", targetLevel: 4,
    startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 3600_000).toISOString() };
  advanceBuilderMind(mind, scene, 0, { now, construction: construction([order]) });
  assert.equal(mind.action, "work"); const feet = { ...mind.position };
  advanceBuilderMind(mind, scene, 0, { now, construction: empty });
  assert.equal(mind.action, "finish");
  for (let at = 0; at < BUILDER_MIND_LIMITS.finish + .1; at += .05) step(mind, scene);
  assert.equal(mind.action, "inspect"); assert.deepEqual(mind.position, feet);
  const next = { ...order, id: "next-work", stationId: "workshop", targetLevel: 2 };
  advanceBuilderMind(mind, scene, 0, { now, construction: construction([next]) });
  assert.equal(mind.job.id, "next-work"); assert.equal(mind.action, "walk"); assert.deepEqual(mind.position, feet);
  assert.equal(mind.target.id, "workshop");
});

test("an agreed social hold and a player greeting pause an optional walk and resume its actual route", () => {
  const scene = world(), mind = nearGoal(scene), target = structuredClone(mind.target);
  step(mind, scene); const feet = { ...mind.position }, route = mind.route, distanceBefore = mind.distance;
  for (let at = 0; at < 1; at += .05) step(mind, scene, { socialHold: true });
  assert.deepEqual(mind.position, feet); assert.equal(mind.route, route); assert.equal(mind.distance, distanceBefore);
  noticeBuilderMind(mind); step(mind, scene, { socialHold: true });
  assert.equal(mind.action, "greet"); assert.deepEqual(mind.position, feet);
  for (let at = 0; at < 2.2; at += .05) step(mind, scene);
  assert.deepEqual(mind.target, target); assert.ok(distance(mind.position, feet) > 0);
  assert.equal(mind.route, route);
});

test("a naturally due daytime home break waits for the full greeting, while construction and night still interrupt", () => {
  const scene = world(), mind = createBuilderMind(scene);
  while (mind.elapsed < 179.9 - 1e-7) step(mind, scene, {}, .1);
  assert.equal(mind.homeNextAt, 180); assert.equal(mind.sleepPhase, "awake");
  noticeBuilderMind(mind); step(mind, scene, {}, .1);
  assert.equal(mind.action, "greet"); const greetingAt = mind.elapsed, feet = { ...mind.position };
  const working = { ...mind, position: { ...feet } }, night = { ...mind, position: { ...feet } };
  for (let at = 0; at < BUILDER_MIND_LIMITS.greeting - .05; at += .1) {
    step(mind, scene, {}, .1);
    assert.equal(mind.sleepPhase, "awake", "the due optional break cannot cancel the player's active greeting");
    assert.deepEqual(mind.position, feet);
  }
  for (let at = 0; at < 1 && mind.sleepPhase === "awake"; at += .1) step(mind, scene, {}, .1);
  assert.equal(mind.sleepPhase, "approach"); assert.equal(mind.target.id, "builder-home");
  assert.ok(mind.elapsed - greetingAt >= BUILDER_MIND_LIMITS.greeting, "home starts only after the complete greeting");
  const order = { id: "urgent-construction", stationId: "home", targetLevel: 4,
    startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 3600_000).toISOString() };
  step(working, scene, { construction: construction([order]) });
  assert.equal(working.job.id, order.id); assert.equal(working.action, "walk"); assert.equal(working.target.id, "home");
  step(night, scene, { night: true });
  assert.equal(night.sleepPhase, "approach"); assert.equal(night.homeReason, "night"); assert.equal(night.target.id, "builder-home");
});

test("a reserved visit replaces an optional inspection without disturbing the current feet", () => {
  const scene = world(), mind = nearGoal(scene, true);
  for (let at = 0; at < 15 && mind.route; at += .05) step(mind, scene);
  assert.equal(mind.action, "inspect"); const feet = { ...mind.position };
  const target = { id: "test-neighbour", position: { x: feet.x + 25, y: feet.y + 25 }, size: 40, approach: feet };
  assert.equal(requestBuilderVisit(mind, scene, target), true);
  assert.equal(mind.socialVisit.targetId, target.id); assert.equal(mind.action, "idle");
  step(mind, scene); assert.deepEqual(mind.position, feet);
});

test("a promised social wait still clears a real worker's passage before waiting again", () => {
  const scene = world(), places = builderLocalPlaces(scene), mind = createBuilderMind(scene);
  const target = places.wander.find(stop => stop.id === "clearing-grass-look");
  const route = builderRoute(places, mind.position, [target]);
  const index = route.path.distances.findIndex(value => value >= 40), from = route.path.points[index - 1], to = route.path.points[index];
  const ratio = (40 - route.path.distances[index - 1]) / distance(from, to);
  const approach = { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
  const worker = { id: "mochlik", size: 50, position: { ...approach }, moving: true,
    intent: { points: [{ ...approach }, { ...mind.position }], target: { ...mind.position }, priority: 3 } };
  const feet = { ...mind.position }; mind.wait = 1000;
  for (let at = 0; at < 8; at += .05) {
    step(mind, scene, { socialHold: true, occupants: [worker] });
    if (mind.target?.id === "builder-yield" && !mind.route) break;
  }
  assert.equal(mind.target?.id, "builder-yield"); assert.equal(mind.route, null);
  assert.ok(distance(feet, mind.position) > 10, "agreeing to talk cannot park the resident in a worker's held corridor");
  const aside = { ...mind.position };
  for (let at = 0; at < 2; at += .05) step(mind, scene, { socialHold: true });
  assert.deepEqual(mind.position, aside);
});
