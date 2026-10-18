import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const load = path => vite.ssrLoadModule(`/features/world/${path}.ts`);
const { residentSceneSocialContext, residentSceneFollowups } = await load("scene/resident-scene-social");
const { createForestSocial } = await load("characters/social/forest-social");
const { createBuilderMind, advanceBuilderMind } = await load("characters/builder/builder-mind");
const { createForestVillagers, configureForestVillagers, advanceForestVillagers } = await load("characters/villagers/villager-mind");
const { forestVillagerPlaces } = await load("characters/villagers/villager-navigation");
const { forestLeaftailWindow } = await load("characters/social/forest-leaftail-window");
const { createWorldNavigation, canTraverse, isWalkable } = await load("navigation/navigation");
const { TILED_WORLD } = await load("scene/presentation");
const { previewWorldScene, initialPreviewLevels } = await load("tiled/preview-state");
const now = Date.parse("2026-10-17T09:00:00Z");
const levels = { ...initialPreviewLevels(TILED_WORLD), home: 3, quarry: 1, woodlot: 1 };
const scene = previewWorldScene(TILED_WORLD, levels);
const access = (revision = 1, buildings = levels, jobs = [], owner = "social-owner") => ({ ownerPublicId: owner, revision,
  buildings: { ...buildings }, production: { ownerPublicId: owner, revision, jobs } });
const job = (id, stationId = "quarry", finish = now + 1000) => ({ id, stationId, stationLevel: 1, recipeId: id,
  startedAt: new Date(now - 500).toISOString(), finishesAt: new Date(finish).toISOString() });
function factsState() {
  return { social: createForestSocial("scene-facts"), pleskMind: { catchCount: 4 },
    villagers: { residents: { lopukh: { woodwork: { completedCycles: 3 } } } }, economyResidents: access() };
}
function routeState() {
  const state = { social: createForestSocial("scene-routes"), builderMind: createBuilderMind(scene),
    villagers: createForestVillagers(scene), economyResidents: access() };
  configureForestVillagers(state.villagers, scene, { confirmed: true, buildings: levels, arrivalSeen: true, leaftailReady: true, now });
  return state;
}

test("a first confirmed snapshot establishes facts without claiming loaded buildings, ready jobs or old catches", () => {
  const state = factsState(); state.economyResidents = access(50, levels, [job("already-finished", "quarry", now - 1000)]);
  const before = structuredClone(state.economyResidents);
  assert.deepEqual(residentSceneSocialContext(state, now).events, []);
  for (let camera = 0; camera < 6; camera++) assert.deepEqual(residentSceneSocialContext(state, now).events, []);
  assert.deepEqual(state.economyResidents, before, "social facts never mutate the confirmed economy");
});

test("new confirmed building levels and actual catch/delivery transitions each produce one bounded fact", () => {
  const state = factsState(); residentSceneSocialContext(state, now);
  state.economyResidents = access(2, { ...levels, workshop: (levels.workshop ?? 0) + 1 });
  let events = residentSceneSocialContext(state, now).events;
  assert.equal(events.length, 1); assert.equal(events[0].kind, "construction"); assert.equal(events[0].siteId, "workshop");
  state.pleskMind.catchCount++; state.villagers.residents.lopukh.woodwork.completedCycles++;
  events = residentSceneSocialContext(state, now).events;
  assert.deepEqual(events.map(item => item.kind), ["construction", "fishing", "wood"]);
  const ids = events.map(item => item.id); assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(residentSceneSocialContext(state, now).events.map(item => item.id), ids, "the other camera cannot duplicate an event");
  for (let at = 0; at < 30; at++) { state.pleskMind.catchCount++; residentSceneSocialContext(state, now); }
  assert.equal(state.residentSceneFacts.events.length, 8);
  assert.deepEqual(Object.keys(state).filter(key => /reward|wallet|inventory/i.test(key)), []);
});

test("only an observed still-confirmed production job reaching its finish produces one completed-work fact", () => {
  const state = factsState(), mining = job("observed-job"); state.economyResidents = access(1, levels, [mining]);
  assert.deepEqual(residentSceneSocialContext(state, now).events, []);
  assert.deepEqual(residentSceneSocialContext(state, now + 999).events, []);
  const events = residentSceneSocialContext(state, now + 1000).events;
  assert.equal(events.length, 1); assert.deepEqual(events[0], { id: "work:observed-job", kind: "mining", speaker: "kamneshmyg" });
  assert.deepEqual(residentSceneSocialContext(state, now + 2000).events, events);
  assert.equal(state.residentSceneFacts.jobs.size, 0);
});

test("a removed job is not called completed merely because a later frame crossed its old deadline", () => {
  const state = factsState(); state.economyResidents = access(1, levels, [job("withdrawn-job")]);
  residentSceneSocialContext(state, now); assert.equal(state.residentSceneFacts.jobs.size, 1);
  state.economyResidents = access(2, levels, []);
  assert.deepEqual(residentSceneSocialContext(state, now + 2000).events, [], "a cancelled/withdrawn job must disappear before deadline inference");
  assert.equal(state.residentSceneFacts.jobs.size, 0);
});

test("account replacement rebaselines loaded counters and cannot inherit facts or production from another owner", () => {
  const state = factsState(); residentSceneSocialContext(state, now);
  state.pleskMind.catchCount++; residentSceneSocialContext(state, now); assert.equal(state.residentSceneFacts.events.length, 1);
  state.economyResidents = access(500, { ...levels, home: 5 }, [job("other-old-ready", "woodlot", now - 1000)], "another-owner");
  state.pleskMind.catchCount = 48; state.villagers.residents.lopukh.woodwork.completedCycles = 31;
  assert.deepEqual(residentSceneSocialContext(state, now).events, [], "newly loaded counters are not fresh actions");
  assert.equal(state.residentSceneFacts.owner, "another-owner"); assert.equal(state.residentSceneFacts.jobs.size, 0);
  state.pleskMind.catchCount++; assert.equal(residentSceneSocialContext(state, now).events.length, 1);
});

test("ordinary player/neighbor visits and a superseded followup retain their route when an old followup releases", () => {
  for (const speaker of ["builder", "lopukh"]) for (const targetId of ["player-conversation", "followup:someone-else"]) {
    const state = routeState(), mind = speaker === "builder" ? state.builderMind : state.villagers.residents.lopukh;
    state.social.followup = { id: "our-request", speaker, kind: speaker === "builder" ? "inspect-window" : "check-woodpile", host: "leaftail",
      phase: "approach", age: 0, topicId: "old-promise" };
    mind.socialVisit = { targetId, anchor: { x: 200, y: 200 } }; mind.route = { length: 100, points: [], distances: [] };
    const held = mind.socialVisit, route = mind.route, before = { ...mind.position }, adapter = residentSceneFollowups(state, scene, []);
    assert.equal(adapter.followupStatus(speaker), null);
    adapter.cancelFollowup(speaker); assert.equal(mind.socialVisit, held); assert.equal(mind.route, route); assert.deepEqual(mind.position, before);
  }
});

for (const speaker of ["builder", "lopukh"]) test(`the ${speaker} followup uses actual checked Tiled geometry, bounded speed and its own route`, () => {
  const state = routeState(), mind = speaker === "builder" ? state.builderMind : state.villagers.residents.lopukh;
  const request = { id: `actual-${speaker}`, speaker, kind: speaker === "builder" ? "inspect-window" : "check-woodpile", host: "leaftail" };
  state.social.followup = { ...request, phase: "queued", age: 0, topicId: "actual-promise" };
  const navigation = speaker === "builder" ? createWorldNavigation(scene, 4) : forestVillagerPlaces(scene, "lopukh").navigation;
  const target = speaker === "builder" ? forestLeaftailWindow(scene).approach : forestVillagerPlaces(scene, "lopukh").woodcutting.delivery[0].position;
  assert.ok(isWalkable(navigation, target));
  // Rehearse from a genuine nearby outdoor footstop, not inside either home.
  const starts = [36, 24, 18, 12, 6].flatMap(reach => Array.from({ length: 16 }, (_, index) => ({
    x: target.x + Math.cos(index * Math.PI / 8) * reach, y: target.y + Math.sin(index * Math.PI / 8) * reach })));
  const start = starts.find(point => isWalkable(navigation, point) && canTraverse(navigation, point, target));
  assert.ok(start); mind.position = { ...start }; mind.route = null; mind.socialVisit = null;
  const adapter = residentSceneFollowups(state, scene, []), sceneBefore = structuredClone(scene), feet = { ...mind.position };
  assert.equal(adapter.requestFollowup(request), true); assert.deepEqual(mind.position, feet, "route requests never move the feet");
  assert.equal(mind.socialVisit.targetId, `followup:${request.id}`);
  assert.equal(adapter.followupStatus(speaker), "approach");
  for (let age = 0; age < 15 && adapter.followupStatus(speaker) === "approach"; age += .1) {
    const from = { ...mind.position };
    if (speaker === "builder") advanceBuilderMind(mind, scene, .1, { now, construction: { ownerPublicId: "social-owner", revision: 1, jobs: [] } });
    else advanceForestVillagers(state.villagers, scene, .1, { now });
    assert.ok(Math.hypot(mind.position.x - from.x, mind.position.y - from.y) <= (speaker === "builder" ? 34 : 39) * .1 + .001);
    assert.ok(canTraverse(navigation, from, mind.position));
  }
  assert.equal(adapter.followupStatus(speaker), "arrived");
  assert.ok(Math.hypot(mind.position.x - target.x, mind.position.y - target.y) < .01);
  const arrived = { ...mind.position }; adapter.cancelFollowup(speaker);
  assert.equal(mind.socialVisit, null); assert.equal(adapter.followupStatus(speaker), null); assert.deepEqual(mind.position, arrived);
  assert.deepEqual(scene, sceneBefore, "no authored collision or tile is edited for the inspection");
});


test("only actual arrival transitions queue one welcome, while seen restore and owner replacement never replay it", () => {
  const state = factsState();
  state.villagers.arrivalPhase = "complete"; state.leaftailBoat = { completed: true, route: null };
  residentSceneSocialContext(state, now);
  assert.equal(state.social.welcomes, undefined, "seen restoration is not a new meeting");
  state.villagers.arrivalPhase = "running"; residentSceneSocialContext(state, now);
  state.villagers.arrivalPhase = "greeting"; residentSceneSocialContext(state, now);
  assert.equal(state.social.welcomes, undefined, "the newcomer must actually finish his arrival");
  state.villagers.arrivalPhase = "complete"; residentSceneSocialContext(state, now);
  assert.deepEqual(state.social.welcomes.map(item => item.resident), ["kamneshmyg"]);
  state.leaftailBoat = { completed: false, route: {} }; residentSceneSocialContext(state, now);
  assert.equal(state.social.welcomes.length, 1);
  state.leaftailBoat.completed = true; residentSceneSocialContext(state, now);
  assert.deepEqual(state.social.welcomes.map(item => item.resident), ["kamneshmyg", "leaftail"]);
  for (let i = 0; i < 20; i++) residentSceneSocialContext(state, now);
  assert.equal(state.social.welcomes.length, 2, "camera reads never queue another guest");
  state.social = createForestSocial("after-hydration"); residentSceneSocialContext(state, now);
  assert.equal(state.social.welcomes, undefined, "session facts do not replay already observed arrivals into a restored director");
  state.economyResidents = access(500, levels, [], "new-owner");
  state.villagers.arrivalPhase = "complete"; state.leaftailBoat = { completed: true, route: null };
  residentSceneSocialContext(state, now);
  assert.equal(state.social.welcomes, undefined);
});
