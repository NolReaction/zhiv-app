import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createPleskMind, advancePleskMind, rehydratePleskMind, requestPleskWalk, requestPleskHome, requestPleskSocialVisit, pleskMindFrame }
  = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-mind.ts");
const { pleskLocalPlaces, pleskTravelTime, samplePleskTrail, PLESK } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-resident.ts");
const { passageYields } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-traffic.ts");
const { canTraverse, isWalkable, findWorldPath } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const first = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), home: 1 });
const second = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), home: 2 });
const day = { rain: 0, dusk: 0 };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
function tick(mind, scene, env = day) {
  const before = { ...mind.position }, nav = ["enter", "inside", "exit"].includes(mind.home.phase)
    ? mind.home.door.navigation : pleskLocalPlaces(scene).nav;
  advancePleskMind(mind, scene, .1, env);
  assert.ok(distance(before, mind.position) <= PLESK.speed * .1 + .001, "only normal active movement may change the feet");
  if (mind.available) assert.ok(canTraverse(nav, before, mind.position));
}
function until(mind, scene, predicate, env = day, limit = 1500) {
  for (let i = 0; i < limit && !predicate(); i++) tick(mind, scene, env);
  assert.ok(predicate(), JSON.stringify(mind.observation));
}
function walking() {
  const mind = createPleskMind(first, 9), places = pleskLocalPlaces(first);
  assert.equal(requestPleskWalk(mind, first, places.rest), true);
  for (let i = 0; i < 30; i++) tick(mind, first);
  return mind;
}

test("unrelated actual house geometry preserves the same walking feet, age, goal and independent mutable state", () => {
  const previous = walking(), before = JSON.stringify(previous), next = rehydratePleskMind(second, previous);
  assert.ok(next); assert.equal(next.scene, second); assert.equal(next.available, true);
  assert.deepEqual(next.position, previous.position); assert.equal(next.elapsed, previous.elapsed); assert.equal(next.age, previous.age);
  assert.equal(next.stage.target.id, previous.stage.target.id); assert.deepEqual(next.queue, previous.queue);
  for (const key of ["needs", "recent", "position", "stage", "queue", "home", "observation"]) assert.notEqual(next[key], previous[key], key);
  assert.notEqual(next.stage.target, previous.stage.target); assert.notEqual(next.stage.target.position, previous.stage.target.position);
  assert.notEqual(next.stage.trail, previous.stage.trail); assert.notEqual(next.stage.trail.points, previous.stage.trail.points);
  assert.notEqual(next.stage.trail.points[0], previous.stage.trail.points[0]); assert.notEqual(next.stage.trail.distances, previous.stage.trail.distances);
  assert.notEqual(next.observation.needs, previous.observation.needs);
  tick(next, second); assert.equal(JSON.stringify(previous), before, "the passive old camera cannot share changed feet or needs");
  assert.ok(distance(next.position, previous.position) > 0);
});

test("a real packing gesture and queued work retain their one catch without replaying or granting it during handoff", () => {
  const previous = createPleskMind(first, 9);
  until(previous, first, () => previous.stage.action === "pack" && previous.age > .6);
  const before = JSON.stringify(previous), count = previous.catchCount;
  const next = rehydratePleskMind(second, previous);
  assert.equal(next.stage.action, "pack"); assert.equal(next.stage.deposit, true); assert.equal(next.age, previous.age);
  assert.equal(next.castTarget == null, previous.castTarget == null);
  if (next.castTarget) assert.notEqual(next.castTarget, previous.castTarget);
  assert.equal(next.catchCount, count); assert.deepEqual(next.queue, previous.queue);
  next.queue.forEach((stage, index) => { assert.notEqual(stage, previous.queue[index]); assert.notEqual(stage.target, previous.queue[index].target); });
  until(next, second, () => next.stage.action !== "pack");
  assert.equal(next.catchCount, count + 1); assert.equal(JSON.stringify(previous), before);
  const repeat = rehydratePleskMind(second, next); assert.equal(repeat.catchCount, count + 1, "reading another camera never deposits again");
});

test("an unchanged personal doorway preserves its partial fade and indoor rest across an unrelated improvement", () => {
  const previous = createPleskMind(first, 9); assert.equal(requestPleskHome(previous), true);
  until(previous, first, () => previous.home.phase === "enter" && previous.home.progress > .3);
  const next = rehydratePleskMind(second, previous), frame = pleskMindFrame(previous, first, false);
  assert.equal(next.available, true); assert.deepEqual(next.position, previous.position);
  assert.equal(next.home.progress, previous.home.progress); assert.equal(next.elapsed, previous.elapsed);
  assert.equal(pleskMindFrame(next, second, false).opacity, frame.opacity);
  tick(next, second);
  until(next, second, () => next.home.phase === "inside");
  const inside = rehydratePleskMind(first, next);
  assert.equal(inside.home.phase, "inside"); assert.equal(inside.home.until, next.home.until);
  assert.deepEqual(inside.position, next.position); assert.equal(pleskMindFrame(inside, first, false), null);
});

test("a moved personal threshold fails closed with its real feet, clocks and catch untouched", () => {
  const previous = createPleskMind(first, 9); requestPleskHome(previous);
  until(previous, first, () => previous.home.phase === "enter" && previous.home.progress > .3);
  const moved = { ...second, sites: second.sites.map(site => site.id === "plesk-shop"
    ? { ...site, doorway: { x: site.doorway.x + 12, y: site.doorway.y } } : site) };
  const next = rehydratePleskMind(moved, previous), feet = { ...next.position }, elapsed = next.elapsed, count = next.catchCount;
  assert.equal(next.available, false);
  for (let i = 0; i < 50; i++) advancePleskMind(next, moved, .1, day);
  assert.equal(next.available, false); assert.deepEqual(next.position, feet); assert.equal(next.elapsed, elapsed); assert.equal(next.catchCount, count);
});

test("a newly blocked traversed prefix replans from current feet while the safe remaining goal survives", () => {
  const previous = walking(), prefix = samplePleskTrail(previous.stage.trail, 1.5), target = previous.stage.target;
  const changed = { ...second, navigation: { ...second.navigation, obstacles: [...second.navigation.obstacles,
    { id: "changed-ground-behind-plesk", points: rect(prefix.x - 2, prefix.y - 2, 4, 4) }] } };
  const nav = pleskLocalPlaces(changed).nav;
  assert.equal(isWalkable(nav, prefix), false); assert.ok(isWalkable(nav, previous.position));
  assert.ok(findWorldPath(nav, previous.position, target.position));
  const next = rehydratePleskMind(changed, previous);
  assert.equal(next.available, true); assert.deepEqual(next.position, previous.position); assert.equal(next.elapsed, previous.elapsed);
  assert.equal(next.age, 0); assert.deepEqual(next.stage.trail.points[0], previous.position); assert.equal(next.stage.target.id, target.id);
  until(next, changed, () => next.stopId === target.id); assert.equal(next.catchCount, previous.catchCount);
});

test("queued walks use new checked endpoints before pending gestures without snapping or applying their transfers", () => {
  const scene = { schemaVersion: 1, id: "plesk-queued-geometry", width: 600, height: 300, terrain: [], sites: [], paths: [],
    focus: { x: 0, y: 0, width: 600, height: 300 }, actor: { spawn: { x: 100, y: 100 }, size: 50 },
    destinations: [{ id: "plesk-fishing", position: { x: 100, y: 100 }, pauseSeconds: 4 },
      { id: "plesk-trade", position: { x: 500, y: 100 }, pauseSeconds: 4 },
      { id: "plesk-rest", position: { x: 100, y: 200 }, pauseSeconds: 4 }],
    navigation: { version: 1, cellSize: 8, areas: [{ id: "ground", points: rect(0, 0, 600, 300) }], obstacles: [], interests: [] } };
  const previous = createPleskMind(scene, 9), places = pleskLocalPlaces(scene);
  previous.stage = { action: "idle", duration: .01, target: places.base };
  previous.queue = [{ action: "walk", target: places.rest, trail: places.toRest, duration: pleskTravelTime(places.toRest) },
    { action: "pack", target: places.rest, duration: 1, deposit: true, species: "fish" }];
  previous.intent = "rest";
  const changed = { ...scene, destinations: scene.destinations.map(stop => stop.id === "plesk-rest"
    ? { ...stop, position: { x: 160, y: 200 } } : stop) };
  const next = rehydratePleskMind(changed, previous), goal = pleskLocalPlaces(changed).rest;
  assert.equal(next.available, true); assert.deepEqual(next.position, previous.position); assert.equal(next.catchCount, 0);
  assert.deepEqual(next.queue[0].trail.points[0], places.base.position);
  assert.deepEqual(next.queue[0].trail.points.at(-1), goal.position);
  assert.deepEqual(next.queue[1].target.position, goal.position); assert.equal(next.queue[1].deposit, true);
  until(next, changed, () => next.stage.action === "pack");
  assert.deepEqual(next.position, goal.position); assert.equal(next.catchCount, 0, "handoff and travel never deposit the pending catch");
  until(next, changed, () => next.stage.action !== "pack");
  assert.equal(next.catchCount, 1); assert.equal(previous.catchCount, 0);
});

test("a blocked current goal cannot execute an old trail or manufacture arrival", () => {
  const previous = walking(), target = previous.stage.target.position;
  const changed = { ...second, navigation: { ...second.navigation, obstacles: [...second.navigation.obstacles,
    { id: "new-goal-blocker", points: rect(target.x - 10, target.y - 10, 20, 20) }] } };
  const next = rehydratePleskMind(changed, previous), feet = { ...next.position }, elapsed = next.elapsed;
  assert.equal(next.available, false);
  for (let i = 0; i < 50; i++) advancePleskMind(next, changed, .1, day);
  assert.equal(next.available, false); assert.deepEqual(next.position, feet); assert.equal(next.elapsed, elapsed);
  assert.equal(next.stopId, previous.stopId); assert.equal(next.catchCount, previous.catchCount);
});

test("old social ownership is released at actual feet rather than arriving or resuming an unreturned route", () => {
  const previous = walking(), places = pleskLocalPlaces(first);
  assert.equal(requestPleskSocialVisit(previous, first, { id: "builder", position: places.trade.position, size: 40 }), true);
  for (let i = 0; i < 10; i++) tick(previous, first);
  const before = JSON.stringify(previous), next = rehydratePleskMind(second, previous);
  assert.equal(next.available, true); assert.equal(next.socialVisit, undefined); assert.deepEqual(next.position, previous.position);
  assert.equal(next.elapsed, previous.elapsed); assert.equal(next.stage.target.id, "plesk-leisure-pause");
  assert.equal(next.stage.action, "idle"); assert.deepEqual(next.queue, []); assert.equal(next.catchCount, previous.catchCount);
  assert.equal(JSON.stringify(previous), before); assert.ok(previous.socialVisit);
});

test("an in-progress passage yield drops the old reservation and walks back before resuming the saved activity", () => {
  const scene = { schemaVersion: 1, id: "plesk-rehydrate-yield", width: 400, height: 240, terrain: [], sites: [], paths: [],
    focus: { x: 0, y: 0, width: 400, height: 240 }, actor: { spawn: { x: 80, y: 120 }, size: 50 },
    destinations: [{ id: "plesk-fishing", position: { x: 230, y: 120 }, pauseSeconds: 4 },
      { id: "plesk-trade", position: { x: 350, y: 120 }, pauseSeconds: 4 }],
    navigation: { version: 1, cellSize: 5, areas: [{ id: "ground", points: rect(0, 0, 400, 240) }], obstacles: [], interests: [] } };
  const previous = createPleskMind(scene, 9), requester = { id: "mochlik", position: { x: 190, y: 120 }, size: 50, moving: true,
    intent: { points: [{ x: 190, y: 120 }, { x: 300, y: 120 }], target: { x: 300, y: 120 }, priority: 3 } };
  until(previous, scene, () => passageYields.get(previous)?.phase === "wait", { ...day, socialHold: true, occupants: [requester] });
  const saved = passageYields.get(previous), target = saved.stage.target;
  const changed = { ...scene, id: "updated-plesk-yield-art" }, next = rehydratePleskMind(changed, previous);
  assert.equal(next.available, true); assert.equal(passageYields.has(next), false); assert.deepEqual(next.position, previous.position);
  assert.equal(next.stage.action, "walk"); assert.equal(next.stage.target.id, target.id);
  assert.equal(next.queue[0].action, saved.stage.action); assert.equal(next.catchCount, previous.catchCount);
  until(next, changed, () => next.stopId === target.id); assert.equal(next.catchCount, previous.catchCount);
});
