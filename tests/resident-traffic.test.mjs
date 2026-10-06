import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { canTraverseResidents, residentTrafficDetour, residentClearance } = await vite.ssrLoadModule("/features/world/resident-traffic.ts");
const { createWorldNavigation, canTraverse, withWorldNavigationObstacle } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { createBuilderMind, advanceBuilderMind, builderMindFrame, requestBuilderVisit } = await vite.ssrLoadModule("/features/world/builder-mind.ts");
const { builderLocalPlaces, builderWorkStops } = await vite.ssrLoadModule("/features/world/builder-navigation.ts");
const { createPleskMind, advancePleskMind, pleskMindFrame, requestPleskTrade } = await vite.ssrLoadModule("/features/world/plesk-mind.ts");
const { pleskLocalPlaces } = await vite.ssrLoadModule("/features/world/plesk-resident.ts");
const { createClearingActivity, requestClearingPoint, advanceClearingActivity, isClearingAtPoint } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const point = (x, y) => ({ x, y });
const rect = (x, y, width, height) => [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function scene(height = 180) {
  return { schemaVersion: 1, id: "resident-traffic", width: 360, height,
    terrain: [], focus: { x: 0, y: 0, width: 360, height }, actor: { spawn: point(40, height / 2), size: 50 },
    sites: [], paths: [], destinations: [
      { id: "plesk-fishing", position: point(40, height / 2), pauseSeconds: 4 },
      { id: "plesk-trade", position: point(320, height / 2), pauseSeconds: 4 }],
    navigation: { version: 1, cellSize: 5, areas: [{ id: "land", points: rect(0, 0, 360, height) }], obstacles: [], interests: [] } };
}
const occupant = (id, x, y, size = 40, moving = false) => ({ id, position: point(x, y), size, moving });

test("resident clearance protects a swept crossing and allows only outward movement from an old overlap", () => {
  const other = occupant("mochlik", 100, 100, 50);
  assert.equal(canTraverseResidents(point(50, 100), point(150, 100), 40, [other], "builder"), false);
  assert.equal(canTraverseResidents(point(50, 60), point(150, 60), 40, [other], "builder"), true);
  assert.equal(canTraverseResidents(point(50, 73.5), point(150, 73.5), 40, [other], "builder"), true,
    "a 26.5px passing gap fits the smaller personal space, where the former 28.8px gap blocked it");
  assert.equal(canTraverseResidents(point(50, 75), point(150, 75), 40, [other], "builder"), false,
    "a 25px passing gap still cannot cut into the resident's body");
  assert.equal(canTraverseResidents(point(90, 100), point(80, 100), 40, [other], "builder"), true);
  assert.equal(canTraverseResidents(point(90, 100), point(120, 100), 40, [other], "builder"), false);
  assert.equal(canTraverseResidents(point(90, 100), point(95, 120), 40, [other], "builder"), false);
  assert.equal(canTraverseResidents(point(100, 100), point(100, 99), 40, [other], "builder"), true);
  assert.equal(canTraverseResidents(point(100, 100), point(100, 100), 40, [other], "builder"), false);
  assert.equal(canTraverseResidents(point(100, 100), point(100, 100), 40, [other], "mochlik"), true);
});

test("detours retain the existing prop profile, cache retries and leave the shared grid untouched", () => {
  const world = scene(), base = createWorldNavigation(world, 4);
  const nav = withWorldNavigationObstacle(base, rect(170, 15, 20, 65));
  const originalGrid = [...base.grid.walkable], originalBlockers = base.debug.blockers.length;
  const owner = {}, from = point(70, 90), target = point(290, 90), others = [occupant("mochlik", 180, 90)];
  const options = { owner, navigation: nav, from, target, size: 40, occupants: others, selfId: "builder", time: 0 };
  const path = residentTrafficDetour(options);
  assert.ok(path?.length > 2);
  for (let index = 1; index < path.length; index++) {
    assert.ok(canTraverse(nav, path[index - 1], path[index]));
    assert.ok(canTraverseResidents(path[index - 1], path[index], 40, others, "builder"));
  }
  for (let index = 1; index < 24; index++) assert.equal(residentTrafficDetour({ ...options, time: index / 30 }), null);
  assert.ok(residentTrafficDetour({ ...options, time: .81 }));
  assert.deepEqual([...base.grid.walkable], originalGrid); assert.equal(base.debug.blockers.length, originalBlockers);
  assert.equal(canTraverse(nav, point(175, 30), point(175, 30)), false, "parked prop was not replaced by resident collision");
  const resizedOwner = {}, resizeOptions = { ...options, owner: resizedOwner, navigation: base, from: point(70, 110),
    target: point(290, 110), occupants: [occupant("mochlik", 180, 110)], size: 20 };
  assert.ok(residentTrafficDetour(resizeOptions));
  assert.ok(residentTrafficDetour({ ...resizeOptions, size: 80, time: 2 }), "changing visible size invalidates the cached personal space");
});

test("two opposite walkers pass without overlap, oscillation or teleporting", () => {
  const world = scene(), navigation = createWorldNavigation(world, 4);
  const walkers = [
    { id: "builder", size: 40, position: point(50, 90), target: point(310, 90), path: [point(310, 90)] },
    { id: "plesk", size: 36, position: point(310, 90), target: point(50, 90), path: [point(50, 90)] },
  ];
  let retries = 0;
  for (let time = 0; time < 40 && walkers.some(item => distance(item.position, item.target) > .01); time += .05) {
    for (const walker of walkers) {
      const end = walker.path[0]; if (!end) continue;
      const before = { ...walker.position }, length = distance(before, end), step = Math.min(length, 20 * .05);
      const next = point(before.x + (end.x - before.x) * step / (length || 1), before.y + (end.y - before.y) * step / (length || 1));
      const others = walkers.map(item => ({ id: item.id, size: item.size, position: { ...item.position }, moving: item.path.length > 0 }));
      if (canTraverseResidents(before, next, walker.size, others, walker.id)) {
        assert.ok(canTraverse(navigation, before, next)); walker.position = next;
        if (length <= step + 1e-7) walker.path.shift();
      } else {
        const path = residentTrafficDetour({ owner: walker, navigation, from: before, target: walker.target,
          size: walker.size, occupants: others, selfId: walker.id, time });
        if (path) { retries++; walker.path = path.slice(1); }
      }
      assert.ok(distance(before, walker.position) <= 1 + 1e-7);
      assert.ok(distance(walkers[0].position, walkers[1].position) >= residentClearance(40, 36) - 1e-7);
    }
  }
  assert.ok(walkers.every(item => distance(item.position, item.target) < .01), JSON.stringify(walkers));
  assert.ok(retries > 0 && retries < 8, `${retries} detours must not turn into frame-by-frame replanning`);
});

test("builder and Plesk route owners pass head-on while keeping their own final actions", () => {
  const world = scene();
  world.destinations[0].position = point(310, 90); world.destinations[1].position = point(50, 90);
  const builder = createBuilderMind(world), plesk = createPleskMind(world, 9), end = point(310, 90);
  builder.position = point(50, 90); builder.action = "walk";
  builder.target = { id: "test-rest", position: end, lookAt: point(310, 100) };
  builder.route = { points: [point(50, 90), end], distances: [0, 260], length: 260,
    speedLimits: [1, 0], roundedCorners: 0, checks: 0 };
  requestPleskTrade(plesk); advancePleskMind(plesk, world, 1, { rain: 0, dusk: 0 });
  const occupants = () => [
    { id: "builder", position: { ...builder.position }, size: 40, moving: Boolean(builder.route) },
    { id: "plesk", position: { ...plesk.position }, size: 36, moving: plesk.stage.action === "walk" },
  ];
  let yielded = false;
  for (let time = 0; time < 35 && (builder.route || plesk.stage.action === "walk"); time += .05) {
    const beforeBuilder = { ...builder.position }, beforePlesk = { ...plesk.position };
    if (builder.route) advanceBuilderMind(builder, world, .05, { now: 1000, occupants: occupants() });
    if (plesk.stage.action === "walk") advancePleskMind(plesk, world, .05, { rain: 0, dusk: 0, occupants: occupants() });
    assert.ok(distance(beforeBuilder, builder.position) <= 34 * .05 + 1e-7);
    assert.ok(distance(beforePlesk, plesk.position) <= 16 * .05 + 1e-7);
    assert.ok(distance(builder.position, plesk.position) >= residentClearance(40, 36) - 1e-7);
    yielded ||= builder.trafficWaiting || plesk.trafficWaiting;
  }
  assert.ok(yielded); assert.equal(builder.route, null); assert.equal(builder.action, "idle");
  assert.deepEqual(builder.position, end); assert.equal(plesk.stage.action, "greet");
  assert.deepEqual(plesk.position, world.destinations[1].position);
});

test("a free builder yields his idle goal when Mochlik and he need each other's space beside water", () => {
  const world = { ...scene(800), width: 800, actor: { spawn: point(630, 660), size: 36 },
    destinations: [{ id: "fishing", position: point(690, 700), pauseSeconds: 4 }],
    water: { surfaces: [{ id: "river", points: rect(705, 660, 95, 100) }], exclusions: [] },
    navigation: { version: 1, cellSize: 8, areas: [{ id: "clearing", points: rect(570, 610, 150, 125) }],
      obstacles: [], interests: [{ id: "look", position: point(680, 705), activity: "look" }] } };
  const builder = createBuilderMind(world), hero = createClearingActivity(world), home = { ...builder.position };
  assert.deepEqual(home, point(676, 683));
  builder.position = point(680, 705); builder.action = "walk";
  builder.route = { points: [point(680, 705), home], distances: [0, distance(builder.position, home)],
    length: distance(builder.position, home), speedLimits: [1, 0], roundedCorners: 0, checks: 0 };
  hero.position = point(666.78, 684.52);
  assert.ok(requestClearingPoint(hero, point(690, 700)));
  const occupants = () => [
    { id: "builder", position: { ...builder.position }, size: 40, moving: Boolean(builder.route) },
    { id: "mochlik", position: { ...hero.position }, size: 36, moving: hero.stage === "free-walk" },
  ];
  let yielded = false;
  for (let time = 0; time < 15 && !isClearingAtPoint(hero, point(690, 700)); time += .05) {
    const beforeBuilder = { ...builder.position }, beforeHero = { ...hero.position };
    advanceBuilderMind(builder, world, .05, { now: 1000, occupants: occupants() });
    advanceClearingActivity(hero, .05, { enabled: true, blocked: false, dusk: 0, rain: 0, occupants: occupants() });
    assert.ok(distance(beforeBuilder, builder.position) <= 34 * .05 + 1e-7);
    assert.ok(distance(beforeHero, hero.position) <= 36 * .36 * .05 + 1e-7);
    assert.ok(canTraverse(builderLocalPlaces(world).navigation, beforeBuilder, builder.position));
    assert.ok(canTraverse(hero.navigation, beforeHero, hero.position));
    assert.ok(distance(builder.position, hero.position) >= residentClearance(40, 36) - 1e-7);
    yielded ||= builder.target?.id === "builder-yield";
  }
  assert.ok(yielded, "an unowned idle endpoint must not deadlock the explicit fishing route");
  assert.ok(isClearingAtPoint(hero, point(690, 700))); assert.equal(builder.job, null);
});

test("a short escape from navigation padding frees crossed quarry and fishing routes beside water", () => {
  const world = { ...scene(800), width: 800, actor: { spawn: point(630, 660), size: 36 },
    destinations: [{ id: "fishing", position: point(690, 700), pauseSeconds: 4 }],
    sites: [{ id: "quarry", label: "Quarry", initialLevel: 1, bounds: { x: 660, y: 590, width: 55, height: 48 },
      anchor: point(687.5, 614), entry: point(680, 640), doorway: point(686, 625), collision: [], hitArea: [], states: [] }],
    water: { surfaces: [{ id: "river", points: rect(705, 660, 95, 100) }], exclusions: [] },
    navigation: { version: 1, cellSize: 8, areas: [{ id: "clearing", points: rect(570, 610, 150, 125) }],
      obstacles: [], interests: [{ id: "look", position: point(680, 705), activity: "look" }] } };
  const builder = createBuilderMind(world), hero = createClearingActivity(world), goal = point(665.447862, 631.268717);
  builder.position = point(680, 705); builder.action = "walk";
  builder.target = { id: "builder-look-quarry", position: goal, lookAt: point(687.5, 614) };
  builder.route = { points: [point(680, 705), goal], distances: [0, distance(builder.position, goal)],
    length: distance(builder.position, goal), speedLimits: [1, 0], roundedCorners: 0, checks: 0 };
  hero.position = point(666.783279, 684.522186);
  assert.ok(requestClearingPoint(hero, point(690, 700)));
  const occupants = () => [
    { id: "builder", position: { ...builder.position }, size: 40, moving: Boolean(builder.route) },
    { id: "mochlik", position: { ...hero.position }, size: 36, moving: hero.stage === "free-walk" },
  ];
  for (let time = 0; time < 15 && (builder.route || !isClearingAtPoint(hero, point(690, 700))); time += .05) {
    const beforeBuilder = { ...builder.position }, beforeHero = { ...hero.position };
    if (builder.route) advanceBuilderMind(builder, world, .05, { now: 1000, occupants: occupants() });
    advanceClearingActivity(hero, .05, { enabled: true, blocked: false, dusk: 0, rain: 0, occupants: occupants() });
    assert.ok(distance(beforeBuilder, builder.position) <= 34 * .05 + 1e-7);
    assert.ok(distance(beforeHero, hero.position) <= 36 * .36 * .05 + 1e-7);
    assert.ok(canTraverse(builderLocalPlaces(world).navigation, beforeBuilder, builder.position));
    assert.ok(canTraverse(hero.navigation, beforeHero, hero.position));
    assert.ok(distance(builder.position, hero.position) >= residentClearance(40, 36) - 1e-7);
  }
  assert.ok(isClearingAtPoint(hero, point(690, 700))); assert.deepEqual(builder.position, goal);
  assert.equal(builder.target.id, "builder-look-quarry", "a reachable unoccupied goal remains intact");
});

test("Plesk waits in a narrow occupied passage, keeps the pending trade and resumes without skipping walking time", () => {
  const world = scene(44), mind = createPleskMind(world, 9), places = pleskLocalPlaces(world);
  const others = [occupant("builder", 180, 22, 40)], environment = { rain: 0, dusk: 0, occupants: others };
  mind.catchCount = 2; requestPleskTrade(mind);
  let waitingAt = null, waitingAge = null;
  for (let time = 0; time < 35; time += .1) {
    const before = { ...mind.position };
    advancePleskMind(mind, world, .1, environment);
    assert.ok(distance(before, mind.position) <= 1.6 + 1e-7);
    assert.ok(canTraverseResidents(before, mind.position, 36, others, "plesk"));
    if (mind.trafficWaiting) {
      waitingAt ??= { ...mind.position }; waitingAge ??= mind.age;
      assert.deepEqual(mind.position, waitingAt); assert.equal(mind.age, waitingAge);
      assert.equal(pleskMindFrame(mind, world, false).action, "idle");
    }
  }
  assert.ok(waitingAt); assert.equal(mind.stage.action, "walk"); assert.equal(mind.catchCount, 2);
  assert.equal(mind.stage.target.id, "plesk-trade"); assert.ok(mind.elapsed > 34);
  for (let time = 0; time < 20 && mind.stage.action === "walk"; time += .1) {
    const before = { ...mind.position };
    advancePleskMind(mind, world, .1, { rain: 0, dusk: 0 });
    assert.ok(distance(before, mind.position) <= 1.6 + 1e-7, "release cannot jump to the old elapsed-time endpoint");
  }
  assert.equal(mind.stage.action, "greet"); assert.deepEqual(mind.position, places.trade.position); assert.equal(mind.catchCount, 2);
});

test("Plesk takes a checked detour around a stationary neighbour and reaches the same finite trade", () => {
  const world = scene(), mind = createPleskMind(world, 9), places = pleskLocalPlaces(world);
  const others = [occupant("mochlik", 180, 90, 50)], environment = { rain: 0, dusk: 0, occupants: others };
  requestPleskTrade(mind); let detoured = false;
  for (let time = 0; time < 40 && mind.stage.action !== "trade"; time += .1) {
    const before = { ...mind.position };
    advancePleskMind(mind, world, .1, environment);
    assert.ok(distance(before, mind.position) <= 1.6 + 1e-7);
    assert.ok(canTraverse(places.nav, before, mind.position));
    assert.ok(canTraverseResidents(before, mind.position, 36, others, "plesk"));
    detoured ||= Math.abs(mind.position.y - 90) > 20;
  }
  assert.ok(detoured); assert.equal(mind.stage.action, "trade"); assert.deepEqual(mind.position, places.trade.position);
});

test("builder approaches around an occupied route, then keeps his work feet and construction clock", () => {
  const world = scene(260);
  world.sites = [{ id: "home", label: "Home", initialLevel: 1, bounds: { x: 270, y: 10, width: 70, height: 70 },
    anchor: point(305, 45), entry: point(305, 85), hitArea: rect(270, 10, 70, 70), collision: rect(280, 20, 50, 50),
    states: [{ level: 1, label: "Home", image: "/home.webp" }, { level: 2, label: "Home 2", image: "/home-2.webp" }] }];
  const now = Date.parse("2026-10-06T18:00:00Z"), job = { id: "home-job", stationId: "home", targetLevel: 2,
    startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 3600_000).toISOString() };
  const construction = { ownerPublicId: "traffic-owner", revision: 1, jobs: [job] };
  const mind = createBuilderMind(world), nav = builderLocalPlaces(world).navigation;
  advanceBuilderMind(mind, world, 0, { now, construction });
  const end = mind.target.position, start = { ...mind.position };
  const others = [occupant("mochlik", (start.x + end.x) / 2, (start.y + end.y) / 2, 50)];
  let detoured = false;
  for (let time = 0; time < 30 && mind.action !== "work"; time += .05) {
    const before = { ...mind.position };
    advanceBuilderMind(mind, world, .05, { now, construction, occupants: others });
    assert.ok(distance(before, mind.position) <= 34 * .05 + 1e-7);
    assert.ok(canTraverse(nav, before, mind.position));
    assert.ok(canTraverseResidents(before, mind.position, 40, others, "builder"));
    detoured ||= mind.trafficWaiting;
  }
  assert.ok(detoured); assert.equal(mind.action, "work"); assert.deepEqual(mind.position, end);
  assert.equal(mind.job.finishesAt, job.finishesAt); assert.equal(builderMindFrame(mind, world, false).targetId, "home");
  const firstWork = builderWorkStops(world, job)[0];
  const occupiedWork = occupant("mochlik", firstWork.position.x, firstWork.position.y - 20, 50);
  const cold = createBuilderMind(world, { awaitConstruction: true });
  advanceBuilderMind(cold, world, 0, { now, construction, occupants: [occupiedWork] });
  assert.equal(cold.action, "work"); assert.ok(distance(cold.position, occupiedWork.position) >= residentClearance(40, 50));
  const crowded = createBuilderMind(world, { awaitConstruction: true }), startFeet = { ...crowded.position };
  advanceBuilderMind(crowded, world, 0, { now, construction, occupants: [occupant("mochlik", firstWork.position.x, firstWork.position.y, 50)] });
  assert.equal(crowded.action, "walk"); assert.deepEqual(crowded.position, startFeet, "if all work points are occupied, never restore on top of another hero");
});

function narrowPassage() {
  return { ...scene(), destinations: [],
    navigation: { version: 1, cellSize: 5,
      areas: [{ id: "room", points: rect(0, 0, 105, 180) }, { id: "passage", points: rect(80, 70, 280, 40) }],
      obstacles: [], interests: [{ id: "far-side", position: point(310, 90), activity: "look" }] } };
}

test("a stopped mid-route neighbour cannot hold a free builder in a narrow passage forever", () => {
  for (const moving of [false, true]) {
    const world = narrowPassage();
    const builder = createBuilderMind(world), navigation = builderLocalPlaces(world).navigation;
    builder.position = point(130, 90); builder.action = "walk";
    builder.target = { id: "idle-shopward", position: point(310, 90), lookAt: point(310, 100) };
    builder.route = { points: [point(130, 90), point(310, 90)], distances: [0, 180], length: 180,
      speedLimits: [1, 0], roundedCorners: 0, checks: 0 };
    const neighbour = occupant("mochlik", 180, 90, 50, moving), original = structuredClone(neighbour);
    assert.equal(canTraverseResidents(builder.target.position, builder.target.position, 40, [neighbour], "builder"), true,
      "the idle destination is free: only the middle of its approach is blocked");
    let waited = false, yieldedAt = null;
    for (let time = 0; time < 8; time += .05) {
      const before = { ...builder.position };
      advanceBuilderMind(builder, world, .05, { now: 1000, occupants: [neighbour] });
      assert.ok(canTraverse(navigation, before, builder.position));
      assert.ok(canTraverseResidents(before, builder.position, 40, [neighbour], "builder"));
      assert.ok(distance(before, builder.position) <= 34 * .05 + 1e-7, "retreat is walked, never teleported");
      waited ||= builder.trafficWaiting;
      if (builder.target?.id === "builder-yield") yieldedAt ??= time;
      if (yieldedAt !== null && !builder.route) break;
    }
    assert.ok(waited);
    assert.ok(yieldedAt !== null && yieldedAt < 5, `moving=${moving}: a free route needs bounded recovery`);
    assert.ok(builder.position.x < 130, "the free builder walks back into available space");
    assert.equal(builder.route, null); assert.equal(builder.job, null);
    assert.equal(builder.socialVisit, null); assert.deepEqual(neighbour, original);
  }
});


test("waiting in a narrow passage cannot abandon a confirmed work order or a social reservation", () => {
  for (const kind of ["construction", "social"]) {
    const world = narrowPassage();
    if (kind === "construction") world.sites = [{ id: "workshop", entry: point(310, 90), anchor: point(310, 50),
      bounds: { x: 290, y: 10, width: 40, height: 40 }, initialLevel: 1, collision: [], hitArea: [], states: [] }];
    const builder = createBuilderMind(world), navigation = builderLocalPlaces(world).navigation;
    builder.position = point(130, 90);
    const neighbour = occupant("mochlik", 180, 90, 50), occupants = [neighbour];
    const order = { id: "blocked-work", stationId: "workshop", targetLevel: 2,
      startedAt: new Date(1000).toISOString(), finishesAt: new Date(600_000).toISOString() };
    const construction = kind === "construction" ? { ownerPublicId: "owner", revision: 1, jobs: [order] } : undefined;
    if (construction) advanceBuilderMind(builder, world, 0, { now: 1000, construction, occupants });
    else assert.equal(requestBuilderVisit(builder, world, { id: "friend", position: point(310, 90), size: 40 }, occupants), true);
    assert.ok(builder.route); assert.ok(builder.target.position.x > neighbour.position.x);
    const target = structuredClone(builder.target), visit = structuredClone(builder.socialVisit);
    let waited = false;
    for (let time = 0; time < 10; time += .05) {
      const before = { ...builder.position };
      advanceBuilderMind(builder, world, .05, { now: 1000, construction, occupants });
      assert.ok(canTraverse(navigation, before, builder.position));
      assert.ok(canTraverseResidents(before, builder.position, 40, occupants, "builder"));
      assert.ok(distance(before, builder.position) <= 34 * .05 + 1e-7);
      waited ||= builder.trafficWaiting;
    }
    assert.ok(waited); assert.deepEqual(builder.target, target);
    assert.deepEqual(builder.socialVisit, visit); assert.deepEqual(builder.job, construction ? order : null);
    assert.notEqual(builder.action, "finish"); assert.notEqual(builder.action, "work");
    // The traffic wait remains live: releasing the obstructing feet resumes the
    // very same reservation, without silently completing or replacing it.
    for (let time = 0; time < 12 && builder.route; time += .05)
      advanceBuilderMind(builder, world, .05, { now: 1000, construction, occupants: [] });
    assert.equal(builder.route, null); assert.deepEqual(builder.position, target.position);
    assert.deepEqual(builder.target, target); assert.deepEqual(builder.socialVisit, visit);
    assert.equal(builder.action, construction ? "work" : "idle");
  }
});
