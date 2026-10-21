import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestVillagers, configureForestVillagers, advanceForestVillagers, rehydrateForestVillagers,
  requestForestVillagerVisit } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-mind.ts");
const { selectVillagerRoute } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-movement.ts");
const { forestVillagerPlaces, FOREST_VILLAGER_PROFILES } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-navigation.ts");
const { beginWoodcutterCycle } = await vite.ssrLoadModule("/features/world/characters/villagers/woodcutter-cycle.ts");
const { canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { canTraverseResidents } = await vite.ssrLoadModule("/features/world/navigation/resident-traffic.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const now = Date.parse("2026-10-17T12:00:00Z"), distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const actual = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), home: 3, quarry: 1, woodlot: 1 });
function corridor() {
  return { schemaVersion: 1, id: "steady-villager", width: 600, height: 200, terrain: [], paths: [],
    focus: { x: 0, y: 0, width: 600, height: 200 }, actor: { spawn: { x: 80, y: 120 }, size: 40 },
    sites: [{ id: "quarry", initialLevel: 1, label: "quarry", anchor: { x: 100, y: 75 }, entry: { x: 100, y: 100 },
      doorway: { x: 100, y: 75 }, bounds: { x: 65, y: 40, width: 70, height: 45 }, hitArea: rect(65, 40, 70, 45),
      collision: rect(70, 50, 60, 35), states: [{ level: 1, image: "/quarry.png" }] }],
    navigation: { version: 1, cellSize: 5, areas: [{ id: "west", points: rect(30, 70, 130, 65) },
      { id: "corridor", points: rect(150, 90, 300, 20) }, { id: "east", points: rect(440, 70, 130, 65) }], obstacles: [], interests: [] },
    water: { surfaces: [], exclusions: [] } };
}
function setup(id, scene = actual, production = null) {
  const state = createForestVillagers(scene);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1, woodlot: 1 }, arrivalSeen: true, lopukhArrivalSeen: true,
    leaftailReady: true, production, now });
  for (const [other, mind] of Object.entries(state.residents)) if (other !== id) mind.available = false;
  return state;
}
function step(state, id, env = {}) {
  const mind = state.residents[id], previous = { ...mind.position }, previousDoor = ["enter", "inside", "exit"].includes(mind.doorPhase) ? mind.door : null;
  advanceForestVillagers(state, state.scene, .1, { now, ...env });
  const door = ["enter", "inside", "exit"].includes(mind.doorPhase) ? mind.door : previousDoor;
  assert.ok(distance(previous, mind.position) <= FOREST_VILLAGER_PROFILES[id].speed * .1 + .001, "intent changes never teleport feet");
  assert.ok(canTraverse(door?.navigation ?? forestVillagerPlaces(state.scene, id).navigation, previous, mind.position), "all real steps respect static geometry");
  assert.ok(canTraverseResidents(previous, mind.position, FOREST_VILLAGER_PROFILES[id].size, env.occupants ?? [], id), "temporary neighbours retain their space");
}
function until(state, id, predicate, env = {}, seconds = 120) {
  for (let time = 0; time < seconds && !predicate(state.residents[id]); time += .1) step(state, id, env);
  assert.ok(predicate(state.residents[id]), `state reached: ${id} ${state.residents[id].action}/${state.residents[id].goal?.phase}/${state.residents[id].habit?.kind}`);
}
function stroll() {
  const state = setup("kamneshmyg", corridor()), mind = state.residents.kamneshmyg;
  mind.position = { x: 100, y: 110 }; mind.outdoorUntil = 1e6; mind.habitAfter = 1e6; mind.wait = 1e6;
  const target = { id: "chosen-east", position: { x: 500, y: 110 }, lookAt: { x: 520, y: 100 } };
  assert.equal(selectVillagerRoute(mind, forestVillagerPlaces(state.scene, mind.id), [target], "wander", "inspect"), true);
  return { state, mind, target };
}
const blocker = { id: "stationary-neighbour", position: { x: 250, y: 100 }, size: 70, moving: false };

test("a short obstruction retains one voluntary destination and resumes the same walk after a bounded wait", () => {
  const { state, mind, target } = stroll();
  until(state, mind.id, mind => mind.goal?.phase === "waiting", { occupants: [blocker] });
  const goal = mind.goal, feet = { ...mind.position };
  assert.equal(goal.target.id, target.id); assert.equal(goal.retries, 0); assert.equal(mind.route, null);
  for (let time = 0; time < .6; time += .1) { step(state, mind.id, { occupants: [blocker] }); assert.deepEqual(mind.position, feet); }
  assert.equal(mind.goal, goal, "a patience interval does not replace the intention object");
  until(state, mind.id, mind => !mind.goal && distance(mind.position, target.position) < .1);
  assert.equal(mind.target.id, target.id); assert.equal(mind.failedStops.length, 0); assert.ok(mind.decisions <= 2);
});

test("a permanent obstruction gets two slow retries and a target cooldown instead of endless route churn", () => {
  const { state, mind, target } = stroll();
  until(state, mind.id, mind => mind.failedStops.some(stop => stop.id === target.id), { occupants: [blocker] });
  assert.equal(mind.goal, null); assert.equal(mind.route, null); assert.equal(mind.decisions, 3);
  const failure = mind.failedStops.find(stop => stop.id === target.id), places = forestVillagerPlaces(state.scene, mind.id);
  assert.ok(failure.until >= mind.elapsed + 35); const decisions = mind.decisions;
  for (let pass = 0; pass < 40; pass++) assert.equal(selectVillagerRoute(mind, places, [target], "wander", "inspect"), false);
  assert.equal(mind.decisions, decisions, "cooled destinations never perform per-frame path searches");
  mind.wait = 1e6;
  while (mind.elapsed < failure.until + .1) step(state, mind.id);
  assert.equal(selectVillagerRoute(mind, places, [target], "wander", "inspect"), true, "active time eventually releases the failed destination");
});

test("a newly due home timer cannot replace a calm active intention, while real weather can shelter the resident", () => {
  const { state, mind, target } = stroll(); mind.outdoorUntil = 0;
  for (let pass = 0; pass < 15; pass++) { step(state, mind.id); assert.equal(mind.goal.target.id, target.id); assert.equal(mind.doorPhase, "outside"); }
  step(state, mind.id, { rain: .7 });
  assert.equal(mind.goal, null); assert.ok(["approach", "enter", "inside"].includes(mind.doorPhase));
});

test("work and social requests own their usual priority over a retained leisure goal", () => {
  const { state, mind } = stroll(), feet = { ...mind.position };
  assert.equal(requestForestVillagerVisit(state, state.scene, mind.id, { id: "friend", position: { x: 120, y: 110 }, size: 40 }), true);
  assert.equal(mind.goal, null); assert.equal(mind.socialVisit.targetId, "friend"); assert.deepEqual(mind.position, feet);
  const production = { ownerPublicId: "intent-owner", revision: 1, jobs: [{ id: "stone", stationId: "quarry", stationLevel: 1,
    startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 60_000).toISOString() }] };
  configureForestVillagers(state, state.scene, { confirmed: true, buildings: { home: 3, quarry: 1 }, production, now });
  assert.equal(mind.job, true); assert.equal(mind.socialVisit, null); assert.equal(mind.goal, null); assert.equal(mind.habit, null);
  assert.deepEqual(mind.position, feet);
});

test("a social approach cannot accept a reachable foot stop on the other side of the host's wall", () => {
  const scene = corridor(); scene.navigation.obstacles.push({ id: "closed-partition", points: rect(115, 50, 8, 100) });
  const state = setup("kamneshmyg", scene), mind = state.residents.kamneshmyg;
  mind.position = { x: 500, y: 110 }; mind.outdoorUntil = 1e6;
  assert.equal(selectVillagerRoute(mind, forestVillagerPlaces(scene, mind.id), [
    { id: "current-free-stroll", position: { x: 530, y: 110 }, lookAt: { x: 550, y: 100 } },
  ], "wander", "inspect"), true);
  const route = mind.route, goal = mind.goal, feet = { ...mind.position };
  assert.equal(requestForestVillagerVisit(state, scene, mind.id, { id: "behind-wall", position: { x: 100, y: 100 }, size: 42 }), false);
  assert.equal(mind.socialVisit, null); assert.equal(mind.route, route); assert.equal(mind.goal, goal); assert.deepEqual(mind.position, feet);
});

test("paused goals and geometry handoffs preserve clocks while cloning each mutable goal, habit and failed-stop record", () => {
  const { state, mind } = stroll();
  until(state, mind.id, mind => mind.goal?.phase === "waiting", { occupants: [blocker] });
  mind.failedStops.push({ id: "earlier-choice", until: mind.elapsed + 40 });
  mind.habit = { kind: "post-work-walk", phase: "walk", until: 0 };
  const saved = structuredClone(state);
  for (let count = 0; count < 30; count++) advanceForestVillagers(state, state.scene, 0, { now });
  assert.deepEqual(state, saved);
  const next = rehydrateForestVillagers(structuredClone(state.scene), state, now), clone = next.residents[mind.id];
  assert.deepEqual(clone.position, mind.position); assert.equal(clone.elapsed, mind.elapsed); assert.equal(clone.goal.startedAt, mind.goal.startedAt);
  clone.goal.target.position.x++; clone.goal.target.lookAt.y++; clone.failedStops[0].until++; clone.habit.until++;
  assert.deepEqual(state, saved, "a second scene owner cannot mutate an old goal or cooldown");
});

test("the rabbit checks a real completed wood delivery once, then has a more sociable quiet interval", () => {
  const state = setup("lopukh"), mind = state.residents.lopukh, places = forestVillagerPlaces(actual, mind.id);
  mind.outdoorUntil = 1e6; mind.habitAfter = 0;
  assert.equal(mind.woodwork.lastDelivery, undefined);
  assert.equal(beginWoodcutterCycle(mind, places, undefined, { chopSeconds: 0 }), true);
  until(state, mind.id, mind => mind.habit?.kind === "woodpile" && mind.habit.phase === "inspect");
  const delivery = structuredClone(mind.woodwork.lastDelivery), duration = mind.habit.until - mind.elapsed, social = mind.socialNeed;
  assert.ok(mind.checkedDelivery < delivery.sequence, "arriving starts the inspection without claiming it finished");
  assert.deepEqual(mind.target.lookAt, delivery.position);
  assert.ok(duration >= 3 && duration <= 7);
  until(state, mind.id, mind => mind.habitCycles === 1);
  assert.equal(mind.checkedDelivery, delivery.sequence);
  assert.ok(mind.socialNeed > social + .19); assert.deepEqual(mind.woodwork.lastDelivery, delivery);
  assert.ok(mind.habitAfter > mind.elapsed + 30); assert.equal(state.production, null); assert.equal("inventory" in state, false);
  mind.wait = 1e6;
  for (let pass = 0; pass < 100; pass++) step(state, mind.id);
  assert.equal(mind.habitCycles, 1, "the same completed delivery cannot be inspected every frame");
});

test("the trader physically inspects an exterior shop stop, then leaves a varied quiet interval", () => {
  const state = setup("leaftail"), mind = state.residents.leaftail, places = forestVillagerPlaces(actual, mind.id);
  until(state, mind.id, mind => mind.habit?.kind === "shop-inspection" && mind.habit.phase === "inspect");
  assert.ok(places.work.some(stop => stop.id === mind.target.id)); assert.equal(mind.doorPhase, "outside");
  assert.ok(distance(mind.position, mind.target.position) < .1); assert.ok(mind.habit.until > mind.elapsed + 2.9);
  until(state, mind.id, mind => mind.habitCycles === 1);
  assert.ok(mind.habitAfter >= mind.elapsed + 48); assert.equal(state.production, null);
});

test("an expired confirmed mining job arms one post-shift walk, while cancellation never claims that completion", () => {
  const production = { ownerPublicId: "intent-owner", revision: 1, jobs: [{ id: "stone", stationId: "quarry", stationLevel: 1,
    startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 60_000).toISOString() }] };
  const state = setup("kamneshmyg", actual, production), mind = state.residents.kamneshmyg;
  until(state, mind.id, mind => mind.doorPhase === "inside");
  advanceForestVillagers(state, actual, 0, { now: now + 60_001 });
  assert.equal(mind.postWorkWalk, true); assert.equal(mind.job, false);
  until(state, mind.id, mind => mind.habit?.kind === "post-work-walk" && mind.habit.phase === "inspect", { now: now + 60_001 });
  assert.match(mind.target.id, /neighbourhood/); assert.equal(mind.postWorkWalk, false); assert.notEqual(mind.action, "work");
  until(state, mind.id, mind => mind.habitCycles === 1, { now: now + 60_001 });
  const cancelled = setup("kamneshmyg", actual, production);
  until(cancelled, mind.id, mind => mind.doorPhase === "inside");
  configureForestVillagers(cancelled, actual, { confirmed: true, buildings: { home: 3, quarry: 1 }, production: { ...production, revision: 2, jobs: [] }, now });
  assert.equal(cancelled.residents.kamneshmyg.postWorkWalk, false);
  until(cancelled, mind.id, mind => mind.doorPhase === "outside");
  for (let pass = 0; pass < 120; pass++) { step(cancelled, mind.id); assert.notEqual(cancelled.residents.kamneshmyg.habit?.kind, "post-work-walk"); }
});
