import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createBuilderMind, advanceBuilderMind, builderMindFrame, noticeBuilderMind, BUILDER_MIND_LIMITS } = await vite.ssrLoadModule("/features/world/builder-mind.ts");
const { builderLocalPlaces, builderWorkStops, builderRoute } = await vite.ssrLoadModule("/features/world/builder-navigation.ts");
const { BUILDER } = await vite.ssrLoadModule("/features/world/builder-types.ts");
const { isWalkable, canTraverse } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const start = Date.parse("2026-10-06T12:00:00Z"), finish = start + 3600_000;
const job = (stationId = "home", id = stationId) => ({ id, stationId, targetLevel: 2,
  startedAt: new Date(start).toISOString(), finishesAt: new Date(finish).toISOString() });
const snapshot = (jobs = [job()], revision = 1) => ({ ownerPublicId: "builder-owner", revision, jobs });
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
function fixture(overrides = {}) {
  const geometry = { bounds: { x: 180, y: 60, width: 80, height: 90 }, anchor: { x: 220, y: 100 },
    entry: { x: 220, y: 140 }, hitArea: rect(180, 60, 80, 80), collision: rect(200, 75, 40, 50) };
  return { schemaVersion: 1, id: "builder-fixture", width: 300, height: 240, terrain: [],
    focus: { x: 0, y: 0, width: 300, height: 240 }, actor: { spawn: { x: 70, y: 145 }, size: 50 },
    sites: [{ id: "home", label: "Дом", initialLevel: 1, ...geometry,
      states: [{ level: 1, label: "Дом", image: "/test-home.webp" },
        { level: 2, label: "Дом 2", image: "/test-home-2.webp", geometry: { ...geometry, collision: rect(195, 70, 50, 62) } }] }],
    paths: [], destinations: [],
    navigation: { version: 1, cellSize: 6, areas: [{ id: "land", points: rect(0, 0, 300, 240) }],
      obstacles: [{ id: "wall", points: rect(146, 70, 14, 120) }],
      interests: [{ id: "look", position: { x: 95, y: 210 }, activity: "look" },
        { id: "rest", position: { x: 230, y: 205 }, activity: "rest" }] }, ...overrides };
}
function advance(mind, scene, construction, seconds, now = start, dt = .1) {
  const nav = builderLocalPlaces(scene)?.navigation;
  for (let elapsed = 0; elapsed < seconds - 1e-7; elapsed += dt) {
    const before = { ...mind.position };
    advanceBuilderMind(mind, scene, Math.min(dt, seconds - elapsed), { now, construction });
    if (mind.available) {
      assert.ok(isWalkable(nav, mind.position), "worker's complete support remains on walkable land");
      assert.ok(canTraverse(nav, before, mind.position), "visible movement does not cut a wall corner");
      assert.ok(Math.hypot(mind.position.x - before.x, mind.position.y - before.y) <= BUILDER.speed * dt + .001,
        "the feet never teleport to the destination");
    }
  }
}

test("builder reaches a confirmed job around obstacles and animation never completes it", () => {
  const scene = fixture(), mind = createBuilderMind(scene), construction = snapshot(), saved = structuredClone(construction);
  assert.ok(mind); assert.notDeepEqual(mind.position, scene.actor.spawn);
  advance(mind, scene, construction, 30);
  assert.equal(mind.action, "work"); assert.equal(mind.job.id, "home");
  const position = { ...mind.position };
  advance(mind, scene, construction, 60, start);
  assert.equal(mind.action, "work"); assert.deepEqual(mind.position, position);
  assert.deepEqual(construction, saved, "cosmetic work cannot award or remove the economy job");
  const frame = builderMindFrame(mind, scene, false);
  assert.equal(frame.targetId, "home"); assert.ok(frame.phase >= 0 && frame.phase < 1);
});

test("absolute completion waits at the building until a confirmed claim, including zero-delta updates", () => {
  const scene = fixture(), mind = createBuilderMind(scene), construction = snapshot();
  advance(mind, scene, construction, 30);
  const position = { ...mind.position }, elapsed = mind.elapsed;
  advanceBuilderMind(mind, scene, 0, { construction, now: finish });
  assert.equal(mind.action, "idle"); assert.equal(mind.ready, true); assert.equal(mind.elapsed, elapsed);
  advance(mind, scene, construction, 90, finish + 10_000);
  assert.deepEqual(mind.position, position); assert.equal(mind.job.id, "home");
  const beforeClaim = mind.elapsed;
  advanceBuilderMind(mind, scene, 0, { construction: snapshot([], 2), now: finish + 20_000 });
  assert.equal(mind.job, null); assert.equal(mind.action, "finish"); assert.equal(mind.elapsed, beforeClaim);
  assert.deepEqual(mind.position, position, "claim plans a safe return without teleporting");
  advance(mind, scene, snapshot([], 2), 20, finish + 20_000);
  assert.ok(mind.available); assert.notDeepEqual(mind.position, position);
});

test("work has a bounded single/double tap rhythm, a pouch check and a pause without changing job progress", () => {
  const scene = fixture(), mind = createBuilderMind(scene), construction = snapshot();
  advance(mind, scene, construction, 30);
  const position = { ...mind.position }, deadline = mind.job.finishesAt;
  const frameAt = age => { mind.age = age; return builderMindFrame(mind, scene, false); };
  assert.equal(frameAt(.55).phase, .25, "the first tap is measured");
  for (const age of [2.475, 3.575]) {
    const frame = frameAt(age);
    assert.equal(frame.action, "work"); assert.ok(Math.abs(frame.phase - .25) < 1e-8, "two short taps follow");
  }
  assert.equal(frameAt(5.2).action, "inspect"); assert.equal(frameAt(7).action, "idle");
  assert.equal(frameAt(8.8 + .55).action, "work");
  assert.equal(mind.action, "work"); assert.equal(mind.job.finishesAt, deadline);
  assert.deepEqual(mind.position, position);
  mind.age = 5.2;
  const still = builderMindFrame(mind, scene, true), before = structuredClone(mind);
  for (let i = 0; i < 10; i++) assert.deepEqual(builderMindFrame(mind, scene, true), still);
  assert.deepEqual(mind, before, "sampling never advances the activity");
});

test("a finish gesture pauses only animation, survives replanning and yields immediately to the next confirmed job", () => {
  const scene = fixture(), mind = createBuilderMind(scene), construction = snapshot();
  advance(mind, scene, construction, 30);
  const position = { ...mind.position }, direction = mind.direction, empty = snapshot([], 2);
  advanceBuilderMind(mind, scene, 0, { now: finish, construction: empty });
  assert.equal(mind.action, "finish"); assert.ok(mind.route);
  advance(mind, scene, empty, .5, finish);
  assert.deepEqual(mind.position, position); assert.equal(mind.direction, direction);
  const replacementScene = structuredClone(scene), age = mind.age;
  advanceBuilderMind(mind, replacementScene, 0, { now: finish, construction: empty });
  assert.equal(mind.action, "finish"); assert.equal(mind.age, age); assert.deepEqual(mind.position, position);
  const next = snapshot([job("warehouse", "next")], 3);
  advanceBuilderMind(mind, replacementScene, 0, { now: start, construction: next });
  assert.notEqual(mind.action, "finish"); assert.equal(mind.job.id, "next");
  advance(mind, replacementScene, next, 20);
  advanceBuilderMind(mind, replacementScene, 0, { now: finish, construction: snapshot([], 4) });
  advance(mind, replacementScene, snapshot([], 4), BUILDER_MIND_LIMITS.finish + .2, finish);
  assert.notEqual(mind.action, "finish", "the acknowledgement cannot hold the builder forever");
});

test("a speed-up/removal on the road returns from actual feet; replacement jobs take priority over wandering", () => {
  const scene = fixture(), mind = createBuilderMind(scene);
  advance(mind, scene, snapshot(), 3);
  assert.equal(mind.action, "walk");
  const position = { ...mind.position };
  advanceBuilderMind(mind, scene, 0, { now: start, construction: snapshot([], 2) });
  assert.deepEqual(mind.position, position); assert.equal(mind.job, null);
  advance(mind, scene, snapshot([], 2), 12);
  noticeBuilderMind(mind); advance(mind, scene, snapshot([], 2), 1);
  advanceBuilderMind(mind, scene, 0, { now: start, construction: snapshot([job("warehouse", "new")], 3) });
  assert.equal(mind.job.id, "new"); assert.equal(mind.noticePending, false);
  advance(mind, scene, snapshot([job("warehouse", "new")], 3), 30);
  assert.equal(mind.action, "work");
});

test("two legacy jobs select one deterministically and keep the ready oldest job occupied", () => {
  const scene = fixture(), mind = createBuilderMind(scene);
  const first = { ...job("home", "a"), finishesAt: new Date(start + 1000).toISOString() };
  const second = job("warehouse", "b"), construction = snapshot([second, first]);
  advance(mind, scene, construction, 30, start + 2000);
  assert.equal(mind.job.id, "a"); assert.equal(mind.action, "idle"); assert.equal(construction.jobs.length, 2);
  advanceBuilderMind(mind, scene, 0, { now: start + 2000, construction: snapshot([second], 2) });
  assert.equal(mind.job.id, "b");
  advance(mind, scene, snapshot([second], 2), 2, start + 2000);
  assert.equal(mind.action, "work");
});

test("unreachable and missing hosts settle safely without path searches every frame", () => {
  const scene = fixture();
  scene.navigation.obstacles[0].points = rect(146, 0, 14, 240);
  const mind = createBuilderMind(scene), initial = { ...mind.position };
  advance(mind, scene, snapshot(), 50);
  assert.equal(mind.blocked, true); assert.equal(mind.decisions, 1); assert.equal(mind.action, "idle");
  assert.deepEqual(mind.position, initial);
  advance(mind, scene, snapshot([job("missing")], 2), 50);
  assert.equal(mind.decisions, 2); assert.equal(mind.action, "idle"); assert.deepEqual(mind.position, initial);
});

test("changed geometry replans from actual feet and never authorizes walking through a new blocker", () => {
  const scene = fixture(), mind = createBuilderMind(scene), construction = snapshot();
  const initial = { ...mind.position };
  advance(mind, scene, construction, .5);
  assert.notDeepEqual(mind.position, initial, "change geometry while already on the approach");
  const position = { ...mind.position }, changed = structuredClone(scene);
  changed.navigation.obstacles.push({ id: "new-wall", points: rect(170, 160, 35, 40) });
  assert.ok(isWalkable(builderLocalPlaces(changed).navigation, position), "the new wall is ahead of the worker, not under the feet");
  advanceBuilderMind(mind, changed, 0, { construction, now: start });
  assert.deepEqual(mind.position, position); assert.equal(mind.decisions, 2);
  advance(mind, changed, construction, 40); assert.equal(mind.action, "work");
  const buried = structuredClone(changed);
  buried.navigation.obstacles.push({ id: "unsafe-editor-change", points: rect(mind.position.x - 8, mind.position.y - 8, 16, 16) });
  const before = { ...mind.position };
  advanceBuilderMind(mind, buried, .1, { construction, now: start });
  assert.equal(mind.available, false); assert.deepEqual(mind.position, before);
  assert.equal(builderMindFrame(mind, buried, false), null);
  advanceBuilderMind(mind, changed, 0, { construction, now: start });
  assert.equal(mind.available, true); assert.deepEqual(mind.position, before);
});

test("hidden/reduced-motion updates and repeated frame reads advance no cosmetic time or feet", () => {
  const scene = fixture(), mind = createBuilderMind(scene), construction = snapshot(), position = { ...mind.position };
  advanceBuilderMind(mind, scene, 0, { now: start, construction });
  const before = structuredClone(mind);
  for (let i = 0; i < 100; i++) {
    const frame = builderMindFrame(mind, scene, true);
    assert.equal(frame.action, "idle"); assert.equal(frame.frame, 0);
  }
  assert.deepEqual(mind, before);
  for (const dt of [0, -1, NaN, Infinity]) advanceBuilderMind(mind, scene, dt, { now: finish, construction });
  assert.deepEqual(mind.position, position); assert.equal(mind.elapsed, 0); assert.equal(mind.ready, true);
});

test("idle wandering is deterministic, bounded and never invents construction work", () => {
  const scene = fixture(), first = createBuilderMind(scene), second = createBuilderMind(scene);
  const positions = new Set();
  for (let i = 0; i < 1500; i++) {
    advance(first, scene, snapshot([]), .2, start, .2);
    advance(second, scene, snapshot([]), .2, start, .2);
    positions.add(`${Math.round(first.position.x)}:${Math.round(first.position.y)}`);
    assert.notEqual(first.action, "work");
  }
  assert.deepEqual(first, second); assert.ok(positions.size > 20); assert.ok(first.decisions < 40);
});

test("actual Tiled hosts and all authored building levels have safe work routes and future exterior clearance", () => {
  const initial = initialPreviewLevels(TILED_WORLD);
  const variants = [initial, ...TILED_WORLD.sites.flatMap(site => site.states.filter(state => state.level !== initial[site.id])
    .map(state => ({ ...initial, [site.id]: state.level })))];
  for (const levels of variants) {
    const scene = previewWorldScene(TILED_WORLD, levels), places = builderLocalPlaces(scene);
    assert.ok(places, `rest exists at ${JSON.stringify(levels)}`);
    assert.ok(Math.hypot(places.rest.position.x - scene.actor.spawn.x, places.rest.position.y - scene.actor.spawn.y) >= 45);
    for (const stationId of ["home", "warehouse", "workshop", "kiln", "garden", "woodlot", "quarry", "dryer"]) {
      const active = { ...job(stationId), targetLevel: Math.min(5, (levels[stationId] ?? 1) + 1) };
      const stops = builderWorkStops(scene, active), route = builderRoute(places, places.rest.position, stops);
      assert.ok(route, `${stationId} is reachable at ${JSON.stringify(levels)}`);
      for (let i = 1; i < route.path.points.length; i++) assert.ok(canTraverse(places.navigation, route.path.points[i - 1], route.path.points[i]));
      if (stationId === "home" || stationId === "workshop") {
        const next = previewWorldScene(TILED_WORLD, { ...levels, [stationId]: active.targetLevel });
        assert.ok(isWalkable(builderLocalPlaces(next).navigation, route.target.position), "claiming upgraded artwork cannot trap the worker");
      }
    }
  }
});

test("actual map worker completes each host approach and remains continuous when claimed artwork changes", () => {
  const initial = initialPreviewLevels(TILED_WORLD), scene = previewWorldScene(TILED_WORLD, initial);
  for (const stationId of ["home", "warehouse", "workshop", "kiln", "garden", "woodlot", "quarry", "dryer"]) {
    const mind = createBuilderMind(scene), construction = snapshot([job(stationId)]);
    for (let elapsed = 0; elapsed < 180 && mind.action !== "work"; elapsed += .25)
      advance(mind, scene, construction, .25, start, .25);
    assert.equal(mind.action, "work", `${stationId} arrives within a finite safe walk`);
    if (stationId === "home") {
      const position = { ...mind.position }, upgraded = previewWorldScene(TILED_WORLD, { ...initial, home: 2 });
      advanceBuilderMind(mind, upgraded, 0, { now: finish, construction: snapshot([], 2) });
      assert.equal(mind.available, true); assert.deepEqual(mind.position, position);
      advance(mind, upgraded, snapshot([], 2), 30, finish);
      assert.ok(mind.available); assert.notDeepEqual(mind.position, position);
    }
  }
});
