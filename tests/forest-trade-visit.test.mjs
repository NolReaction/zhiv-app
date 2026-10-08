import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { requestForestTradeVisit, advanceForestDirector, forestTradeVisitFrame, noticeForestDirector, cancelForestDirector } =
  await vite.ssrLoadModule("/features/world/simulation/forest-director.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { requestClearingPoint } = await vite.ssrLoadModule("/features/world/simulation/clearing-activity.ts");
const { isWalkable, canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { requestPleskTrade, advancePleskMind } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-mind.ts");
const { syncForestJourneyTravel } = await vite.ssrLoadModule("/features/world/activities/journeys/forest-journey-travel.ts");
const rectangle = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const point = { x: 240, y: 220 }, vendor = { x: 240, y: 145 };
const fixture = {
  schemaVersion: 1, id: "trade-visit-fixture", width: 360, height: 300, terrain: [],
  focus: { x: 0, y: 0, width: 360, height: 300 }, actor: { spawn: { x: 70, y: 200 }, size: 24 },
  sites: [{ id: "plesk-shop", label: "Лавка Плёски", initialLevel: 1, states: [],
    bounds: { x: 220, y: 160, width: 40, height: 32 }, anchor: { x: 240, y: 192 }, entry: point,
    hitArea: rectangle(220, 160, 40, 32), collision: rectangle(220, 160, 40, 32) }],
  destinations: [{ id: "plesk-customer", siteId: "plesk-shop", position: point, pauseSeconds: 5 },
    { id: "plesk-trade", position: vendor, pauseSeconds: 5 }],
  paths: [], water: { surfaces: [], exclusions: [] },
  navigation: { version: 1, cellSize: 8, areas: [{ id: "clearing", points: rectangle(10, 10, 340, 280) }],
    obstacles: [{ id: "rock", points: rectangle(160, 100, 20, 120) }], interests: [] },
};
const calm = { autoLife: false, blocked: false, dusk: 0, rain: 0, homeAvailable: false };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function create(scene = structuredClone(fixture)) {
  const session = connectForestSession(undefined, scene, "world", 0, 0, () => {});
  session.release();
  return { state: session.state, scene };
}
function seller(state, position = vendor, action = "trade") {
  state.pleskMind = { available: true, position: { ...position }, stage: { action }, scene: fixture };
}
function advance(state, seconds, options = calm, inspect = () => {}) {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += .05) {
    const previous = { ...state.clearing.position };
    advanceForestDirector(state, .05, options);
    assert.ok(distance(previous, state.clearing.position) < 2, "walking never teleports");
    assert.ok(isWalkable(state.clearing.navigation, state.clearing.position), "feet remain on safe ground");
    assert.ok(canTraverse(state.clearing.navigation, previous, state.clearing.position), "walking never crosses the stall or rocks");
    inspect(state);
  }
}
function until(state, predicate, seconds = 90, options = calm) {
  for (let elapsed = 0; elapsed < seconds && !predicate(); elapsed += .05) advance(state, .05, options);
  assert.ok(predicate(), `condition not reached: ${state.director.reason}, ${state.clearing.stage}`);
}

test("shop visit walks around obstacles, greets the actual seller once, and returns even with automatic life off", () => {
  const { state, scene } = create(); seller(state);
  const home = { ...state.clearing.home };
  assert.equal(requestForestTradeVisit(state, scene, calm), true);
  assert.equal(requestForestTradeVisit(state, scene, calm), false, "repeated taps cannot restart or extend the visit");
  assert.equal(forestTradeVisitFrame(state), null, "no greeting while walking");
  until(state, () => state.director.tradeVisit?.phase === "visiting");
  assert.deepEqual(state.clearing.position, point);
  assert.equal(forestTradeVisitFrame(state).pose, "greet");
  assert.equal(forestTradeVisitFrame(state).direction, "back");
  advance(state, 2);
  assert.equal(forestTradeVisitFrame(state).pose, "idle");
  until(state, () => state.director.tradeVisit === null);
  assert.ok(distance(state.clearing.position, home) <= .5);
  assert.equal(state.clearing.requestedPoint, null);
  assert.equal(state.director.activeKey, null);
  assert.ok(state.clearing.behavior.mind.recent.some(item => item.key === "trade:plesk-shop" && item.outcome === "completed"));
  assert.equal(state.journeyTravel, undefined); assert.equal(state.explorationId, undefined);
});

test("the customer waits for the real seller without greeting an empty counter, then leaves within a bounded time", () => {
  const { state, scene } = create();
  assert.equal(requestForestTradeVisit(state, scene, calm), true);
  until(state, () => state.director.tradeVisit?.phase === "waiting");
  assert.equal(forestTradeVisitFrame(state).pose, "idle");
  seller(state, { x: 100, y: 100 }); advance(state, 4);
  assert.equal(state.director.tradeVisit.phase, "waiting");
  seller(state, vendor, "walk"); advance(state, 1);
  assert.equal(state.director.tradeVisit.phase, "waiting", "walking past the marker is not a greeting");
  until(state, () => state.director.tradeVisit?.phase === "returning", 46);
  until(state, () => state.director.tradeVisit === null);
  assert.ok(distance(state.clearing.position, state.clearing.home) <= .5);
});

test("late seller arrival starts the same ten-second meeting without resetting the walk", () => {
  const { state, scene } = create(); requestForestTradeVisit(state, scene, calm);
  until(state, () => state.director.tradeVisit?.phase === "waiting");
  advance(state, 10); seller(state); advance(state, .05);
  assert.equal(state.director.tradeVisit.phase, "visiting");
  assert.equal(forestTradeVisitFrame(state).pose, "greet");
  advance(state, 10.1); assert.equal(state.director.tradeVisit.phase, "returning");
});

test("economic tasks, held props and other interactions keep ownership when the shop opens", () => {
  const busy = [
    state => { state.explorationId = "real-job"; },
    state => { state.journeyTravel = { phase: "fishing" }; },
    state => { state.cookingPreview = { startedAt: null }; },
    state => { state.life.routine = { kind: "mushroom", picked: true, elapsed: 2 }; },
    state => { state.life.garden.routine = { kind: "harvest-berries" }; },
    state => { state.life.garden.basket = { held: true }; },
    state => { state.fauna.encounter = { kind: "butterfly" }; },
    state => { state.pendingLife = "campfire"; },
    state => { state.pendingAttention = true; },
    state => { state.clearing.stage = "home-sleep"; },
    state => { state.clearing.stage = "bush-enter"; },
    state => { requestClearingPoint(state.clearing, { x: 100, y: 100 }); },
  ];
  for (const mutate of busy) {
    const { state, scene } = create(); mutate(state);
    const before = structuredClone({ director: state.director, pendingLife: state.pendingLife,
      point: state.clearing.requestedPoint, position: state.clearing.position, stage: state.clearing.stage });
    assert.equal(requestForestTradeVisit(state, scene, calm), false);
    assert.deepEqual({ director: state.director, pendingLife: state.pendingLife,
      point: state.clearing.requestedPoint, position: state.clearing.position, stage: state.clearing.stage }, before);
  }
  for (const options of [{ blocked: true }, { actorAway: true }, { explicitTravel: true }, { reducedMotion: true }, { navigationMode: "routes" }]) {
    const { state, scene } = create();
    assert.equal(requestForestTradeVisit(state, scene, { ...calm, ...options }), false);
    assert.equal(state.director.tradeVisit, null); assert.equal(state.clearing.requestedPoint, null);
  }
});

test("missing or unreachable markers do not move the hero", () => {
  for (const change of [
    scene => { scene.destinations = []; },
    scene => { scene.destinations[0].position = { x: 500, y: 500 }; },
    scene => { scene.destinations[0].position = { x: 240, y: 170 }; },
    scene => { scene.sites = []; },
  ]) {
    const scene = structuredClone(fixture); change(scene);
    const { state } = create(scene), original = { ...state.clearing.position };
    assert.equal(requestForestTradeVisit(state, scene, calm), false);
    assert.deepEqual(state.clearing.position, original); assert.equal(state.clearing.requestedPoint, null);
  }
});

test("cancellation, attention and reduced motion release only the cosmetic visit", () => {
  for (const cancel of [state => cancelForestDirector(state), state => noticeForestDirector(state),
    state => advanceForestDirector(state, .05, { ...calm, reducedMotion: true })]) {
    const { state, scene } = create(); requestForestTradeVisit(state, scene, calm); advance(state, 1);
    const previous = { ...state.clearing.position }; cancel(state);
    assert.equal(state.director.tradeVisit, null); assert.equal(state.clearing.requestedPoint, null);
    assert.deepEqual(state.clearing.position, previous);
    assert.equal(forestTradeVisitFrame(state), null);
  }
  const { state, scene } = create(); requestForestTradeVisit(state, scene, calm); advance(state, 1);
  const newTarget = { x: 100, y: 80 };
  assert.equal(requestClearingPoint(state.clearing, newTarget), true);
  advanceForestDirector(state, .05, { ...calm, explicitTravel: true, blocked: true });
  assert.equal(state.director.tradeVisit, null);
  assert.deepEqual(state.clearing.requestedPoint, newTarget, "a new economic departure keeps its own destination");
});

test("the authored stall supports a complete meeting and return with both real character clocks", async () => {
  const scene = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  for (const step of [.025, .1]) {
    const { state } = create(scene), home = { ...state.clearing.home };
    assert.ok(state.pleskMind);
    requestPleskTrade(state.pleskMind);
    assert.equal(requestForestTradeVisit(state, scene, calm), true);
    let greeted = false, previous = { ...home }, longestLeg = 0;
    for (let elapsed = 0; elapsed < 280 && state.director.tradeVisit; elapsed += step) {
      advancePleskMind(state.pleskMind, scene, step, { rain: 0, dusk: 0 });
      advanceForestDirector(state, step, calm);
      const visit = state.director.tradeVisit;
      if (visit?.phase === "outbound" || visit?.phase === "returning") longestLeg = Math.max(longestLeg, visit.phaseElapsed);
      greeted ||= forestTradeVisitFrame(state)?.pose === "greet";
      assert.ok(distance(previous, state.clearing.position) <= state.clearing.size * .36 * step + .01);
      assert.ok(canTraverse(state.clearing.navigation, previous, state.clearing.position));
      previous = { ...state.clearing.position };
    }
    assert.ok(greeted, "the customer actually meets Pleska at the placed stall");
    assert.equal(state.director.tradeVisit, null);
    assert.ok(longestLeg < 120, "both authored walking legs finish before the watchdog");
    assert.ok(distance(state.clearing.position, home) <= .5);
    assert.equal(state.clearing.requestedPoint, null);
    assert.ok(state.clearing.behavior.mind.recent.some(item => item.key === "trade:plesk-shop" && item.outcome === "completed"));
  }
});

test("server-confirmed fishing and mine jobs take over each visit phase through the real journey synchronizer", async () => {
  const scene = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const now = 1_000_000;
  for (const phase of ["outbound", "waiting", "returning"]) for (const routeId of ["shore", "cave"]) {
    const { state } = create(scene);
    syncForestJourneyTravel(state, scene, null, now, false);
    assert.equal(requestForestTradeVisit(state, scene, calm), true);
    until(state, () => state.director.tradeVisit?.phase === phase, 170);
    const previous = { ...state.clearing.position };
    const job = { id: `confirmed-${phase}-${routeId}`, routeId, label: "Вылазка",
      startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 600_000).toISOString(),
      rewards: routeId === "shore" ? { fish: 4 } : { stone: 5 } };
    const snapshot = structuredClone(job);
    syncForestJourneyTravel(state, scene, job, now, false);
    assert.equal(state.director.tradeVisit, null);
    assert.equal(state.journeyTravel?.jobId, job.id);
    assert.equal(state.journeyTravel.phase, "leaving");
    assert.deepEqual(state.clearing.position, previous, "new work starts from the actual feet");
    const jobPoint = { ...state.clearing.requestedPoint };
    assert.ok(Number.isFinite(jobPoint.x));
    advanceForestDirector(state, .05, { ...calm, blocked: true, explicitTravel: true });
    assert.deepEqual(state.clearing.requestedPoint, jobPoint);
    assert.equal(state.journeyTravel.jobId, job.id);
    assert.deepEqual(job, snapshot, "cosmetic travel does not change authoritative job rewards");
  }
});
