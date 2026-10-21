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
const { beginWoodcutterCycle, WOODCUTTER_CYCLE_LIMITS } = await vite.ssrLoadModule("/features/world/characters/villagers/woodcutter-cycle.ts");
const { selectVillagerRoute } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-movement.ts");
const { forestVillagerPlaces, forestVillagerNorthernArrival, FOREST_VILLAGER_PROFILES } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-navigation.ts");
const { prepareSteeringPath } = await vite.ssrLoadModule("/features/world/navigation/steering.ts");
const { villagerShelterWeather } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-state.ts");
const { isWalkable, canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { canTraverseResidents, residentPassageClear } = await vite.ssrLoadModule("/features/world/navigation/resident-traffic.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const now = Date.parse("2026-10-16T12:00:00Z");
const distanceBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
function fixture() {
  const sites = [["quarry", 290, 250], ["lopukh-home", 470, 200], ["leaftail-caravan", 440, 340]].map(([id, x, y]) => ({
    id, label: id, initialLevel: 1, bounds: { x: x - 30, y: y - 45, width: 60, height: 45 },
    ...(id === "quarry" ? { doorway: { x, y: y - 20 } } : {}),
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
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1, woodlot: 1 }, leaftailReady: true, arrivalSeen: true, lopukhArrivalSeen: true, now, ...config });
  return state;
}
function run(state, scene, seconds, environment = {}) {
  for (let elapsed = 0; elapsed < seconds - 1e-7; elapsed += .1) {
    const before = forestVillagerFrames(state), occupants = forestVillagerOccupants(state);
    const crossings = new Map(Object.values(state.residents).filter(mind => ["enter", "exit"].includes(mind.doorPhase))
      .map(mind => [mind.id, mind.door.navigation]));
    advanceForestVillagers(state, scene, .1, { now, ...environment });
    for (const frame of forestVillagerFrames(state)) {
      const previous = before.find(value => value.id === frame.id);
      const profile = FOREST_VILLAGER_PROFILES[frame.id], places = forestVillagerPlaces(scene, frame.id);
      const mind = state.residents[frame.id], navigation = ["enter", "exit"].includes(mind.doorPhase)
        ? mind.door.navigation : crossings.get(frame.id) ?? places.navigation;
      assert.ok(isWalkable(navigation, frame), `${frame.id} stays on actual safe ground or its validated personal threshold`);
      if (!previous) continue;
      assert.ok(canTraverse(navigation, previous, frame), `${frame.id} does not cut an obstacle`);
      assert.ok(Math.hypot(frame.x - previous.x, frame.y - previous.y) <= profile.speed * .1 * FOREST_VILLAGER_LIMITS.arrivalSpeed + .001,
        `${frame.id} has no teleported movement`);
      assert.ok(canTraverseResidents(previous, frame, profile.size,
        occupants.filter(other => other.id !== frame.id), frame.id) || previous.x === frame.x && previous.y === frame.y,
      `${frame.id} respects occupied feet`);
    }
  }
}

function wakeTrader(state, scene) {
  noticeForestVillager(state, "leaftail");
  for (let attempt = 0; attempt < 50 && state.residents.leaftail.doorPhase !== "outside"; attempt++)
    advanceForestVillagers(state, scene, .1, { now });
  assert.equal(state.residents.leaftail.doorPhase, "outside");
}

test("miner remains hidden until confirmed quarry unlock and explicit free-world arrival permission", () => {
  const scene = fixture(), state = createForestVillagers(scene);
  configureForestVillagers(state, scene, { confirmed: false, buildings: { home: 3, quarry: 9 }, allowArrival: true, now });
  assert.deepEqual(forestVillagerFrames(state), []); assert.equal(state.arrivalPending, false);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 0 }, allowArrival: true, now });
  assert.deepEqual(forestVillagerFrames(state).map(frame => frame.id), ["leaftail"], "the unopened rabbit home keeps its resident hidden");
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1 }, now });
  assert.equal(state.arrivalPending, true); assert.equal(state.arrivalPhase, "waiting");
  run(state, scene, 3); assert.equal(state.residents.kamneshmyg.available, false);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1 }, allowArrival: true, now });
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
  assert.doesNotThrow(() => configureForestVillagers(state, scene, { confirmed: false, buildings: { home: 3, quarry: 1 }, now }));
  assert.doesNotThrow(() => advanceForestVillagers(state, scene, .5, { now }));
  assert.deepEqual(forestVillagerFrames(state), []);
  assert.throws(() => configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1 }, now }), /navigation is not ready/);

  const legacy = new Proxy({ ...fixture(), sites: [] }, { get(target, key, receiver) {
    if (key === "navigation") throw new Error("legacy navigation must remain unused");
    return Reflect.get(target, key, receiver);
  } });
  const unsupported = createForestVillagers(legacy);
  assert.doesNotThrow(() => configureForestVillagers(unsupported, legacy, { confirmed: true, buildings: { home: 3, quarry: 1 }, allowArrival: true, now }));
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
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1, woodlot: 1 }, production, now });
  assert.equal(mind.socialVisit, null); assert.equal(mind.job, true);
  assert.equal(requestForestVillagerVisit(state, scene, "lopukh", { id: "friend", position: { x: 380, y: 300 }, size: 40 }), false);
  run(state, scene, 15, { production });
  assert.equal(mind.action, "rest"); assert.equal(mind.woodwork.phase, "rest");
  assert.equal(mind.job, true, "visual delivery and rest do not end the server job");
  assert.deepEqual(production, saved); assert.equal("inventory" in state, false);
  const restingFeet = { ...mind.position };
  advanceForestVillagers(state, scene, 0, { now: now + 601000, production });
  assert.equal(mind.job, false); assert.equal(mind.action, "rest"); assert.deepEqual(mind.position, restingFeet);
});

test("social visits move real feet, hold a greeting, cancel safely, and notices do not interrupt real work", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.leaftail;
  wakeTrader(state, scene);
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
  const phases = new Set();
  for (let step = 0; step < 200; step++) { run(state, scene, .1); phases.add(mind.action); }
  for (const action of ["work", "carry", "unload", "rest"]) assert.ok(phases.has(action), `the visual cycle includes ${action}`);
  mind.wait = 0; mind.fatigue = 1; run(state, scene, 12, { rain: true, dusk: true });
  assert.equal(mind.action, "rest");
});

test("changed artwork invalidates unsafe visible feet without moving them through a new collider", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.leaftail, before = { ...mind.position };
  const next = structuredClone(scene);
  next.navigation.obstacles.push({ id: "new-art", points: rect(before.x - 12, before.y - 12, 24, 24) });
  configureForestVillagers(state, next, { confirmed: true, buildings: { home: 3, quarry: 1 }, arrivalSeen: true, now });
  assert.equal(mind.available, false); assert.deepEqual(mind.position, before); assert.equal(mind.route, null);
  assert.ok(!forestVillagerFrames(state).some(frame => frame.id === "leaftail"));
});

test("reduced motion settles only explicitly allowed unlocked introductions", () => {
  const scene = fixture(), state = setup(scene, { arrivalSeen: false });
  assert.equal(settleForestVillagerArrival(state), false); assert.equal(state.arrivalCompleted, false);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1 }, allowArrival: true, now });
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
  wakeTrader(state, scene);
  mind.age = 6; assert.equal(forestVillagerFrames(state).find(frame => frame.id === "leaftail").frame, 30);
  mind.walked = 7 * FOREST_VILLAGER_PROFILES.leaftail.size / 48;
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
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1, woodlot: 1 }, production, now: 1000 });
  assert.equal(state.residents.lopukh.job, true);
  const next = rehydrateForestVillagers(structuredClone(scene), state, 2000);
  assert.equal(next.residents.lopukh.job, true); assert.equal(next.residents.lopukh.jobKey, state.residents.lopukh.jobKey);
  assert.notEqual(next.production, state.production); assert.notEqual(next.production.jobs, state.production.jobs);
});

test("published Tiled geometry supports the northern miner arrival at every built mine level and hides him at zero", () => {
  for (let level = 0; level <= 5; level++) {
    const levels = { ...initialPreviewLevels(TILED_WORLD), home: 3, quarry: level, woodlot: 1, "leaftail-caravan": 1 };
    const scene = previewWorldScene(TILED_WORLD, levels), state = setup(scene, { buildings: levels, arrivalSeen: false, allowArrival: true });
    assert.deepEqual(forestVillagerFrames(state).map(frame => frame.id), level
      ? ["lopukh", "kamneshmyg", "leaftail"] : ["lopukh", "leaftail"]);
    if (!level) { assert.equal(state.arrivalPending, false); continue; }
    assert.ok(state.residents.kamneshmyg.position.y < 50, `mine ${level} arrival starts at the reachable northern edge`);
    run(state, scene, 40); assert.equal(state.arrivalCompleted, true, `mine ${level} arrival completes without crossing a collider`);
  }
});


test("walking consumes one distance budget across dense steering samples and uses a planted-foot clock", () => {
  const states = [setup(), setup()];
  for (const [index, state] of states.entries()) {
    for (const id of ["lopukh", "leaftail"]) state.residents[id].available = false;
    const mind = state.residents.kamneshmyg, places = forestVillagerPlaces(state.scene, "kamneshmyg");
    mind.position = { x: 100, y: 370 }; mind.direction = "right"; mind.afterWalk = "inspect";
    mind.route = prepareSteeringPath(places.navigation, index ? Array.from({ length: 201 }, (_, n) => ({ x: 100 + n * 2, y: 370 }))
      : [{ x: 100, y: 370 }, { x: 500, y: 370 }], 42);
    assert.ok(mind.route); mind.action = "walk"; mind.distance = 0; mind.speed = 0;
  }
  for (let frame = 0; frame < 240; frame++) {
    for (const state of states) advanceForestVillagers(state, state.scene, 1 / 60, { now });
    const [sparse, dense] = states.map(state => state.residents.kamneshmyg);
    assert.ok(Math.abs(sparse.position.x - dense.position.x) < 1e-6, "geometry sampling cannot change travelled distance");
    assert.ok(Math.abs(sparse.speed - dense.speed) < 1e-6);
    assert.equal(dense.direction, "right");
    assert.equal(forestVillagerFrames(states[1]).find(frame => frame.id === "kamneshmyg").frame,
      Math.floor(dense.walked / (42 / 48)) % 32);
  }
  assert.ok(states[0].residents.kamneshmyg.walked > 120);
});

test("idle miner walks and rests outside; only a confirmed live job enters the cave and finishing exits", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.kamneshmyg;
  for (let tick = 0; tick < 1200; tick++) {
    advanceForestVillagers(state, scene, .1, { now });
    assert.notEqual(mind.action, "work"); assert.equal(mind.doorPhase, "outside");
  }
  assert.ok(mind.walked > 30, "the miner has a life outside extraction");
  const production = { ownerPublicId: "owner", revision: 1, jobs: [{ id: "stone", stationId: "quarry", stationLevel: 1,
    startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 60000).toISOString(), recipeId: "stone" }] };
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1 }, production, now });
  for (let tick = 0; tick < 800 && mind.doorPhase !== "inside"; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(mind.doorPhase, "inside"); assert.equal(mind.action, "work");
  assert.equal(forestVillagerFrames(state).some(frame => frame.id === "kamneshmyg"), false);
  assert.equal(forestVillagerOccupants(state).some(frame => frame.id === "kamneshmyg"), false);
  const hidden = { ...mind.position };
  advanceForestVillagers(state, scene, 0, { now: now + 60001 });
  assert.equal(mind.job, false); assert.deepEqual(mind.position, hidden, "job expiry itself never teleports a worker");
  for (let tick = 0; tick < 100 && mind.doorPhase !== "outside"; tick++)
    advanceForestVillagers(state, scene, .1, { now: now + 60001 });
  assert.equal(mind.doorPhase, "outside");
  assert.ok(isWalkable(forestVillagerPlaces(scene, "kamneshmyg").navigation, mind.position));
  assert.notEqual(mind.action, "work");
});

test("merchant lives behind the wagon, periodically returns outside, and a notice wakes him without teleporting", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.leaftail;
  for (let tick = 0; tick < 30 && mind.doorPhase !== "inside"; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(mind.doorPhase, "inside");
  assert.equal(forestVillagerFrames(state).some(frame => frame.id === "leaftail"), false);
  assert.equal(forestVillagerOccupants(state).some(frame => frame.id === "leaftail"), false);
  assert.equal(requestForestVillagerVisit(state, scene, "leaftail", { id: "friend", position: { x: 390, y: 300 }, size: 44 }), false);
  const before = { ...mind.position }, clock = mind.elapsed;
  for (const dt of [0, NaN, -1, Infinity]) advanceForestVillagers(state, scene, dt, { now });
  assert.deepEqual(mind.position, before); assert.equal(mind.elapsed, clock);
  noticeForestVillager(state, "leaftail"); assert.deepEqual(mind.position, before);
  advanceForestVillagers(state, scene, .1, { now, dusk: true });
  assert.equal(mind.doorPhase, "exit");
  const fading = forestVillagerFrames(state).find(frame => frame.id === "leaftail");
  assert.ok(fading.opacity > 0 && fading.opacity < 1);
  assert.ok(Math.hypot(mind.position.x - before.x, mind.position.y - before.y) < 4);
  for (let tick = 0; tick < 30 && mind.doorPhase !== "outside"; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(mind.doorPhase, "outside");
  let cameHome = false, cameOut = false;
  for (let tick = 0; tick < 1600; tick++) {
    advanceForestVillagers(state, scene, .1, { now });
    if (mind.doorPhase === "inside") cameHome = true;
    if (cameHome && mind.doorPhase === "outside") { cameOut = true; break; }
  }
  assert.ok(cameHome && cameOut, "home and outings are complete repeated states");
});

test("a blocked doorway prevents revealing a resident and a cancelled extraction reverses the same crossing", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.leaftail;
  for (let tick = 0; tick < 20; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(mind.doorPhase, "inside");
  const before = { ...mind.position }, blocker = { id: "mochlik", position: { ...mind.door.approach.position }, size: 50 };
  noticeForestVillager(state, "leaftail");
  for (let tick = 0; tick < 20; tick++) advanceForestVillagers(state, scene, .1, { now, occupants: [blocker] });
  assert.deepEqual(mind.position, before); assert.equal(mind.doorProgress, 1);
  assert.equal(forestVillagerFrames(state).some(frame => frame.id === "leaftail"), false);
  assert.equal(forestVillagerOccupants(state).some(frame => frame.id === "leaftail"), false);
  for (let tick = 0; tick < 20; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(mind.doorPhase, "outside");

  const miner = state.residents.kamneshmyg;
  const production = { ownerPublicId: "owner", revision: 1, jobs: [{ id: "stone", stationId: "quarry", stationLevel: 1,
    startedAt: new Date(now - 1).toISOString(), finishesAt: new Date(now + 1000).toISOString() }] };
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1 }, production, now });
  for (let tick = 0; tick < 800 && miner.doorPhase !== "enter"; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(miner.doorPhase, "enter"); const entering = { ...miner.position };
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1 }, production: { ...production, revision: 2, jobs: [] }, now });
  assert.deepEqual(miner.position, entering);
  advanceForestVillagers(state, scene, .1, { now });
  assert.ok(["exit", "outside"].includes(miner.doorPhase)); assert.notEqual(miner.action, "work");
});

test("shelter requires meaningful rain or darkness; wildlife holds leave real jobs and home entry in control", () => {
  assert.equal(villagerShelterWeather({ rain: .01, dusk: .01 }), false);
  assert.equal(villagerShelterWeather({ rain: .23, dusk: .59 }), false);
  assert.equal(villagerShelterWeather({ rain: .24, dusk: 0 }), true);
  assert.equal(villagerShelterWeather({ rain: false, dusk: .6 }), true);
  const scene = fixture(), state = setup(scene); wakeTrader(state, scene); run(state, scene, 3);
  const mind = state.residents.leaftail, before = { ...mind.position }, bearing = mind.direction;
  advanceForestVillagers(state, scene, .1, { now, wildlifeHolds: ["leaftail"], rain: .01, dusk: .01 });
  assert.deepEqual(mind.position, before); assert.equal(mind.direction, bearing); assert.equal(mind.action, "inspect");
  assert.equal(mind.doorPhase, "outside");
  mind.outdoorUntil = mind.elapsed + 20;
  advanceForestVillagers(state, scene, .1, { now, rain: .01, dusk: .01 }); assert.equal(mind.doorPhase, "outside");
  advanceForestVillagers(state, scene, .1, { now, rain: .4 }); assert.notEqual(mind.doorPhase, "outside");
});

test("private mine strips keep other obstacles and water blocked; wagon concealment keeps the normal collider", () => {
  for (let level = 1; level <= 5; level++) {
    const scene = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), quarry: level });
    const places = forestVillagerPlaces(scene, "kamneshmyg"), doorway = places.door;
    assert.ok(doorway, `mine ${level} has a validated personal doorway`);
    assert.equal(doorway.kind, "threshold"); assert.ok(doorway.length <= 90);
    assert.equal(isWalkable(places.navigation, doorway.points.at(-1)), false);
    for (let index = 1; index < doorway.points.length; index++) assert.ok(canTraverse(doorway.navigation, doorway.points[index - 1], doorway.points[index]));
    const barrier = structuredClone(scene), entry = barrier.sites.find(site => site.id === "quarry").entry;
    barrier.navigation.obstacles.push({ id: "private-door-blocker", points: rect(entry.x - 8, entry.y - 8, 16, 16) });
    assert.equal(forestVillagerPlaces(barrier, "kamneshmyg").door, null);
    const flooded = structuredClone(scene);
    flooded.water.surfaces.push({ id: "private-door-water", points: rect(entry.x - 8, entry.y - 8, 16, 16) });
    assert.equal(forestVillagerPlaces(flooded, "kamneshmyg").door, null);
  }
  const scene = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), "leaftail-caravan": 1 });
  const wagon = forestVillagerPlaces(scene, "leaftail");
  assert.ok(wagon.door); assert.equal(wagon.door.kind, "concealment"); assert.equal(wagon.door.navigation, wagon.navigation);
  assert.ok(canTraverse(wagon.navigation, wagon.door.points[0], wagon.door.points[1]));
});

test("every built mine admits a confirmed worker and returns him safely outside when extraction ends", () => {
  for (let level = 1; level <= 5; level++) {
    const levels = { ...initialPreviewLevels(TILED_WORLD), home: 3, quarry: level, woodlot: 1 };
    const scene = previewWorldScene(TILED_WORLD, levels);
    const production = { ownerPublicId: "owner", revision: 1, jobs: [{ id: `stone-${level}`, stationId: "quarry", stationLevel: level,
      recipeId: "stone", startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 60000).toISOString() }] };
    const state = setup(scene, { buildings: levels, production }), miner = state.residents.kamneshmyg;
    for (const id of ["lopukh", "leaftail"]) state.residents[id].available = false;
    run(state, scene, 10);
    assert.equal(miner.doorPhase, "inside", `mine ${level} confirms actual entry before work`);
    assert.equal(miner.action, "work");
    assert.equal(forestVillagerFrames(state).some(frame => frame.id === "kamneshmyg"), false);
    configureForestVillagers(state, scene, { confirmed: true, buildings: levels, production: { ...production, revision: 2, jobs: [] },
      leaftailReady: true, arrivalSeen: true, lopukhArrivalSeen: true, now });
    for (const id of ["lopukh", "leaftail"]) state.residents[id].available = false;
    run(state, scene, 5);
    assert.equal(miner.doorPhase, "outside", `mine ${level} returns along the same valid crossing`);
    assert.equal(miner.job, false);
    assert.ok(forestVillagerFrames(state).some(frame => frame.id === "kamneshmyg"));
  }
});


test("a missing mine threshold waits outside for confirmed extraction and door handoff preserves hidden feet", () => {
  const legacy = fixture(); delete legacy.sites.find(site => site.id === "quarry").doorway;
  const nowJob = { ownerPublicId: "owner", revision: 1, jobs: [{ id: "stone", stationId: "quarry", stationLevel: 1,
    startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 600000).toISOString() }] };
  const waiting = setup(legacy, { production: nowJob }), miner = waiting.residents.kamneshmyg;
  run(waiting, legacy, 12); assert.equal(miner.job, true); assert.equal(miner.doorPhase, "outside");
  assert.notEqual(miner.action, "work");

  const scene = fixture(), state = setup(scene, { production: nowJob });
  for (let tick = 0; tick < 40; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(state.residents.kamneshmyg.doorPhase, "inside");
  const before = structuredClone(state), nextScene = structuredClone(scene);
  nextScene.terrain.push({ id: "art-only", image: "/new.webp", bounds: { x: 0, y: 0, width: 1, height: 1 } });
  const next = rehydrateForestVillagers(nextScene, state, now);
  for (const id of ["kamneshmyg", "leaftail"]) {
    assert.equal(next.residents[id].doorPhase, "inside");
    assert.deepEqual(next.residents[id].position, state.residents[id].position);
    assert.equal(next.residents[id].elapsed, state.residents[id].elapsed);
    assert.notEqual(next.residents[id], state.residents[id]);
  }
  advanceForestVillagers(next, nextScene, .1, { now });
  assert.deepEqual(state, before); assert.equal(next.residents.kamneshmyg.job, true);
});


test("replacement mining work reverses an exit in place instead of walking out and immediately back", () => {
  const scene = fixture(), job = { id: "stone", stationId: "quarry", stationLevel: 1,
    startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 600000).toISOString() };
  const production = { ownerPublicId: "owner", revision: 1, jobs: [job] }, state = setup(scene, { production });
  const miner = state.residents.kamneshmyg;
  for (let tick = 0; tick < 40; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(miner.doorPhase, "inside");
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1 }, production: { ...production, revision: 2, jobs: [] }, now });
  advanceForestVillagers(state, scene, .2, { now });
  assert.equal(miner.doorPhase, "exit"); const position = { ...miner.position }, progress = miner.doorProgress;
  const opacity = forestVillagerFrames(state).find(frame => frame.id === "kamneshmyg").opacity;
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1 }, production: { ...production, revision: 3,
    jobs: [{ ...job, id: "replacement" }] }, now });
  advanceForestVillagers(state, scene, 0, { now });
  assert.deepEqual(miner.position, position); assert.equal(miner.doorProgress, progress);
  assert.equal(forestVillagerFrames(state).find(frame => frame.id === "kamneshmyg").opacity, opacity);
  advanceForestVillagers(state, scene, .1, { now });
  assert.equal(miner.doorPhase, "enter"); assert.ok(miner.doorProgress > progress);
  for (let tick = 0; tick < 20; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(miner.doorPhase, "inside"); assert.equal(miner.action, "work");
});


for (const hold of ["wildlife", "social-host", "social-guest"]) test(`${hold} yields a worker corridor before its optional pose can block it`, () => {
  const scene = fixture();
  scene.navigation.areas = [{ id: "narrow-trail", points: rect(275, 335, 210, 30) },
    { id: "passing-alcove", points: rect(330, 260, 40, 90) }];
  const state = setup(scene), mind = state.residents.leaftail;
  for (const id of ["lopukh", "kamneshmyg"]) state.residents[id].available = false;
  mind.doorPhase = "outside"; mind.door = null; mind.doorProgress = 0; mind.route = null;
  mind.position = { x: 350, y: 350 }; mind.action = "greet"; mind.noticePending = false;
  mind.wait = 100; mind.outdoorUntil = 1000;
  if (hold === "social-guest") mind.socialVisit = { targetId: "friend", anchor: { x: 380, y: 350 } };
  const worker = { id: "worker", position: { x: 305, y: 350 }, size: 50, moving: true,
    intent: { points: [{ x: 305, y: 350 }, { x: 450, y: 350 }], target: { x: 450, y: 350 }, priority: 2 } };
  const environment = { now, occupants: [worker], ...(hold === "wildlife" ? { wildlifeHolds: ["leaftail"] }
    : hold === "social-host" ? { socialHolds: ["leaftail"] } : {}) };
  const places = forestVillagerPlaces(scene, "leaftail"), before = { ...mind.position };
  assert.ok(places); assert.equal(mind.available, true); assert.ok(isWalkable(places.navigation, mind.position));
  advanceForestVillagers(state, scene, .1, environment);
  assert.deepEqual(mind.position, before, "selection publishes a route without moving feet");
  assert.equal(mind.intent, "yield"); assert.equal(mind.action, "walk"); assert.ok(mind.route);
  assert.equal(mind.socialVisit, null, "a guest reservation is released with the yield");
  assert.ok(residentPassageClear(mind.target.position, 44, worker));
  for (let tick = 0; tick < 35; tick++) {
    const from = { ...mind.position };
    // Deliberately keep the stale optional hold: it must not cancel a safety
    // route while the next director reconciliation is still pending.
    advanceForestVillagers(state, scene, .1, environment);
    assert.ok(canTraverse(places.navigation, from, mind.position));
    assert.ok(canTraverseResidents(from, mind.position, 44, [worker], "leaftail"));
    assert.ok(Math.hypot(mind.position.x - from.x, mind.position.y - from.y) <= 3.2 + .001);
  }
  assert.equal(mind.route, null); assert.ok(residentPassageClear(mind.position, 44, worker));
});


for (const hold of ["wildlife", "social-host", "social-guest"]) test(`${hold} remains in place for an ordinary priority-one walker`, () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.leaftail;
  for (const id of ["lopukh", "kamneshmyg"]) state.residents[id].available = false;
  mind.doorPhase = "outside"; mind.door = null; mind.doorProgress = 0; mind.route = null;
  mind.position = { x: 350, y: 350 }; mind.action = "greet"; mind.noticePending = false;
  mind.wait = 100; mind.outdoorUntil = 1000;
  if (hold === "social-guest") mind.socialVisit = { targetId: "friend", anchor: { x: 380, y: 350 } };
  const walker = { id: "a-walker", position: { x: 305, y: 350 }, size: 50, moving: true,
    intent: { points: [{ x: 305, y: 350 }, { x: 450, y: 350 }], target: { x: 450, y: 350 }, priority: 1 } };
  const environment = { now, occupants: [walker], ...(hold === "wildlife" ? { wildlifeHolds: ["leaftail"] }
    : hold === "social-host" ? { socialHolds: ["leaftail"] } : {}) };
  const before = { ...mind.position }, visit = mind.socialVisit;
  for (let tick = 0; tick < 20; tick++) advanceForestVillagers(state, scene, .1, environment);
  assert.deepEqual(mind.position, before); assert.equal(mind.route, null);
  assert.equal(mind.socialVisit, visit); assert.notEqual(mind.intent, "yield");
  assert.equal(mind.action, hold === "wildlife" ? "inspect" : "greet");
});

for (const role of ["host", "guest"]) test(`social ${role} waits for its own priority-two partner without clearing the agreed meeting`, () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.leaftail;
  for (const id of ["lopukh", "kamneshmyg"]) state.residents[id].available = false;
  mind.doorPhase = "outside"; mind.door = null; mind.doorProgress = 0; mind.route = null;
  mind.position = { x: 350, y: 350 }; mind.action = "greet"; mind.noticePending = false;
  mind.wait = 100; mind.outdoorUntil = 1000;
  if (role === "guest") mind.socialVisit = { targetId: "friend", anchor: { x: 380, y: 350 } };
  const friend = { id: "friend", position: { x: 305, y: 350 }, size: 50, moving: true,
    intent: { points: [{ x: 305, y: 350 }, { x: 450, y: 350 }], target: { x: 450, y: 350 }, priority: 2 } };
  const environment = { now, occupants: [friend], ...(role === "host"
    ? { socialHolds: ["leaftail"], socialPartners: { leaftail: "friend" } } : {}) };
  const before = { ...mind.position }, visit = mind.socialVisit;
  for (let tick = 0; tick < 20; tick++) advanceForestVillagers(state, scene, .1, environment);
  assert.deepEqual(mind.position, before); assert.equal(mind.route, null);
  assert.equal(mind.socialVisit, visit); assert.equal(mind.action, "greet"); assert.notEqual(mind.intent, "yield");
});


for (const houseLevel of [1, 2]) test(`the actual Tiled rabbit at house ${houseLevel} cuts a tree, delivers in front of the facade, unloads promptly and rests without changing geometry`, () => {
  const levels = { ...initialPreviewLevels(TILED_WORLD), quarry: 1, woodlot: 1, "lopukh-home": houseLevel };
  const scene = previewWorldScene(TILED_WORLD, levels), saved = structuredClone(scene), state = setup(scene, { buildings: levels });
  const mind = state.residents.lopukh, places = forestVillagerPlaces(scene, "lopukh"), plan = places.woodcutting;
  const house = scene.sites.find(site => site.id === "lopukh-home"), front = house.bounds.y + house.bounds.height + 44 * 45 / 48 + 2;
  assert.ok(plan); assert.ok(plan.work[0].id.startsWith("lopukh-work-tree-"), "the authored work zone selects the tree-side work positions");
  for (const stop of [...plan.work, ...plan.delivery, ...plan.rest]) {
    assert.ok(isWalkable(places.navigation, stop.position)); assert.ok(stop.position.y >= front);
  }
  for (const id of ["kamneshmyg", "leaftail"]) state.residents[id].available = false;
  assert.equal(beginWoodcutterCycle(mind, places), true);
  const actions = [], beforeCycles = mind.woodwork.completedCycles;
  let unloadAt = null, restAt = null;
  for (let elapsed = 0; elapsed < 60 && mind.woodwork.completedCycles === beforeCycles; elapsed += .05) {
    const previous = { ...mind.position };
    advanceForestVillagers(state, scene, .05, { now });
    assert.ok(canTraverse(places.navigation, previous, mind.position), "every real footstep keeps all authored blockers");
    assert.ok(Math.hypot(mind.position.x - previous.x, mind.position.y - previous.y) <= 39 * .05 + 1e-6);
    if (actions.at(-1) !== mind.action) actions.push(mind.action);
    if (mind.action === "carry" || mind.action === "unload") assert.ok(mind.position.y >= front);
    if (mind.action === "unload") {
      unloadAt ??= elapsed;
      assert.equal(mind.route, null); assert.ok(plan.delivery.some(stop => distanceBetween(stop.position, mind.position) < .1));
      const frame = forestVillagerFrames(state).find(frame => frame.id === "lopukh");
      assert.ok(frame.phase >= 0 && frame.phase <= 1); assert.equal(frame.frame, 0);
    }
    if (mind.action === "rest") restAt ??= elapsed;
  }
  assert.equal(mind.woodwork.completedCycles, beforeCycles + 1);
  assert.deepEqual(actions.filter(action => action !== "walk"), ["work", "carry", "unload", "rest", "inspect"]);
  assert.ok(restAt - unloadAt <= WOODCUTTER_CYCLE_LIMITS.unload + .1, "a delivered log is not held for the old nine-second idle timer");
  assert.equal(mind.doorPhase, "outside"); assert.deepEqual(scene, saved);
});

test("old roof-side rabbit feet walk out safely to the repaired cycle instead of being teleported", () => {
  const scene = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), quarry: 1 });
  const state = setup(scene), mind = state.residents.lopukh, places = forestVillagerPlaces(scene, "lopukh");
  for (const id of ["kamneshmyg", "leaftail"]) state.residents[id].available = false;
  const old = { x: 944.3975917210292, y: 191.65888721903897 };
  assert.ok(isWalkable(places.navigation, old)); mind.position = { ...old };
  assert.equal(beginWoodcutterCycle(mind, places, [], { chopSeconds: 0 }), true); assert.deepEqual(mind.position, old);
  for (let tick = 0; tick < 1800 && !mind.woodwork.completedCycles; tick++) {
    const from = { ...mind.position }; advanceForestVillagers(state, scene, .05, { now });
    assert.ok(canTraverse(places.navigation, from, mind.position));
    assert.ok(distanceBetween(from, mind.position) <= 39 * .05 + 1e-6);
  }
  assert.equal(mind.woodwork.completedCycles, 1); assert.notDeepEqual(mind.position, old);
  assert.equal(mind.action, "inspect"); assert.equal(mind.doorPhase, "outside");
});

test("a blocked delivery uses bounded retries and a safe outdoor set-down, keeping the visible log while waiting", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.lopukh, places = forestVillagerPlaces(scene, "lopukh");
  for (const id of ["kamneshmyg", "leaftail"]) state.residents[id].available = false;
  assert.equal(beginWoodcutterCycle(mind, places, [], { chopSeconds: 0 }), true);
  for (let tick = 0; tick < 200 && mind.action !== "work"; tick++) advanceForestVillagers(state, scene, .05, { now });
  assert.equal(mind.action, "work");
  const blockers = places.woodcutting.delivery.map((stop, index) => ({ id: `yard-worker-${index}`, position: { ...stop.position }, size: 40 }));
  const atWork = { ...mind.position }, decisions = mind.decisions;
  let sawUnload = false, sawRest = false;
  for (let tick = 0; tick < 500 && !mind.woodwork.completedCycles; tick++) {
    const before = { ...mind.position }; advanceForestVillagers(state, scene, .05, { now, occupants: blockers });
    assert.ok(canTraverse(places.navigation, before, mind.position));
    if (mind.woodwork.phase === "haul") {
      assert.equal(mind.action, "carry");
      assert.equal(forestVillagerFrames(state).find(frame => frame.id === "lopukh").action, "carry");
    }
    if (mind.action === "unload") { sawUnload = true; assert.deepEqual(mind.position, atWork); }
    if (mind.action === "rest") sawRest = true;
  }
  assert.ok(sawUnload && sawRest); assert.equal(mind.woodwork.completedCycles, 1);
  assert.ok(mind.decisions - decisions <= WOODCUTTER_CYCLE_LIMITS.attempts, "an occupied yard cannot request a path each frame");
});

test("a passing social hold pauses a cosmetic route and resumes the same path, while carried wood refuses an optional visit", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.lopukh, places = forestVillagerPlaces(scene, "lopukh");
  assert.equal(selectVillagerRoute(mind, places, [{ id: "passing", position: { x: 350, y: 350 }, lookAt: { x: 350, y: 360 } }], "wander", "inspect"), true);
  advanceForestVillagers(state, scene, .1, { now });
  const feet = { ...mind.position }, route = mind.route, progress = mind.distance;
  for (let tick = 0; tick < 30; tick++) advanceForestVillagers(state, scene, .1, { now, socialHolds: ["lopukh"] });
  assert.deepEqual(mind.position, feet); assert.equal(mind.route, route); assert.equal(mind.distance, progress); assert.equal(mind.action, "greet");
  advanceForestVillagers(state, scene, .1, { now });
  assert.equal(mind.route, route); assert.ok(mind.distance > progress); assert.equal(mind.action, "walk");
  mind.route = null; mind.woodwork.phase = "haul"; mind.action = "carry";
  assert.equal(requestForestVillagerVisit(state, scene, "lopukh", { id: "friend", position: { x: 380, y: 300 }, size: 44 }), false);
  assert.equal(mind.action, "carry");
});

test("a caravan window holds the indoor trader and accepts an exact safe outdoor visitor approach", () => {
  const scene = fixture(), state = setup(scene), trader = state.residents.leaftail, guest = state.residents.lopukh;
  for (let tick = 0; tick < 30 && trader.doorPhase !== "inside"; tick++) advanceForestVillagers(state, scene, .1, { now });
  assert.equal(trader.doorPhase, "inside");
  const feet = { ...trader.position }, remaining = trader.wait, elapsed = trader.elapsed;
  const approach = { x: 380, y: 350 }, window = { x: 440, y: 315 };
  assert.equal(requestForestVillagerVisit(state, scene, "lopukh", { id: "leaftail", position: window, size: 44, approach }), true);
  for (let tick = 0; tick < 800; tick++) advanceForestVillagers(state, scene, .1, { now, socialHolds: ["leaftail"] });
  assert.equal(trader.doorPhase, "inside"); assert.deepEqual(trader.position, feet); assert.equal(trader.wait, remaining);
  assert.ok(trader.elapsed > elapsed + 79); assert.equal(guest.route, null); assert.ok(distanceBetween(guest.position, approach) < .1);
  noticeForestVillager(state, "leaftail"); advanceForestVillagers(state, scene, .1, { now, socialHolds: ["leaftail"] });
  assert.equal(trader.doorPhase, "exit");
});

test("an artwork handoff preserves a loaded wood cycle without sharing its mutable phase clock", () => {
  const scene = fixture(), state = setup(scene), mind = state.residents.lopukh, places = forestVillagerPlaces(scene, "lopukh");
  for (const id of ["kamneshmyg", "leaftail"]) state.residents[id].available = false;
  beginWoodcutterCycle(mind, places, [], { chopSeconds: 0 });
  for (let tick = 0; tick < 300 && !(mind.woodwork.phase === "haul" && mind.route); tick++)
    advanceForestVillagers(state, scene, .05, { now });
  assert.equal(mind.woodwork.phase, "haul"); assert.ok(mind.route);
  const old = structuredClone(state), nextScene = structuredClone(scene);
  nextScene.terrain.push({ id: "different-art", image: "/test.webp", bounds: { x: 0, y: 0, width: 1, height: 1 } });
  const next = rehydrateForestVillagers(nextScene, state, now), carried = next.residents.lopukh;
  assert.deepEqual(carried.position, mind.position); assert.equal(carried.woodwork.phase, "haul");
  assert.equal(carried.woodwork.elapsed, mind.woodwork.elapsed); assert.notEqual(carried.woodwork, mind.woodwork);
  assert.equal(forestVillagerFrames(next).find(frame => frame.id === "lopukh").action, "carry");
  for (let tick = 0; tick < 500 && !carried.woodwork.completedCycles; tick++)
    advanceForestVillagers(next, nextScene, .05, { now });
  assert.equal(carried.woodwork.completedCycles, 1); assert.deepEqual(state, old);
});
