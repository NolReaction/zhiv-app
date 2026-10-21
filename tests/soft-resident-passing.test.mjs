import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const load = path => vite.ssrLoadModule(`/features/world/${path}.ts`);
const { residentTrafficDetour, residentWalkingStep, residentClearance, residentRouteIntent } = await load("navigation/resident-traffic");
const { createWorldNavigation, canTraverse, withWorldNavigationObstacle } = await load("navigation/navigation");
const { createBuilderMind, advanceBuilderMind } = await load("characters/builder/builder-mind");
const { builderLocalPlaces } = await load("characters/builder/builder-navigation");
const { advanceClearingActivity, clearingResidentIntent, isClearingAtPoint } = await load("simulation/clearing-activity");
const { connectForestSession } = await load("state/forest-session");
const { syncForestJourneyTravel } = await load("activities/journeys/forest-journey-travel");
const point = (x, y) => ({ x, y });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rect = (x, y, w, h) => [point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h)];
function ringScene() {
  return { schemaVersion: 1, id: "soft-passing", width: 360, height: 300, terrain: [],
    focus: { x: 0, y: 0, width: 360, height: 300 }, actor: { spawn: point(70, 240), size: 50 },
    sites: [], paths: [], destinations: [], navigation: { version: 1, cellSize: 5,
      areas: [{ id: "lower", points: rect(0, 220, 360, 40) }, { id: "upper", points: rect(0, 20, 360, 40) },
        { id: "left", points: rect(0, 20, 60, 240) }, { id: "right", points: rect(300, 20, 60, 240) }],
      obstacles: [], interests: [] } };
}
function route(from, target) {
  const length = distance(from, target);
  return { points: [{ ...from }, { ...target }], distances: [0, length], length, speedLimits: [1, 0], roundedCorners: 0, checks: 0 };
}
function moving(id, from, target, size) {
  return { id, position: { ...from }, size, moving: true, intent: residentRouteIntent(route(from, target), from, 0, size, 2) };
}

test("a moving resident cannot send a route around the remote side of a narrow ring", () => {
  const world = ringScene(), navigation = createWorldNavigation(world, 4);
  const from = point(154, 240), target = point(280, 240), other = moving("builder", point(180, 240), point(70, 240), 40);
  const options = { owner: {}, navigation, from, target, size: 50, occupants: [other], selfId: "mochlik", time: 1 };
  const originalGrid = [...navigation.grid.walkable], blockers = structuredClone(navigation.debug.blockers);
  assert.equal(residentTrafficDetour(options), null, "the long northern detour is rejected");
  assert.deepEqual(residentWalkingStep(options, point(156, 240)), { clear: true });
  assert.deepEqual([...navigation.grid.walkable], originalGrid); assert.deepEqual(navigation.debug.blockers, blockers);
});

test("soft passing still rejects stationary feet, scene walls and a parked prop", () => {
  const world = ringScene(), navigation = createWorldNavigation(world, 4), from = point(154, 240), target = point(280, 240);
  const neighbour = moving("builder", point(180, 240), point(70, 240), 40);
  const options = { owner: {}, navigation, from, target, size: 50, occupants: [neighbour], selfId: "mochlik", time: 1 };
  assert.equal(residentWalkingStep({ ...options, occupants: [{ ...neighbour, moving: false, intent: undefined }] }, point(156, 240)).clear, false);
  assert.equal(residentWalkingStep({ ...options, owner: {} }, point(156, 210)).clear, false, "a resident exception cannot cross the river gap");
  const prop = withWorldNavigationObstacle(navigation, rect(155, 235, 10, 10));
  assert.equal(residentWalkingStep({ ...options, owner: {}, navigation: prop }, point(156, 240)).clear, false, "a parked basket retains its strict profile");
});

function walkPair(sameWay) {
  const world = ringScene();
  world.destinations = [{ id: "fishing", position: point(285, 240), pauseSeconds: 4 }];
  const startedAt = 1_000_000, session = connectForestSession(undefined, world, "world", startedAt, 0, () => {}, { persistence: false, sync: false });
  const state = session.state, hero = state.clearing, builder = createBuilderMind(world);
  const job = { id: "narrow-shore-job", routeId: "shore", label: "Рыбалка", startedAt: new Date(startedAt).toISOString(),
    finishesAt: new Date(startedAt + 600_000).toISOString(), rewards: { fish: 4 } };
  const paidJob = structuredClone(job);
  hero.position = sameWay ? point(100, 240) : point(70, 240);
  const heroTarget = point(285, 240), builderTarget = sameWay ? point(285, 240) : point(70, 240);
  builder.position = sameWay ? point(65, 240) : point(285, 240);
  builder.action = "walk"; builder.target = { id: "test-walk", position: builderTarget, lookAt: point(builderTarget.x, 250) };
  builder.route = route(builder.position, builderTarget);
  syncForestJourneyTravel(state, world, null, startedAt, false);
  syncForestJourneyTravel(state, world, job, startedAt, false);
  assert.deepEqual(hero.requestedPoint, heroTarget);
  assert.equal(state.journeyTravel.phase, "leaving");
  const builderNavigation = builderLocalPlaces(world).navigation;
  const occupants = () => [
    { id: "mochlik", position: { ...hero.position }, size: 50, moving: hero.stage === "free-walk", intent: clearingResidentIntent(hero) },
    { id: "builder", position: { ...builder.position }, size: 40, moving: Boolean(builder.route),
      intent: builder.route ? residentRouteIntent(builder.route, builder.position, builder.distance, 40, 1) : undefined }];
  let overlap = false, crossed = false, builderDone = false;
  for (let time = 0; time < 25 && (!builderDone || !isClearingAtPoint(hero, heroTarget)); time += .025) {
    syncForestJourneyTravel(state, world, job, startedAt + time * 1000, false);
    const beforeHero = { ...hero.position }, beforeBuilder = { ...builder.position };
    if (!builderDone) advanceBuilderMind(builder, world, .025, { now: 1000, occupants: occupants() });
    if (!isClearingAtPoint(hero, heroTarget)) advanceClearingActivity(hero, .025, { enabled: true, blocked: false, dusk: 0, rain: 0, occupants: occupants() });
    assert.ok(distance(beforeHero, hero.position) <= 50 * .36 * .025 + 1e-7, "Mochlik always walks at his normal speed");
    assert.ok(distance(beforeBuilder, builder.position) <= 34 * .025 + 1e-7, "builder never teleports");
    assert.ok(canTraverse(hero.navigation, beforeHero, hero.position));
    assert.ok(canTraverse(builderNavigation, beforeBuilder, builder.position));
    assert.ok(hero.position.y >= 220 && builder.position.y >= 220, "neither resident takes the remote upper route");
    assert.equal(builder.target.id, "test-walk", "encounters preserve the actual destination");
    overlap ||= distance(hero.position, builder.position) < residentClearance(50, 40);
    crossed ||= sameWay ? builder.position.x > hero.position.x + 1 : builder.position.x < hero.position.x - 1;
    builderDone ||= builder.route === null;
    // The shared endpoint is deliberately occupied after overtaking; this case
    // only needs proof of progress past the other moving resident.
    if (sameWay && crossed && distance(hero.position, builder.position) > residentClearance(50, 40)) break;
  }
  assert.ok(overlap, "the narrow path permits controlled visual overlap");
  assert.ok(crossed, "head-on and overtaking routes both make progress");
  syncForestJourneyTravel(state, world, job, startedAt + 25_000, false);
  if (!sameWay) {
    assert.equal(builder.route, null); assert.deepEqual(builder.position, builderTarget); assert.ok(isClearingAtPoint(hero, heroTarget));
    assert.equal(state.journeyTravel.phase, "fishing");
  }
  assert.equal(state.journeyTravel.jobId, job.id); assert.deepEqual(job, paidJob, "visual traffic cannot change the paid catch");
  session.release();
}
test("Mochlik and builder pass head-on on a narrow path without changing destinations", () => walkPair(false));
test("a faster builder can overtake Mochlik locally on the same narrow path", () => walkPair(true));
