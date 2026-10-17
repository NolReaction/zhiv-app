import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestVillagers, configureForestVillagers, advanceForestVillagers, rehydrateForestVillagers,
  requestForestVillagerVisit, requestForestVillagerHome, noticeForestVillager } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-mind.ts");
const { selectVillagerRoute } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-movement.ts");
const { beginWoodcutterCycle } = await vite.ssrLoadModule("/features/world/characters/villagers/woodcutter-cycle.ts");
const { forestVillagerPlaces, FOREST_VILLAGER_PROFILES } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-navigation.ts");
const { canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const scene = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), home: 3, quarry: 1 });
const levels = { home: 3, quarry: 1, woodlot: 1 }, now = Date.parse("2026-10-17T12:00:00Z");
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function setup(id, production = null) {
  const state = createForestVillagers(scene);
  configureForestVillagers(state, scene, { confirmed: true, buildings: levels, arrivalSeen: true, leaftailReady: true, production, now });
  // Visit contracts below use real exterior host coordinates; only the guest
  // is simulated here, while the social director has its own integration tests.
  for (const [other, mind] of Object.entries(state.residents)) if (other !== id) mind.available = false;
  state.residents[id].outdoorUntil = 1e6;
  return state;
}
function step(state, id, env = {}) {
  const mind = state.residents[id], feet = { ...mind.position }, oldDoor = ["enter", "inside", "exit"].includes(mind.doorPhase) ? mind.door : null;
  advanceForestVillagers(state, state.scene, .1, { now, ...env });
  const door = ["enter", "inside", "exit"].includes(mind.doorPhase) ? mind.door : oldDoor;
  assert.ok(distance(feet, mind.position) <= FOREST_VILLAGER_PROFILES[id].speed * .1 + .001, "all transitions preserve the walking speed budget");
  assert.ok(canTraverse(door?.navigation ?? forestVillagerPlaces(state.scene, id).navigation, feet, mind.position), "every step uses ordinary ground or the validated private doorway");
}
function until(state, id, predicate, seconds = 120) {
  for (let at = 0; at < seconds && !predicate(state.residents[id]); at += .1) step(state, id);
  assert.ok(predicate(state.residents[id]), `${id} reached the requested phase`);
}

for (const id of ["lopukh", "kamneshmyg", "leaftail"]) for (const phase of ["approach", "talk"]) for (const geometry of ["same", "copy"]) {
  test(`${id} releases the old ${phase} reservation and its destination during a ${geometry} geometry handoff`, () => {
    const state = setup(id), mind = state.residents[id];
    if (id === "leaftail") { noticeForestVillager(state, id); until(state, id, mind => mind.doorPhase === "outside" && !mind.noticePending); }
    // The trader's bounded invitation uses the nearby northern trail; crossing
    // the whole settlement to the quarry exceeds his voluntary visit budget.
    const host = id === "leaftail" ? { position: { x: 920, y: 300 } }
      : forestVillagerPlaces(scene, id === "kamneshmyg" ? "lopukh" : "kamneshmyg").home;
    assert.equal(requestForestVillagerVisit(state, scene, id, { id: "original-neighbour", position: host.position, size: 42 }), true);
    if (phase === "approach") { for (let at = 0; at < 10; at++) step(state, id); assert.ok(mind.route); }
    else { until(state, id, mind => !mind.route); assert.equal(mind.action, "greet"); }
    const feet = { ...mind.position }, saved = structuredClone(state), nextScene = geometry === "same" ? scene : structuredClone(scene);
    const next = rehydrateForestVillagers(nextScene, state, now), restored = next.residents[id];
    assert.deepEqual(restored.position, feet); assert.equal(restored.socialVisit, null);
    assert.equal(restored.route, null); assert.equal(restored.target, null); assert.equal(restored.goal, null);
    assert.equal(restored.intent, "wander"); assert.equal(restored.action, "idle");
    for (let at = 0; at < 15; at++) { step(next, id); assert.deepEqual(restored.position, feet, "the cancelled promise cannot resume as an orphan route"); }
    assert.deepEqual(state, saved, "the new owner never changes the old reservation or feet");
  });
}

test("ordinary retained goals, a carried log and active private doorway/work survive the same geometry handoff", () => {
  const strolling = setup("kamneshmyg"), miner = strolling.residents.kamneshmyg, places = forestVillagerPlaces(scene, miner.id);
  const destination = places.wander.find(stop => stop.id.includes("neighbourhood") && distance(stop.position, miner.position) > 30);
  assert.ok(destination); assert.equal(selectVillagerRoute(miner, places, [destination], "wander", "inspect"), true);
  step(strolling, miner.id);
  let next = rehydrateForestVillagers(structuredClone(scene), strolling, now), restored = next.residents.kamneshmyg;
  assert.deepEqual(restored.position, miner.position); assert.equal(restored.goal.target.id, destination.id); assert.ok(restored.route);
  step(next, miner.id);

  const carrying = setup("lopukh"), rabbit = carrying.residents.lopukh;
  assert.equal(beginWoodcutterCycle(rabbit, forestVillagerPlaces(scene, rabbit.id), undefined, { chopSeconds: 0 }), true);
  until(carrying, rabbit.id, mind => mind.woodwork.phase === "haul" && Boolean(mind.route));
  next = rehydrateForestVillagers(structuredClone(scene), carrying, now); restored = next.residents.lopukh;
  assert.deepEqual(restored.position, rabbit.position); assert.equal(restored.woodwork.phase, "haul"); assert.equal(restored.action, "carry"); assert.ok(restored.route);
  step(next, rabbit.id);

  const resting = setup("lopukh");
  assert.equal(requestForestVillagerHome(resting, scene, "lopukh"), true);
  until(resting, "lopukh", mind => mind.doorPhase === "enter" && mind.doorProgress > .1 && mind.doorProgress < .9);
  next = rehydrateForestVillagers(structuredClone(scene), resting, now); restored = next.residents.lopukh;
  assert.deepEqual(restored.position, resting.residents.lopukh.position); assert.equal(restored.doorPhase, "enter");
  assert.equal(restored.doorProgress, resting.residents.lopukh.doorProgress); step(next, "lopukh");

  const production = jobs("quarry"), working = setup("kamneshmyg", production);
  until(working, "kamneshmyg", mind => mind.doorPhase === "inside");
  next = rehydrateForestVillagers(structuredClone(scene), working, now); restored = next.residents.kamneshmyg;
  assert.deepEqual(restored.position, working.residents.kamneshmyg.position); assert.equal(restored.doorPhase, "inside");
  assert.equal(restored.job, true); assert.equal(restored.action, "work"); assert.deepEqual(next.production, production);
});

function jobs(stationId) {
  return { ownerPublicId: "transition-owner", revision: 1, jobs: [{ id: stationId, stationId, stationLevel: 1,
    startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 600_000).toISOString() }] };
}
function inspectWoodpile() {
  const state = setup("lopukh"), mind = state.residents.lopukh; mind.habitAfter = 0;
  assert.equal(beginWoodcutterCycle(mind, forestVillagerPlaces(scene, mind.id)), true);
  until(state, mind.id, mind => mind.habit?.kind === "woodpile" && mind.habit.phase === "inspect");
  assert.equal(mind.checkedDelivery, 0); assert.equal(mind.habitCycles, 0);
  return state;
}
test("a tap interrupts the woodpile inspection without claiming success, and the next quiet opportunity can finish it", () => {
  const state = inspectWoodpile(), mind = state.residents.lopukh, feet = { ...mind.position }, delivery = structuredClone(mind.woodwork.lastDelivery);
  const quietUntil = mind.habitAfter;
  noticeForestVillager(state, mind.id); step(state, mind.id);
  assert.deepEqual(mind.position, feet); assert.equal(mind.action, "greet"); assert.equal(mind.habit, null);
  assert.equal(mind.checkedDelivery, 0); assert.equal(mind.habitCycles, 0); assert.equal(mind.habitAfter, quietUntil);
  until(state, mind.id, mind => mind.habit?.kind === "woodpile" && mind.habit.phase === "inspect");
  assert.ok(mind.elapsed >= quietUntil); assert.equal(mind.checkedDelivery, 0); assert.deepEqual(mind.woodwork.lastDelivery, delivery);
  until(state, mind.id, mind => mind.habitCycles === 1);
  assert.equal(mind.checkedDelivery, delivery.sequence); assert.ok(mind.habitAfter >= mind.elapsed + 32);
});
test("confirmed work interrupts an unfinished woodpile inspection without granting its result", () => {
  const state = inspectWoodpile(), mind = state.residents.lopukh, feet = { ...mind.position }, delivery = structuredClone(mind.woodwork.lastDelivery);
  configureForestVillagers(state, scene, { confirmed: true, buildings: levels, production: jobs("woodlot"), now });
  assert.deepEqual(mind.position, feet); assert.equal(mind.job, true); assert.equal(mind.habit, null);
  assert.equal(mind.checkedDelivery, 0); assert.equal(mind.habitCycles, 0); assert.deepEqual(mind.woodwork.lastDelivery, delivery);
  step(state, mind.id); assert.ok(["work", "walk"].includes(mind.action));
});
