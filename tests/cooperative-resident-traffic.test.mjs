import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const load = path => vite.ssrLoadModule(`/features/world/${path}.ts`);
const { createClearingActivity, requestClearingPoint, advanceClearingActivity, isClearingAtPoint, releaseClearingPoint } = await load("simulation/clearing-activity");
const { createBuilderMind, advanceBuilderMind } = await load("characters/builder/builder-mind");
const { builderLocalPlaces, builderWorkStops } = await load("characters/builder/builder-navigation");
const { createPleskMind, advancePleskMind, requestPleskTrade } = await load("characters/plesk/plesk-mind");
const { pleskLocalPlaces } = await load("characters/plesk/plesk-resident");
const { forestResidentOccupants } = await load("characters/forest-resident-occupancy");
const { canTraverse, isWalkable } = await load("navigation/navigation");
const { residentClearance, canTraverseResidents, residentRouteIntent, RESIDENT_TRAFFIC_LIMITS } = await load("navigation/resident-traffic");
const { connectForestSession } = await load("state/forest-session");
const { requestForestDirective, advanceForestDirector } = await load("simulation/forest-director");
const { growForestBerries } = await load("activities/garden/forest-garden");
const { TILED_WORLD } = await load("scene/presentation");
const { previewWorldScene } = await load("tiled/preview-state");
const point = (x, y) => ({ x, y });
const rect = (x, y, w, h) => [point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h)];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const calm = { autoLife: false, blocked: false, dusk: 0, rain: 0, homeAvailable: true };
const conditions = { enabled: true, blocked: false, dusk: 0, rain: 0 };
const snapshot = (state, world, options = {}) => forestResidentOccupants(state, world, { heroVisible: true, ...options });
function scene() {
  return { schemaVersion: 1, id: "cooperative", width: 400, height: 240, terrain: [], sites: [], paths: [],
    focus: { x: 0, y: 0, width: 400, height: 240 }, actor: { spawn: point(80, 120), size: 50 },
    destinations: [{ id: "plesk-fishing", position: point(230, 120), pauseSeconds: 4 },
      { id: "plesk-trade", position: point(350, 120), pauseSeconds: 4 }],
    navigation: { version: 1, cellSize: 5, areas: [{ id: "grass", points: rect(0, 0, 400, 240) }], obstacles: [], interests: [] } };
}
function safeStep(before, after, speed, dt, nav, occupants, self, size) {
  assert.ok(distance(before, after) <= speed * dt + .001, `${self} cannot teleport`);
  assert.ok(canTraverse(nav, before, after), `${self} keeps static ground clearance`);
  assert.ok(canTraverseResidents(before, after, size, occupants, self), `${self} keeps swept resident clearance`);
}

test("route intent is bounded, detached and follows reverse travel from the current feet", () => {
  const points = Array.from({ length: 1001 }, (_, index) => point(index, 0)), distances = points.map(point => point.x);
  const forward = residentRouteIntent({ points, distances }, point(500.5, 0), 500.5, 40, 3);
  assert.ok(forward.points.length <= RESIDENT_TRAFFIC_LIMITS.intentPoints);
  assert.ok(forward.points.slice(1).every(point => point.x > 500.5));
  const back = residentRouteIntent({ points, distances }, point(500.5, 0), 500.5, 40, 3, true);
  assert.ok(back.points.slice(1).every(point => point.x < 500.5)); assert.deepEqual(back.target, point(0, 0));
  back.target.x = 99; back.points[1].x = 99; assert.equal(points[0].x, 0); assert.equal(points[500].x, 500);
});

test("the actual berry return makes an idle hedgehog yield before his idle timer, then deposits once", () => {
  const world = withPlacedBushArtwork(previewWorldScene(TILED_WORLD, { home: 1 }));
  const session = connectForestSession(undefined, world, "circle", 0, 0, () => {}), state = session.state;
  session.release(); state.pleskMind = null;
  const garden = state.life.garden, basket = garden.basket, goal = { ...basket.homeApproach }, home = { ...basket.homePosition };
  growForestBerries(garden); requestForestDirective(state, "harvest-berries", calm);
  for (let time = 0; time < 90 && garden.routine?.phase !== "return-basket"; time += .025) advanceForestDirector(state, .025, calm);
  assert.equal(garden.routine?.phase, "return-basket"); assert.ok(garden.routine.carryingBasket);
  const builder = state.builderMind = createBuilderMind(world);
  builder.position = { ...goal }; builder.target = { id: "test-idle", position: { ...goal }, lookAt: home }; builder.wait = 1000;
  const nav = builderLocalPlaces(world).navigation;
  assert.ok(isWalkable(nav, goal)); assert.ok(distance(goal, state.clearing.position) > residentClearance(50, 40));
  let yielded = false, deposited = false, maxDecisions = 0;
  for (let time = 0; time < 90 && garden.routine; time += .025) {
    let others = snapshot(state, world), before = { ...builder.position };
    advanceBuilderMind(builder, world, .025, { now: 1000, occupants: others });
    safeStep(before, builder.position, 34, .025, nav, others, "builder", 40);
    yielded ||= builder.target?.id === "builder-yield"; maxDecisions = Math.max(maxDecisions, builder.decisions);
    others = snapshot(state, world); before = { ...state.clearing.position };
    advanceForestDirector(state, .025, { ...calm, occupants: others });
    safeStep(before, state.clearing.position, 18, .025, state.clearing.navigation, others, "mochlik", 50);
    if (garden.routine?.phase === "deposit") {
      deposited = true; assert.ok(distance(state.clearing.position, goal) < .001);
    }
    assert.equal(garden.basket, basket, "yielding retains the original basket object");
  }
  assert.ok(yielded); assert.ok(deposited); assert.equal(garden.routine, null);
  assert.ok(maxDecisions < 12, "no frame-rate replanning");
  assert.equal(basket.berries, 3); assert.deepEqual(basket.position, home); assert.ok(!basket.held);
  for (let time = 0; time < 3; time += .025) advanceForestDirector(state, .025, { ...calm, occupants: snapshot(state, world) });
  assert.equal(basket.berries, 3, "the delivered crop is never committed twice");
});

test("a working builder changes only his safe work stop to release an exact player goal", () => {
  const world = scene();
  world.sites = [{ id: "home", bounds: { x: 170, y: 20, width: 70, height: 70 }, initialLevel: 1,
    anchor: point(205, 55), entry: point(205, 95), hitArea: rect(170, 20, 70, 70), collision: rect(180, 30, 50, 50),
    states: [{ level: 1, label: "Home", image: "/home.webp" }, { level: 2, label: "Home2", image: "/home2.webp" }] }];
  const now = 1000, job = { id: "real-job", stationId: "home", targetLevel: 2,
    startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 600_000).toISOString() };
  const construction = { ownerPublicId: "owner", revision: 1, jobs: [job] }, saved = structuredClone(construction);
  const builder = createBuilderMind(world, { awaitConstruction: true });
  advanceBuilderMind(builder, world, 0, { now, construction });
  assert.equal(builder.action, "work"); const goal = { ...builder.position };
  const clearing = createClearingActivity(world), state = { clearing, builderMind: builder, pleskMind: null };
  assert.equal(requestClearingPoint(clearing, goal), true);
  const nav = builderLocalPlaces(world).navigation; let relocated = false;
  for (let time = 0; time < 40 && (!isClearingAtPoint(clearing, goal) || builder.route); time += .025) {
    let others = snapshot(state, world), before = { ...builder.position };
    advanceBuilderMind(builder, world, .025, { now, construction, occupants: others });
    safeStep(before, builder.position, 34, .025, nav, others, "builder", 40);
    relocated ||= distance(builder.target.position, goal) > 1;
    others = snapshot(state, world); before = { ...clearing.position };
    advanceClearingActivity(clearing, .025, { ...conditions, occupants: others });
    safeStep(before, clearing.position, 18, .025, clearing.navigation, others, "mochlik", 50);
  }
  assert.ok(relocated); assert.ok(isClearingAtPoint(clearing, goal)); assert.equal(builder.action, "work");
  assert.ok(builderWorkStops(world, job).some(stop => distance(stop.position, builder.position) < .001));
  assert.deepEqual(builder.job, job); assert.deepEqual(construction, saved);
});

test("Plesk releases an occupied held goal, preserves her catch and queue, and resumes only after the passage is free", () => {
  const world = scene(), clearing = createClearingActivity(world), plesk = createPleskMind(world);
  const state = { clearing, builderMind: null, pleskMind: plesk }, goal = { ...plesk.position };
  plesk.stage = { ...plesk.stage, duration: 100 }; plesk.age = 3; plesk.catchCount = 2;
  plesk.queue = [{ action: "idle", duration: 3, target: plesk.stage.target }];
  const queue = structuredClone(plesk.queue), originalStage = plesk.stage;
  assert.equal(requestClearingPoint(clearing, goal), true);
  const nav = pleskLocalPlaces(world).nav; let yielded = false;
  for (let time = 0; time < 30 && !isClearingAtPoint(clearing, goal); time += .025) {
    let others = snapshot(state, world), before = { ...plesk.position };
    advancePleskMind(plesk, world, .025, { rain: 0, dusk: 0, occupants: others });
    safeStep(before, plesk.position, 16, .025, nav, others, "plesk", 36);
    yielded ||= plesk.stage.target.id === "plesk-yield";
    others = snapshot(state, world); before = { ...clearing.position };
    advanceClearingActivity(clearing, .025, { ...conditions, occupants: others });
    safeStep(before, clearing.position, 18, .025, clearing.navigation, others, "mochlik", 50);
  }
  assert.ok(yielded); assert.ok(isClearingAtPoint(clearing, goal)); assert.equal(plesk.catchCount, 2); assert.deepEqual(plesk.queue, queue);
  const aside = { ...plesk.position };
  for (let time = 0; time < 5; time += .025) advancePleskMind(plesk, world, .025, { rain: 0, dusk: 0, occupants: snapshot(state, world) });
  assert.deepEqual(plesk.position, aside, "do not return onto the stationary owner of the goal");
  releaseClearingPoint(clearing);
  assert.equal(requestClearingPoint(clearing, point(80, 190)), true);
  for (let time = 0; time < 40 && (plesk.stage !== originalStage || !isClearingAtPoint(clearing, point(80, 190))); time += .025) {
    let others = snapshot(state, world), before = { ...plesk.position };
    advancePleskMind(plesk, world, .025, { rain: 0, dusk: 0, occupants: others });
    safeStep(before, plesk.position, 16, .025, nav, others, "plesk", 36);
    others = snapshot(state, world); before = { ...clearing.position };
    advanceClearingActivity(clearing, .025, { ...conditions, occupants: others });
    safeStep(before, clearing.position, 18, .025, clearing.navigation, others, "mochlik", 50);
  }
  assert.equal(plesk.stage, originalStage); assert.deepEqual(plesk.position, goal);
  assert.equal(plesk.catchCount, 2); assert.deepEqual(plesk.queue, queue);
});

test("idle Mochlik yields to another resident's approach without inventing a completed activity", () => {
  const world = scene(), clearing = createClearingActivity(world), builder = createBuilderMind(world);
  const state = { clearing, builderMind: builder, pleskMind: null }, goal = { ...clearing.position };
  clearing.waitSeconds = 1000;
  builder.position = point(goal.x + 80, goal.y); builder.target = { id: "test-arrival", position: goal, lookAt: goal };
  builder.route = { points: [{ ...builder.position }, goal], distances: [0, 80], length: 80, speedLimits: [1, 0], roundedCorners: 0, checks: 0 };
  builder.action = "walk";
  let yielded = false;
  for (let time = 0; time < 20 && builder.route; time += .025) {
    let others = snapshot(state, world), before = { ...builder.position };
    advanceBuilderMind(builder, world, .025, { now: 1000, occupants: others });
    safeStep(before, builder.position, 34, .025, builderLocalPlaces(world).navigation, others, "builder", 40);
    others = snapshot(state, world); before = { ...clearing.position };
    advanceClearingActivity(clearing, .025, { ...conditions, occupants: others });
    safeStep(before, clearing.position, 18, .025, clearing.navigation, others, "mochlik", 50);
    yielded ||= clearing.freeRoute?.id === "resident-yield";
  }
  assert.ok(yielded); assert.equal(builder.route, null); assert.ok(distance(builder.position, goal) < .001);
  assert.equal(clearing.behavior.mind.intention, null); assert.deepEqual(clearing.behavior.mind.recent, []);
});

test("reciprocal held goals keep the same queued trade while passing locally", () => {
  const world = scene(); world.destinations[1].position = { ...world.actor.spawn };
  const clearing = createClearingActivity(world), plesk = createPleskMind(world), goal = { ...plesk.position };
  const state = { clearing, builderMind: null, pleskMind: plesk };
  plesk.catchCount = 2; requestPleskTrade(plesk);
  advancePleskMind(plesk, world, 1, { rain: 0, dusk: 0 });
  assert.equal(plesk.stage.action, "walk");
  assert.equal(requestClearingPoint(clearing, goal), true);
  for (let time = 0; time < 45 && (plesk.stage.action !== "trade" || !isClearingAtPoint(clearing, goal)); time += .025) {
    let others = snapshot(state, world), before = { ...plesk.position };
    advancePleskMind(plesk, world, .025, { rain: 0, dusk: 0, occupants: others });
    safeStep(before, plesk.position, 16, .025, pleskLocalPlaces(world).nav, others, "plesk", 36);
    others = snapshot(state, world); before = { ...clearing.position };
    advanceClearingActivity(clearing, .025, { ...conditions, occupants: others });
    safeStep(before, clearing.position, 18, .025, clearing.navigation, others, "mochlik", 50);
  }
  assert.ok(isClearingAtPoint(clearing, goal)); assert.equal(plesk.stage.action, "trade");
  assert.deepEqual(plesk.position, world.destinations[1].position); assert.equal(plesk.catchCount, 2);
});

test("a fixed fish deposit is never interrupted or replayed by an incoming held goal", () => {
  const world = scene(), clearing = createClearingActivity(world), plesk = createPleskMind(world);
  const state = { clearing, builderMind: null, pleskMind: plesk }, feet = { ...plesk.position };
  clearing.position = point(feet.x - 50, feet.y);
  assert.equal(requestClearingPoint(clearing, feet), true);
  plesk.stage = { action: "pack", duration: 2, target: plesk.stage.target, deposit: true, species: "fish" };
  plesk.queue = [{ action: "idle", duration: 20, target: plesk.stage.target }];
  for (let time = 0; time < 1.9; time += .025) {
    advancePleskMind(plesk, world, .025, { rain: 0, dusk: 0, occupants: snapshot(state, world) });
    assert.deepEqual(plesk.position, feet); assert.equal(plesk.catchCount, 0);
  }
  advancePleskMind(plesk, world, .2, { rain: 0, dusk: 0, occupants: snapshot(state, world) });
  assert.equal(plesk.catchCount, 1);
  for (let time = 0; time < 8; time += .025) advancePleskMind(plesk, world, .025, { rain: 0, dusk: 0, occupants: snapshot(state, world) });
  assert.equal(plesk.catchCount, 1); assert.ok(distance(plesk.position, feet) > residentClearance(50, 36));
});
