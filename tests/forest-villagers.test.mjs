import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestVillagers, rehydrateForestVillagers, configureForestVillagers, advanceForestVillagers, forestVillagerFrames,
  forestVillagerOccupants, requestForestVillagerVisit, cancelForestVillagerVisit, noticeForestVillager,
  settleForestVillagerArrival, FOREST_VILLAGER_LIMITS } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-mind.ts");
const { forestVillagerPlaces, forestVillagerNorthernArrival, FOREST_VILLAGER_PROFILES } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-navigation.ts");
const { isWalkable, canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { canTraverseResidents } = await vite.ssrLoadModule("/features/world/navigation/resident-traffic.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const now = Date.parse("2026-10-16T12:00:00Z");
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
function fixture() {
  const sites = [["quarry", 290, 250], ["lopukh-home", 470, 200], ["leaftail-caravan", 440, 340]].map(([id, x, y]) => ({
    id, label: id, initialLevel: 1, bounds: { x: x - 30, y: y - 45, width: 60, height: 45 },
    anchor: { x, y: y - 15 }, entry: { x, y }, hitArea: rect(x - 30, y - 45, 60, 45), collision: rect(x - 25, y - 40, 50, 28),
    states: [{ level: 1, label: id, image: "/test.webp" }],
  }));
  return { schemaVersion: 1, id: "villager-fixture", width: 600, height: 420,
    focus: { x: 0, y: 0, width: 600, height: 420 }, actor: { spawn: { x: 110, y: 370 }, size: 50 }, terrain: [], sites, paths: [],
    navigation: { version: 1, cellSize: 10, areas: [{ id: "island", points: rect(5, 5, 55, 55) },
      { id: "land", points: rect(80, 80, 500, 320) }], obstacles: [{ id: "wall", points: rect(235, 80, 15, 190) }],
    interests: [{ id: "rest", position: { x: 330, y: 340 }, activity: "rest" }] },
    water: { surfaces: [{ id: "pond", points: rect(90, 150, 55, 90) }], exclusions: [] } };
}
function setup(scene = fixture(), config = {}) {
  const state = createForestVillagers(scene);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { quarry: 1, woodlot: 1 }, arrivalSeen: true, now, ...config });
  return state;
}
function run(state, scene, seconds, environment = {}) {
  for (let elapsed = 0; elapsed < seconds - 1e-7; elapsed += .1) {
    const before = forestVillagerFrames(state), occupants = forestVillagerOccupants(state);
    advanceForestVillagers(state, scene, .1, { now, ...environment });
    for (const frame of forestVillagerFrames(state)) {
      const previous = before.find(value => value.id === frame.id);
      const profile = FOREST_VILLAGER_PROFILES[frame.id], places = forestVillagerPlaces(scene, frame.id);
      assert.ok(isWalkable(places.navigation, frame), `${frame.id} stays on actual safe ground`);
      if (!previous) continue;
      assert.ok(canTraverse(places.navigation, previous, frame), `${frame.id} does not cut an obstacle`);
      assert.ok(Math.hypot(frame.x - previous.x, frame.y - previous.y) <= profile.speed * .1 * FOREST_VILLAGER_LIMITS.arrivalSpeed + .001,
        `${frame.id} has no teleported movement`);
      assert.ok(canTraverseResidents(previous, frame, profile.size,
        occupants.filter(other => other.id !== frame.id), frame.id) || previous.x === frame.x && previous.y === frame.y,
      `${frame.id} respects occupied feet`);
    }
  }
}

test("miner remains hidden until confirmed quarry unlock and explicit free-world arrival permission", () => {
  const scene = fixture(), state = createForestVillagers(scene);
  configureForestVillagers(state, scene, { confirmed: false, buildings: { quarry: 9 }, allowArrival: true, now });
  assert.deepEqual(forestVillagerFrames(state), []); assert.equal(state.arrivalPending, false);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { quarry: 0 }, allowArrival: true, now });
  assert.deepEqual(forestVillagerFrames(state).map(frame => frame.id), ["lopukh", "leaftail"]);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { quarry: 1 }, now });
  assert.equal(state.arrivalPending, true); assert.equal(state.arrivalPhase, "waiting");
  run(state, scene, 3); assert.equal(state.residents.kamneshmyg.available, false);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { quarry: 1 }, allowArrival: true, now });
  assert.equal(state.arrivalPhase, "running");
  const first = forestVillagerFrames(state).find(frame => frame.id === "kamneshmyg");
  assert.ok(first.y >= 80, "disconnected northern island is not an arrival point");
  assert.ok(first.y < 100, "arrival uses the northern reachable grid edge");
  assert.equal(first.arriving, true);
  run(state, scene, 25);
  assert.equal(state.arrivalCompleted, true); assert.equal(state.arrivalPending, false);
  assert.equal(state.arrivalPhase, "complete");
});

test("an unconfirmed account and a map without resident homes do not require navigation geometry", () => {
  // Deferred/unsupported geometry is irrelevant until a confirmed resident can
  // actually appear. Accessing it early must not build extra walking profiles.
  const scene = new Proxy(fixture(), { get(target, key, receiver) {
    if (key === "navigation") throw new Error("navigation is not ready");
    return Reflect.get(target, key, receiver);
  } });
  const state = createForestVillagers(scene);
  assert.doesNotThrow(() => configureForestVillagers(state, scene, { confirmed: false, buildings: { quarry: 1 }, now }));
  assert.doesNotThrow(() => advanceForestVillagers(state, scene, .5, { now }));
  assert.deepEqual(forestVillagerFrames(state), []);
  assert.throws(() => configureForestVillagers(state, scene, { confirmed: true, buildings: { quarry: 1 }, now }), /navigation is not ready/);

  const legacy = new Proxy({ ...fixture(), sites: [] }, { get(target, key, receiver) {
    if (key === "navigation") throw new Error("legacy navigation must remain unused");
    return Reflect.get(target, key, receiver);
  } });
  const unsupported = createForestVillagers(legacy);
  assert.doesNotThrow(() => configureForestVillagers(unsupported, legacy, { confirmed: true, buildings: { quarry: 1 }, allowArrival: true, now }));
  assert.doesNotThrow(() => advanceForestVillagers(unsupported, legacy, .5, { now }));
  assert.deepEqual(forestVillagerFrames(unsupported), []);
});

test("northern introduction uses a connected, immutable path around buildings and water", () => {
  const scene = fixture(), places = forestVillagerPlaces(scene, "kamneshmyg");
  const plan = forestVillagerNorthernArrival(places), again = forestVillagerNorthernArrival(places);
  assert.equal(plan, again, "expensive flood is cached per immutable layout");
  assert.ok(plan.route.points.length > 2);
  for (let index = 1; index < plan.route.points.length; index++)
    assert.ok(canTraverse(places.navigation, plan.route.points[index - 1], plan.route.points[index]));
  assert.notDeepEqual(plan.start, scene.actor.spawn);
});

test("ready accounts restore miner at quarry without replaying an arrival; snapshots and frames remain detached", () => {
  const scene = fixture(), state = setup(scene), frames = forestVillagerFrames(state), saved = structuredClone(scene);
  assert.equal(state.arrivalCompleted, true); assert.equal(state.arrivalPhase, "complete");
  const miner = frames.find(frame => frame.id === "kamneshmyg");
  assert.equal(miner.arriving, false); miner.x = -999;
  const occupancy = forestVillagerOccupants(state); occupancy[0].position.x = -777;
  assert.notEqual(state.residents.kamneshmyg.position.x, -999); assert.notEqual(state.residents.lopukh.position.x, -777);
  for (let index = 0; index < 100; index++) forestVillagerFrames(state, index % 2 === 0);
  assert.equal(state.residents.kamneshmyg.elapsed, 0); assert.deepEqual(scene, saved);
});

test("confirmed worker jobs interrupt social plans, preserve server deadlines, and produce no rewards", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.lopukh;
  assert.equal(requestForestVillagerVisit(state, scene, "lopukh", { id: "friend", position: { x: 380, y: 300 }, size: 40 }), true);
  const production = { ownerPublicId: "owner", revision: 1, jobs: [{ id: "timber", stationId: "woodlot", stationLevel: 1,
    recipeId: "log", startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 600000).toISOString() }] };
  const saved = structuredClone(production);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { quarry: 1, woodlot: 1 }, production, now });
  assert.equal(mind.socialVisit, null); assert.equal(mind.job, true);
  assert.equal(requestForestVillagerVisit(state, scene, "lopukh", { id: "friend", position: { x: 380, y: 300 }, size: 40 }), false);
  run(state, scene, 15, { production });
  assert.equal(mind.action, "work"); assert.equal(mind.intent, "work");
  assert.deepEqual(production, saved); assert.equal("inventory" in state, false);
  advanceForestVillagers(state, scene, 0, { now: now + 601000, production });
  assert.equal(mind.job, false); assert.equal(mind.action, "inspect");
});

test("social visits move real feet, hold a greeting, cancel safely, and notices do not interrupt real work", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.leaftail;
  const before = { ...mind.position };
  assert.equal(requestForestVillagerVisit(state, scene, "leaftail", { id: "lopukh", position: { x: 390, y: 300 }, size: 44 }), true);
  assert.deepEqual(mind.position, before);
  run(state, scene, 8); assert.equal(mind.route, null); assert.equal(mind.action, "greet");
  const greeted = { ...mind.position }; run(state, scene, 4); assert.deepEqual(mind.position, greeted);
  cancelForestVillagerVisit(state, "leaftail"); assert.equal(mind.socialVisit, null); assert.deepEqual(mind.position, greeted);
  noticeForestVillager(state, "leaftail"); advanceForestVillagers(state, scene, .1, { now }); assert.equal(mind.action, "greet");
});

test("static resident feet stop an arrival rather than allowing a soft pass or teleport", () => {
  const scene = fixture(), state = setup(scene, { arrivalSeen: false, allowArrival: true }), mind = state.residents.kamneshmyg;
  const blocker = { id: "mochlik", size: 50, position: { x: mind.position.x, y: mind.position.y + 36 }, moving: false };
  run(state, scene, 2, { occupants: [blocker] });
  assert.ok(Math.hypot(mind.position.x - blocker.position.x, mind.position.y - blocker.position.y) >= (42 + 50) * .28);
  assert.equal(state.arrivalCompleted, false);
  run(state, scene, 30); assert.equal(state.arrivalCompleted, true);
});

test("invalid deltas never catch up offline; rain/rest utility and rabbit carry remain cosmetic", () => {
  const scene = fixture(), state = setup(scene), before = forestVillagerFrames(state);
  for (const dt of [-1, NaN, Infinity]) advanceForestVillagers(state, scene, dt, { now });
  assert.deepEqual(forestVillagerFrames(state), before);
  advanceForestVillagers(state, scene, 100000, { now });
  assert.equal(state.residents.lopukh.elapsed, FOREST_VILLAGER_LIMITS.maxDelta);
  const mind = state.residents.lopukh;
  mind.wait = 0; mind.workNeed = 1; mind.socialNeed = 0; mind.fatigue = 0;
  run(state, scene, 20); assert.ok(["carry", "inspect", "work", "walk"].includes(mind.action));
  mind.wait = 0; mind.fatigue = 1; run(state, scene, 12, { rain: true, dusk: true });
  assert.equal(mind.action, "rest");
});

test("changed artwork invalidates unsafe visible feet without moving them through a new collider", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.leaftail, before = { ...mind.position };
  const next = structuredClone(scene);
  next.navigation.obstacles.push({ id: "new-art", points: rect(before.x - 12, before.y - 12, 24, 24) });
  configureForestVillagers(state, next, { confirmed: true, buildings: { quarry: 1 }, arrivalSeen: true, now });
  assert.equal(mind.available, false); assert.deepEqual(mind.position, before); assert.equal(mind.route, null);
  assert.ok(!forestVillagerFrames(state).some(frame => frame.id === "leaftail"));
});

test("reduced motion settles only explicitly allowed unlocked introductions", () => {
  const scene = fixture(), state = setup(scene, { arrivalSeen: false });
  assert.equal(settleForestVillagerArrival(state), false); assert.equal(state.arrivalCompleted, false);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { quarry: 1 }, allowArrival: true, now });
  assert.equal(settleForestVillagerArrival(state), true); assert.equal(state.arrivalCompleted, true);
  assert.equal(state.residents.kamneshmyg.route, null);
  assert.ok(isWalkable(forestVillagerPlaces(scene, "kamneshmyg").navigation, state.residents.kamneshmyg.position));
});

test("closing or covering the map pauses only the physical entrance, including its final greeting", () => {
  const scene = fixture(), state = setup(scene, { arrivalSeen: false, allowArrival: true }), mind = state.residents.kamneshmyg;
  const start = { ...mind.position };
  run(state, scene, 4, { arrivalActive: false });
  assert.deepEqual(mind.position, start); assert.equal(mind.elapsed, 0);
  assert.equal(state.residents.lopukh.elapsed > 3.9, true);
  for (let tick = 0; tick < 500 && state.arrivalPhase !== "greeting"; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(state.arrivalPhase, "greeting");
  const age = mind.age;
  run(state, scene, 5, { arrivalActive: false });
  assert.equal(mind.age, age); assert.equal(state.arrivalCompleted, false);
  run(state, scene, 4, { arrivalActive: true }); assert.equal(state.arrivalCompleted, true);
});

test("two real social routes can finish a head-on crossing in a narrow authored corridor", () => {
  const scene = fixture();
  scene.water = undefined;
  scene.sites = scene.sites.filter(site => site.id !== "leaftail-caravan").map((site, index) => ({ ...site,
    entry: { x: 50, y: index ? 20 : 180 }, anchor: { x: 50, y: index ? 10 : 170 }, collision: [] }));
  scene.navigation = { version: 1, cellSize: 5, areas: [{ id: "top", points: rect(0, 0, 100, 50) },
    { id: "corridor", points: rect(43, 40, 14, 120) }, { id: "bottom", points: rect(0, 150, 100, 50) }], obstacles: [], interests: [] };
  const state = setup(scene), rabbit = state.residents.lopukh, miner = state.residents.kamneshmyg;
  assert.equal(requestForestVillagerVisit(state, scene, "lopukh", { id: "south", position: { x: 50, y: 180 }, size: 42 }), true);
  assert.equal(requestForestVillagerVisit(state, scene, "kamneshmyg", { id: "north", position: { x: 50, y: 20 }, size: 44 }), true);
  for (let tick = 0; tick < 1800; tick++) {
    const before = forestVillagerFrames(state);
    advanceForestVillagers(state, scene, 1 / 60, { now });
    for (const frame of forestVillagerFrames(state)) {
      const previous = before.find(value => value.id === frame.id);
      assert.ok(canTraverse(forestVillagerPlaces(scene, frame.id).navigation, previous, frame));
      assert.ok(Math.hypot(frame.x - previous.x, frame.y - previous.y) <= FOREST_VILLAGER_PROFILES[frame.id].speed / 60 + .001);
    }
  }
  assert.equal(rabbit.route, null); assert.equal(miner.route, null);
  assert.ok(rabbit.position.y > 150); assert.ok(miner.position.y < 50);
  assert.equal(rabbit.action, "greet"); assert.equal(miner.action, "greet");
});

test("read-only animation clocks include the second half of walking and long idle breathing", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.leaftail;
  mind.age = 6; assert.equal(forestVillagerFrames(state).find(frame => frame.id === "leaftail").frame, 30);
  mind.walked = 7 * 7;
  requestForestVillagerVisit(state, scene, "leaftail", { id: "friend", position: { x: 350, y: 300 }, size: 44 });
  assert.equal(forestVillagerFrames(state).find(frame => frame.id === "leaftail").frame, 7);
  assert.equal(forestVillagerFrames(state, true).find(frame => frame.id === "leaftail").frame, 0);
});

test("artwork handoff preserves a running entrance and ordinary walk without shared mutable progress", () => {
  const scene = fixture(), state = setup(scene, { arrivalSeen: false, allowArrival: true });
  run(state, scene, 1);
  const rabbit = state.residents.lopukh;
  rabbit.wait = 0; rabbit.workNeed = 0; rabbit.socialNeed = 1; rabbit.fatigue = 0;
  advanceForestVillagers(state, scene, .1, { now }); assert.ok(rabbit.route);
  const saved = structuredClone(state), nextScene = structuredClone(scene);
  nextScene.terrain.push({ id: "new-art", image: "/new.webp", bounds: { x: 0, y: 0, width: 10, height: 10 } });
  const next = rehydrateForestVillagers(nextScene, state, now);
  assert.equal(next.scene, nextScene); assert.equal(next.arrivalPhase, "running");
  for (const id of ["lopukh", "kamneshmyg"]) {
    assert.deepEqual(next.residents[id].position, state.residents[id].position, "safe feet retain their exact ground position");
    assert.equal(next.residents[id].elapsed, state.residents[id].elapsed);
    assert.notEqual(next.residents[id], state.residents[id]); assert.notEqual(next.residents[id].position, state.residents[id].position);
    assert.ok(next.residents[id].route); assert.deepEqual(next.residents[id].route.points[0], state.residents[id].position);
  }
  advanceForestVillagers(next, nextScene, .1, { now });
  assert.deepEqual(state, saved, "advancing the new owner never advances old clocks, positions or needs");
  run(next, nextScene, 25); assert.equal(next.arrivalCompleted, true);
});

test("reduced-motion introduction respects the hero and builder's existing exterior feet", () => {
  const scene = fixture(), state = setup(scene, { arrivalSeen: false, allowArrival: true });
  const places = forestVillagerPlaces(scene, "kamneshmyg");
  const occupants = places.work.map((stop, index) => ({ id: `occupied-${index}`, position: { ...stop.position }, size: 50 }));
  const before = { ...state.residents.kamneshmyg.position };
  assert.equal(settleForestVillagerArrival(state, occupants), false);
  assert.deepEqual(state.residents.kamneshmyg.position, before); assert.equal(state.arrivalCompleted, false);
  assert.equal(settleForestVillagerArrival(state, [occupants[0]]), true);
  assert.ok(canTraverseResidents(state.residents.kamneshmyg.position, state.residents.kamneshmyg.position, 42, [occupants[0]], "kamneshmyg"));
});

test("artwork handoff retains confirmed jobs against the supplied corrected server clock", () => {
  const scene = fixture(), state = setup(scene);
  const production = { ownerPublicId: "owner", revision: 5, jobs: [{ id: "server-clock-job", stationId: "woodlot", stationLevel: 1,
    recipeId: "logs", startedAt: new Date(0).toISOString(), finishesAt: new Date(60000).toISOString() }] };
  configureForestVillagers(state, scene, { confirmed: true, buildings: { quarry: 1, woodlot: 1 }, production, now: 1000 });
  assert.equal(state.residents.lopukh.job, true);
  const next = rehydrateForestVillagers(structuredClone(scene), state, 2000);
  assert.equal(next.residents.lopukh.job, true); assert.equal(next.residents.lopukh.jobKey, state.residents.lopukh.jobKey);
  assert.notEqual(next.production, state.production); assert.notEqual(next.production.jobs, state.production.jobs);
});

test("published Tiled geometry supports all residents and an actual northern miner arrival", () => {
  const levels = { ...initialPreviewLevels(TILED_WORLD), quarry: 1 };
  const scene = previewWorldScene(TILED_WORLD, levels), state = setup(scene, { buildings: levels, arrivalSeen: false, allowArrival: true });
  assert.deepEqual(forestVillagerFrames(state).map(frame => frame.id), ["lopukh", "kamneshmyg", "leaftail"]);
  assert.ok(state.residents.kamneshmyg.position.y < 50);
  run(state, scene, 40); assert.equal(state.arrivalCompleted, true);
});
