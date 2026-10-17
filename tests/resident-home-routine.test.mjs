import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestVillagers, configureForestVillagers, advanceForestVillagers, forestVillagerFrames,
  forestVillagerOccupants, requestForestVillagerHome, rehydrateForestVillagers } =
  await vite.ssrLoadModule("/features/world/characters/villagers/villager-mind.ts");
const { forestVillagerPlaces, FOREST_VILLAGER_PROFILES } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-navigation.ts");
const { createBuilderMind, advanceBuilderMind, builderMindFrame, requestBuilderHome, rehydrateBuilderMind } =
  await vite.ssrLoadModule("/features/world/characters/builder/builder-mind.ts");
const { canTraverse, isWalkable } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const levels = { ...initialPreviewLevels(TILED_WORLD), home: 3, quarry: 1, woodlot: 1 };
const scene = previewWorldScene(TILED_WORLD, levels), now = Date.parse("2026-10-17T09:00:00Z");
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const production = id => ({ ownerPublicId: "home-test", revision: 1, jobs: [{ id, stationId: id === "logs" ? "woodlot" : "quarry",
  stationLevel: 1, recipeId: id, startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 600_000).toISOString() }] });
function setup(id) {
  const state = createForestVillagers(scene);
  configureForestVillagers(state, scene, { confirmed: true, buildings: levels, arrivalSeen: true, now });
  for (const [other, mind] of Object.entries(state.residents)) if (other !== id) mind.available = false;
  return state;
}
function tick(state, id, env = {}) {
  const mind = state.residents[id], from = { ...mind.position }, beforeDoor = ["enter", "exit", "inside"].includes(mind.doorPhase) ? mind.door : null;
  advanceForestVillagers(state, state.scene, .1, { now, ...env });
  const door = ["enter", "exit", "inside"].includes(mind.doorPhase) ? mind.door : beforeDoor;
  assert.ok(distance(from, mind.position) <= FOREST_VILLAGER_PROFILES[id].speed * .1 + .001, "one continuous movement budget");
  assert.ok(canTraverse(door?.navigation ?? forestVillagerPlaces(state.scene, id).navigation, from, mind.position), "only a validated personal threshold crosses its own house");
}
function until(state, id, predicate, env = {}, seconds = 120) {
  for (let at = 0; at < seconds && !predicate(state.residents[id]); at += .1) tick(state, id, env);
  assert.ok(predicate(state.residents[id]), `${id} reached requested state, actual ${state.residents[id].doorPhase}/${state.residents[id].action}`);
}

test("the actual rabbit doorway supports a complete finite home break while ordinary navigation keeps its walls", () => {
  const state = setup("lopukh"), mind = state.residents.lopukh, places = forestVillagerPlaces(scene, "lopukh"), source = structuredClone(scene);
  assert.ok(places.door); assert.equal(places.door.id, "lopukh-home");
  assert.equal(isWalkable(places.navigation, places.door.points.at(-1)), false);
  assert.equal(requestForestVillagerHome(state, scene, "lopukh"), true);
  until(state, "lopukh", mind => mind.doorPhase === "inside");
  assert.equal(mind.action, "rest"); assert.equal(mind.doorPurpose, "rest");
  assert.equal(forestVillagerFrames(state).some(frame => frame.id === "lopukh"), false);
  assert.equal(forestVillagerOccupants(state).some(frame => frame.id === "lopukh"), false);
  const insideAt = mind.elapsed, feet = { ...mind.position };
  for (let at = 0; at < 30; at += .1) tick(state, "lopukh");
  assert.deepEqual(mind.position, feet, "home break really spends time indoors");
  until(state, "lopukh", mind => mind.doorPhase === "outside");
  assert.ok(mind.elapsed - insideAt >= 42 && mind.elapsed - insideAt <= 70);
  assert.ok(mind.outdoorUntil >= mind.elapsed + 139);
  assert.deepEqual(scene, source); assert.equal("inventory" in state, false);
});

test("an idle miner rests at his quarry shelter without extracting and then returns to outdoor life", () => {
  const state = setup("kamneshmyg"), mind = state.residents.kamneshmyg;
  mind.outdoorUntil = 0;
  until(state, "kamneshmyg", mind => mind.doorPhase === "inside");
  assert.equal(mind.job, false); assert.equal(mind.doorPurpose, "rest"); assert.equal(mind.action, "rest");
  until(state, "kamneshmyg", mind => mind.doorPhase === "outside");
  const walked = mind.walked;
  for (let at = 0; at < 40; at += .1) { tick(state, "kamneshmyg"); assert.notEqual(mind.action, "work"); }
  assert.ok(mind.walked > walked + 20); assert.equal(state.production, null);
});

for (const phase of ["approach", "enter", "inside"]) test(`confirmed wood production interrupts rabbit home ${phase} from the same feet`, () => {
  const state = setup("lopukh"), mind = state.residents.lopukh;
  assert.equal(requestForestVillagerHome(state, scene, "lopukh"), true);
  until(state, "lopukh", mind => mind.doorPhase === phase);
  const feet = { ...mind.position }, job = production("logs"), saved = structuredClone(job);
  configureForestVillagers(state, scene, { confirmed: true, buildings: levels, production: job, now });
  assert.deepEqual(mind.position, feet); assert.equal(mind.job, true);
  assert.equal(requestForestVillagerHome(state, scene, "lopukh"), false);
  const seen = new Set();
  for (let at = 0; at < 110 && !seen.has("unload"); at += .1) { tick(state, "lopukh"); seen.add(mind.action); }
  assert.ok(seen.has("work")); assert.ok(seen.has("carry")); assert.ok(seen.has("unload"));
  assert.deepEqual(job, saved); assert.equal(mind.doorPhase, "outside");
});

test("a confirmed extraction takes over an already resting miner and its end reverses only the actual crossing", () => {
  const state = setup("kamneshmyg"), mind = state.residents.kamneshmyg;
  assert.equal(requestForestVillagerHome(state, scene, "kamneshmyg"), true);
  until(state, "kamneshmyg", mind => mind.doorPhase === "inside");
  const feet = { ...mind.position }, job = production("stone");
  configureForestVillagers(state, scene, { confirmed: true, buildings: levels, production: job, now });
  assert.deepEqual(mind.position, feet);
  tick(state, "kamneshmyg"); assert.equal(mind.doorPhase, "inside"); assert.equal(mind.action, "work"); assert.equal(mind.doorPurpose, "work");
  configureForestVillagers(state, scene, { confirmed: true, buildings: levels, production: { ...job, revision: 2, jobs: [] }, now });
  assert.deepEqual(mind.position, feet);
  until(state, "kamneshmyg", mind => mind.doorPhase === "outside"); assert.notEqual(mind.action, "work");
});

test("home breaks respect promised conversations, loaded logs and blocked exits", () => {
  const state = setup("lopukh"), mind = state.residents.lopukh;
  mind.outdoorUntil = 0;
  tick(state, "lopukh", { socialHolds: ["lopukh"] }); assert.equal(mind.doorPhase, "outside");
  mind.woodwork.phase = "haul";
  assert.equal(requestForestVillagerHome(state, scene, "lopukh"), false);
  mind.woodwork.phase = "idle";
  assert.equal(requestForestVillagerHome(state, scene, "lopukh"), true);
  until(state, "lopukh", mind => mind.doorPhase === "inside");
  const feet = { ...mind.position }, occupants = [{ id: "blocked-door", position: { ...mind.door.approach.position }, size: 50 }];
  for (let at = 0; at < 90; at += .1) tick(state, "lopukh", { occupants });
  assert.deepEqual(mind.position, feet); assert.equal(mind.doorProgress, 1); assert.equal(mind.trafficWaiting, true);
  assert.equal(forestVillagerFrames(state).some(frame => frame.id === "lopukh"), false);
  until(state, "lopukh", mind => mind.doorPhase === "outside");
});

test("house three unlock and boat completion independently gate the merchant, including geometry handoffs", () => {
  const state = createForestVillagers(scene);
  configureForestVillagers(state, scene, { confirmed: false, buildings: levels, leaftailReady: true, now });
  assert.equal(state.residents.leaftail.available, false);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { ...levels, home: 2 }, leaftailReady: true, now });
  assert.equal(state.residents.leaftail.available, false);
  configureForestVillagers(state, scene, { confirmed: true, buildings: levels, leaftailReady: false, now });
  assert.equal(state.residents.leaftail.available, false);
  const next = rehydrateForestVillagers(structuredClone(scene), state, now);
  assert.equal(next.leaftailReady, false); assert.equal(next.residents.leaftail.available, false);
  configureForestVillagers(next, next.scene, { confirmed: true, buildings: levels, leaftailReady: true, now });
  assert.equal(next.residents.leaftail.available, true);
});

test("paused home clocks, door progress and decorative deliveries survive geometry handoff without sharing mutable state", () => {
  const state = setup("lopukh"), mind = state.residents.lopukh;
  requestForestVillagerHome(state, scene, "lopukh"); until(state, "lopukh", mind => mind.doorPhase === "inside");
  mind.woodwork.lastDelivery = { sequence: 2, position: { x: 944, y: 280 } };
  const saved = structuredClone(state);
  for (let count = 0; count < 100; count++) advanceForestVillagers(state, scene, 0, { now: now + 86_400_000 });
  assert.deepEqual(state, saved);
  const next = rehydrateForestVillagers(structuredClone(scene), state, now);
  assert.deepEqual(next.residents.lopukh.position, mind.position); assert.equal(next.residents.lopukh.wait, mind.wait);
  assert.equal(next.residents.lopukh.doorPurpose, "rest");
  next.residents.lopukh.woodwork.lastDelivery.position.x++;
  assert.deepEqual(state, saved);
});

test("the actual builder takes a finite daytime home break and a construction always wakes him", () => {
  const mind = createBuilderMind(scene), env = { now, night: false, construction: { ownerPublicId: "builder-home", revision: 1, jobs: [] } };
  assert.equal(requestBuilderHome(mind, scene), true);
  for (let at = 0; at < 120 && mind.sleepPhase !== "sleep"; at += .1) {
    const feet = { ...mind.position }; advanceBuilderMind(mind, scene, .1, env);
    assert.ok(distance(feet, mind.position) <= 3.4 + .001);
  }
  assert.equal(mind.sleepPhase, "sleep"); assert.equal(mind.homeReason, "break"); assert.equal(builderMindFrame(mind, scene), null);
  const feet = { ...mind.position }, before = mind.elapsed;
  for (let at = 0; at < 20; at += .1) advanceBuilderMind(mind, scene, .1, env);
  assert.deepEqual(mind.position, feet); assert.equal(mind.sleepPhase, "sleep");
  const next = rehydrateBuilderMind(structuredClone(scene), mind);
  advanceBuilderMind(next, next.scene, 0, env);
  assert.equal(next.homeUntil, mind.homeUntil); assert.equal(next.homeNextAt, mind.homeNextAt); assert.deepEqual(next.position, feet);
  for (let at = 0; at < 60 && next.sleepPhase !== "awake"; at += .1) advanceBuilderMind(next, next.scene, .1, env);
  assert.equal(next.sleepPhase, "awake"); assert.ok(next.elapsed - before >= 30); assert.ok(next.homeNextAt > next.elapsed + 179);
  untilBuilderSleep(mind, env);
  const job = { id: "building", stationId: "home", targetLevel: 4, startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 600_000).toISOString() };
  advanceBuilderMind(mind, scene, 0, { ...env, construction: { ...env.construction, revision: 2, jobs: [job] } });
  assert.equal(mind.sleepPhase, "exit"); assert.deepEqual(mind.position, feet);
});
function untilBuilderSleep(mind, env) {
  assert.equal(mind.sleepPhase, "sleep");
  const saved = structuredClone(mind);
  for (let i = 0; i < 20; i++) advanceBuilderMind(mind, scene, 0, env);
  assert.deepEqual(mind, saved);
}
