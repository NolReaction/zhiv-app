import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { basketGroundFootprint, canTraverseGroundFootprint } = await vite.ssrLoadModule("/features/world/navigation/ground-props.ts");
const { canTraverseResidents, residentWalkingStep } = await vite.ssrLoadModule("/features/world/navigation/resident-traffic.ts");
const { createWorldNavigation, canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { createBuilderMind, advanceBuilderMind, builderMindFrame } = await vite.ssrLoadModule("/features/world/characters/builder/builder-mind.ts");
const { builderLocalPlaces } = await vite.ssrLoadModule("/features/world/characters/builder/builder-navigation.ts");
const { createPleskMind, advancePleskMind, requestPleskTrade } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-mind.ts");
const { pleskLocalPlaces } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-resident.ts");
const { createClearingActivity, requestClearingPoint, advanceClearingActivity, isClearingAtPoint } = await vite.ssrLoadModule("/features/world/simulation/clearing-activity.ts");
const { createForestGarden } = await vite.ssrLoadModule("/features/world/activities/garden/forest-garden.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const point = (x, y) => ({ x, y });
const rect = (x, y, w, h) => [point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h)];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const basket = (x, y, size = 14) => ({ id: "garden-basket", position: point(x, y), size,
  groundFootprint: basketGroundFootprint(point(x, y), size) });
function fixture(height = 100) {
  return { schemaVersion: 1, id: "basket-traffic", width: 360, height, terrain: [], sites: [], paths: [],
    focus: { x: 0, y: 0, width: 360, height }, actor: { spawn: point(50, height / 2), size: 40 },
    destinations: [{ id: "plesk-fishing", position: point(50, height / 2), pauseSeconds: 4 },
      { id: "plesk-trade", position: point(310, height / 2), pauseSeconds: 4 }],
    navigation: { version: 1, cellSize: 5, areas: [{ id: "land", points: rect(0, 0, 360, height) }], obstacles: [], interests: [] } };
}
function setBuilderRoute(mind, from, to) {
  mind.position = { ...from }; mind.action = "walk";
  mind.target = { id: "basket-test-rest", position: { ...to }, lookAt: point(to.x, to.y + 10) };
  mind.route = { points: [{ ...from }, { ...to }], distances: [0, distance(from, to)], length: distance(from, to),
    speedLimits: [1, 0], roundedCorners: 0, checks: 0 };
}

test("basket support uses physical feet, including a one-way escape when lowered over existing feet", () => {
  const prop = basket(100, 100), footprint = prop.groundFootprint;
  assert.equal(canTraverseResidents(point(50, 100), point(150, 100), 40, [prop], "builder"), false);
  assert.equal(canTraverseResidents(point(50, 110), point(150, 110), 40, [prop], "builder"), true,
    "ten pixels below the sole is clear; a basket must not gain a person's 15px personal space");
  assert.equal(canTraverseGroundFootprint(footprint, point(108, 99), point(120, 99), 4), true);
  assert.equal(canTraverseGroundFootprint(footprint, point(108, 99), point(80, 99), 4), false);
  assert.equal(canTraverseGroundFootprint(footprint, point(107, 98.6), point(50, 98.6), 4), false,
    "starting exactly on the edge cannot tunnel through to the opposite side");
  const owner = {}, navigation = createWorldNavigation(fixture(16), 4), narrow = basket(180, 8);
  const options = { owner, navigation, from: point(165, 8), target: point(310, 8), size: 40,
    occupants: [{ ...narrow, moving: true, intent: { points: [point(180, 8), point(50, 8)], target: point(50, 8), priority: 2 } }], selfId: "builder", time: 0 };
  assert.equal(residentWalkingStep(options, point(190, 8)).clear, false);
  assert.equal(residentWalkingStep({ ...options, time: 2 }, point(190, 8)).clear, false,
    "failed detours never activate the moving-resident soft pass for a prop");
  assert.equal(residentWalkingStep({ ...options, time: 2.1, occupants: [] }, point(190, 8)).clear, true,
    "lifting releases the support immediately, even during retry cooldown");
});

test("builder, Pleska and Mochlik walk around the same small basket while retaining water and building constraints", () => {
  for (const id of ["builder", "plesk", "mochlik"]) {
    const world = fixture(), prop = basket(180, 50), occupants = [prop];
    world.water = { surfaces: [{ id: "river", points: rect(160, 60, 40, 40) }], exclusions: [] };
    world.navigation.obstacles.push({ id: "building", points: rect(160, 0, 40, 25) });
    const target = point(310, 50), mind = id === "builder" ? createBuilderMind(world)
      : id === "plesk" ? createPleskMind(world, 9) : createClearingActivity(world);
    let navigation, done, advance;
    if (id === "builder") {
      setBuilderRoute(mind, point(50, 50), target); navigation = builderLocalPlaces(world).navigation;
      done = () => !mind.route; advance = dt => advanceBuilderMind(mind, world, dt, { now: 1000, occupants });
    } else if (id === "plesk") {
      requestPleskTrade(mind); advancePleskMind(mind, world, 0, { rain: 0, dusk: 0, occupants });
      navigation = pleskLocalPlaces(world).nav; done = () => mind.stage.action === "greet";
      advance = dt => advancePleskMind(mind, world, dt, { rain: 0, dusk: 0, occupants });
    } else {
      assert.equal(requestClearingPoint(mind, target), true); navigation = mind.navigation;
      done = () => isClearingAtPoint(mind, target);
      advance = dt => advanceClearingActivity(mind, dt, { enabled: true, blocked: false, dusk: 0, rain: 0, occupants });
    }
    let detoured = false;
    for (let elapsed = 0; elapsed < 45 && !done(); elapsed += .05) {
      const before = { ...mind.position }; advance(.05);
      assert.ok(distance(before, mind.position) <= 34 * .05 + 1e-6, `${id}: no teleport`);
      assert.ok(canTraverse(navigation, before, mind.position), `${id}: water/building stay solid`);
      assert.ok(canTraverseResidents(before, mind.position, id === "plesk" ? 36 : 40, occupants, id), `${id}: swept prop support`);
      detoured ||= Math.abs(mind.position.y - 50) > 5;
    }
    assert.ok(done(), `${id}: the original target is reached`); assert.ok(detoured, id);
    assert.deepEqual(mind.position, target);
  }
});

test("the authored garden basket makes the real builder take a local continuous detour", () => {
  const world = withPlacedBushArtwork(TILED_WORLD), garden = createForestGarden(world), support = garden.basket;
  assert.ok(support);
  const prop = basket(support.position.x, support.position.y, support.size), navigation = builderLocalPlaces(world).navigation;
  let route;
  for (const angle of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
    const from = point(support.position.x - Math.cos(angle) * 45, support.position.y - Math.sin(angle) * 45);
    const to = point(support.position.x + Math.cos(angle) * 45, support.position.y + Math.sin(angle) * 45);
    if (canTraverse(navigation, from, to)) { route = { from, to }; break; }
  }
  assert.ok(route, "authored basket has a neighbouring ground corridor");
  const mind = createBuilderMind(world), original = [...navigation.grid.walkable]; setBuilderRoute(mind, route.from, route.to);
  let waited = false;
  for (let elapsed = 0; elapsed < 20 && mind.route; elapsed += .05) {
    const before = { ...mind.position };
    advanceBuilderMind(mind, world, .05, { now: 1000, occupants: [prop] });
    assert.ok(distance(before, mind.position) <= 34 * .05 + 1e-6);
    assert.ok(canTraverse(navigation, before, mind.position));
    assert.ok(canTraverseResidents(before, mind.position, 40, [prop], "builder"));
    waited ||= mind.trafficWaiting;
  }
  assert.ok(waited); assert.deepEqual(mind.position, route.to); assert.deepEqual([...navigation.grid.walkable], original);
});

test("a grounded basket blocks the complete builder doorway before reveal and releases after pickup", () => {
  const world = withPlacedBushArtwork(TILED_WORLD), mind = createBuilderMind(world), home = builderLocalPlaces(world).home;
  assert.ok(home);
  for (let elapsed = 0; elapsed < 180 && mind.sleepPhase !== "sleep"; elapsed += .1)
    advanceBuilderMind(mind, world, .1, { now: 1000, night: true });
  assert.equal(mind.sleepPhase, "sleep");
  const prop = basket((home.entry.x + home.doorway.x) / 2, (home.entry.y + home.doorway.y) / 2);
  const before = { ...mind.position }, clock = mind.elapsed;
  for (let frame = 0; frame < 10; frame++) advanceBuilderMind(mind, world, 0, { now: 1000, night: false, occupants: [prop] });
  assert.deepEqual(mind.position, before); assert.equal(mind.elapsed, clock, "hidden/paused zero delta does not advance the owner");
  for (let frame = 0; frame < 30; frame++) advanceBuilderMind(mind, world, .1, { now: 1000, night: false, occupants: [prop] });
  assert.deepEqual(mind.position, home.doorway); assert.equal(builderMindFrame(mind, world, true), null);
  for (let frame = 0; frame < 30 && mind.sleepPhase !== "awake"; frame++) {
    const previous = { ...mind.position }; advanceBuilderMind(mind, world, .1, { now: 1000, night: false, occupants: [] });
    assert.ok(distance(previous, mind.position) <= 34 * .1 + 1e-6);
  }
  assert.equal(mind.sleepPhase, "awake"); assert.deepEqual(mind.position, home.entry);
});
