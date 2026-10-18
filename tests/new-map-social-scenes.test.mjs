import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  browser, confirmedVillagers, distanceBetween, finishVillagerArtwork, flush,
  modules, options, quietClearing, sceneClock,
} from "./helpers/new-map-scene.mjs";

const authored = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
const speakers = ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg", "leaftail"];
function onlyPair(state, first, second) {
  const allowed = [first, second].sort().join(":");
  state.social.pairAfter = Object.fromEntries(speakers.flatMap((id, index) => speakers.slice(index + 1)
    .map(other => [id, other].sort().join(":"))).filter(pair => pair !== allowed).map(pair => [pair, 10_000]));
  state.social.nextPassingAt = 10_000;
  state.social.nextEncounterAt = 0;
  state.social.nextAnimalAt = 10_000;
  state.clearing.waitSeconds = 10_000;
  state.director.nextDecisionAt = 10_000;
}
function waitRabbit(state) {
  const rabbit = state.villagers.residents.lopukh;
  assert.equal(rabbit.available, true, "confirmed resident access enables the rabbit");
  rabbit.route = null; rabbit.action = "idle"; rabbit.intent = "wander"; rabbit.wait = 10_000;
  rabbit.socialNeed = 1; rabbit.noticePending = false;
  return rabbit;
}
const stateOfPlesk = mind => ({ elapsed: mind.elapsed, age: mind.age, stage: mind.stage, position: { ...mind.position },
  home: { phase: mind.home.phase, progress: mind.home.progress, nextAt: mind.home.nextAt, until: mind.home.until },
  catchCount: mind.catchCount, queue: [...mind.queue] });

// Keep each real scene in its own lifecycle. No private scene controller or
// injected speech queue replaces the natural invitation and owner clock.
test("a free neighbour walks to Leaftail's actual window and completes the exchange while the host remains indoors", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    forestLeaftailWindow, forestVillagerPlaces, forestResidentOccupants, canTraverse, previewWorldScene, accountSceneLevels,
    FOREST_CONVERSATIONS } = await modules(structuredClone(authored));
  const env = browser(), owner = "social-window-runtime", key = `zhiv:mochlik:presence:${owner}`;
  let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: true });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key,
      economyBuildings: { home: 3, woodlot: 1 }, economyResidents: { ...confirmedVillagers(owner, 1, 0), buildings: { home: 3, quarry: 0, woodlot: 1 } },
      lopukhArrival: { seen: true, enabled: false, onComplete: assert.fail },
      merchantArrival: { seen: true, enabled: false, onComplete() {} } };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    await finishVillagerArtwork(env);
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), initial.economyBuildings));
    probe = connectForestSession(key, effective, "circle", 100_000, 0, () => {});
    const state = probe.state, merchant = state.villagers.residents.leaftail, rabbit = waitRabbit(state);
    state.social.nextEncounterAt = state.social.nextPassingAt = 10_000;
    state.clearing.waitSeconds = state.director.nextDecisionAt = 10_000;
    const clock = sceneClock(env);
    clock.until(() => merchant.doorPhase === "inside", "the real merchant first enters his caravan", 400);
    const window = forestLeaftailWindow(state.villagers.scene);
    assert.ok(window);
    onlyPair(state, "lopukh", "leaftail");
    clock.until(() => state.social.meeting?.purpose === "window", "the natural social director chooses the available window host", 10);
    assert.equal(state.social.meeting.guest, "lopukh");
    assert.equal(state.social.meeting.phase, "approach");
    assert.ok(rabbit.route, "the visitor receives a real exterior path rather than appearing at the window");
    const start = { ...rabbit.position }, navigation = forestVillagerPlaces(state.villagers.scene, "lopukh").navigation;
    const indoorFeet = { ...merchant.position }, heard = new Map();
    merchant.wait = .01; // Without the real host hold he would leave mid-visit.
    let previous = start;
    const observe = () => {
      assert.equal(merchant.doorPhase, "inside", "the window host cannot leave during the approach or exchange");
      assert.deepEqual(merchant.position, indoorFeet);
      assert.equal(scene.inspectPoint("leaftail"), null);
      assert.equal(forestResidentOccupants(state, state.villagers.scene, { heroVisible: true }).some(actor => actor.id === "leaftail"), false,
        "a window voice never creates an invisible caravan occupant");
      assert.ok(canTraverse(navigation, previous, rabbit.position));
      assert.ok(distanceBetween(previous, rabbit.position) <= 39 * .05 + 1e-7);
      previous = { ...rabbit.position };
      for (const speech of scene.speechFrames()) {
        heard.set(speech.id, speech);
        if (speech.speaker === "leaftail") assert.deepEqual(speech.anchor, window.speechAnchor, "the answer comes from the painted window");
      }
    };
    clock.until(() => { observe(); return state.social.meeting?.phase === "talk"; }, "the actual feet reach the promised exterior stop", 360);
    assert.ok(distanceBetween(start, rabbit.position) > 30);
    assert.ok(distanceBetween(window.approach, rabbit.position) <= 12);
    const talkingFeet = { ...rabbit.position }, social = structuredClone(state.social), elapsed = state.elapsed;
    for (let pass = 0; pass < 3; pass++) { scene.speechFrames(); scene.paintWorld(env.surface().context); }
    assert.deepEqual(state.social, social, "reading bubbles and painting do not advance dialogue");
    assert.equal(state.elapsed, elapsed); assert.deepEqual(rabbit.position, talkingFeet);
    clock.until(() => {
      if (!state.social.meeting) return true;
      observe(); return false;
    }, "all real lines finish within the finite exchange", 700);
    assert.equal(state.social.lastMeetingResult?.status, "completed");
    assert.equal(state.social.lastMeetingResult?.purpose, "window");
    const script = FOREST_CONVERSATIONS.find(topic => topic.id === state.social.topicHistory.at(-1));
    assert.ok(script, "a complete authored script was chosen");
    assert.deepEqual([...heard.values()].map(({ speaker, text }) => ({ speaker, text })), script.lines,
      "every authored line survives runtime availability checks, in order and without duplicates");
    assert.ok(script.lines.some(line => line.speaker === "leaftail") && script.lines.some(line => line.speaker === "lopukh"));
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("a neighbour asks the real fishing Plesk about fish without consuming her paused cast or creating a catch", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    forestVillagerPlaces, findWorldPath, pleskLocalPlaces, requestPleskWalk, previewWorldScene, accountSceneLevels,
    FOREST_CONVERSATIONS } = await modules(structuredClone(authored));
  const env = browser(), owner = "social-fisher-runtime", key = `zhiv:mochlik:presence:${owner}`;
  let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: true });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key,
      economyBuildings: { woodlot: 1 }, economyResidents: confirmedVillagers(owner, 1, 0, [], 1),
      lopukhArrival: { seen: true, enabled: false, onComplete: assert.fail } };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail }); await finishVillagerArtwork(env);
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), initial.economyBuildings));
    probe = connectForestSession(key, effective, "circle", 100_000, 0, () => {});
    const state = probe.state, mind = state.pleskMind, rabbit = waitRabbit(state), clock = sceneClock(env);
    state.social.nextEncounterAt = state.social.nextPassingAt = 10_000;
    state.clearing.waitSeconds = state.director.nextDecisionAt = 10_000;
    clock.until(() => mind.stage.action === "fish" && mind.age > 2, "Plesk begins a genuine cast at her personal river marker", 500);
    // Restore a neighbour already taking a safe nearby break. The director must
    // still plan and execute the entire remaining approach to the fisher.
    const nav = forestVillagerPlaces(state.villagers.scene, "lopukh").navigation;
    const path = pleskLocalPlaces(mind.scene).toTrade;
    assert.ok(path, "the fisher's personal route supplies reachable ground on her bank");
    const segment = path.points[1], length = distanceBetween(path.points[0], segment), ratio = Math.min(1, 70 / length);
    const candidate = { x: path.points[0].x + (segment.x - path.points[0].x) * ratio,
      y: path.points[0].y + (segment.y - path.points[0].y) * ratio };
    assert.ok(findWorldPath(nav, candidate, mind.position));
    rabbit.position = { ...candidate };
    onlyPair(state, "lopukh", "plesk");
    clock.until(() => state.social.meeting?.purpose === "fish", "the free neighbour accepts the fisher as a purposeful host", 10);
    const saved = stateOfPlesk(mind), heard = new Map();
    clock.until(() => {
      if (!state.social.meeting) return true;
      assert.equal(mind.stage, saved.stage); assert.equal(mind.age, saved.age);
      assert.deepEqual(mind.position, saved.position); assert.equal(mind.catchCount, saved.catchCount);
      assert.deepEqual(mind.queue, saved.queue, "the original reel, catch and deposit stages are retained");
      for (const line of scene.speechFrames()) heard.set(line.id, line);
      return false;
    }, "the fish conversation finishes with no invented catch or lost fishing stage", 800);
    assert.equal(state.social.lastMeetingResult?.status, "completed");
    assert.equal(state.social.lastMeetingResult?.purpose, "fish");
    const script = FOREST_CONVERSATIONS.find(topic => topic.id === state.social.topicHistory.at(-1));
    assert.ok(script, "the fishing question chooses one complete authored script");
    assert.deepEqual([...heard.values()].map(({ speaker, text }) => ({ speaker, text })), script.lines);
    assert.ok([...heard.values()].some(line => /рыб|улов|кл[её]в|удоч|снаст|леск|поплав|нажив|крюч/i.test(line.text)),
      `the fish exchange relates to the actual fisher's role; selected ${script.id}: ${script.lines.map(line => line.text).join(" / ")}`);
    assert.equal(mind.stage, saved.stage); assert.ok(mind.age >= saved.age && mind.age <= saved.age + .051,
      "finishing the conversation resumes the same waiting cast on the owner tick");
    clock.advance(.1); assert.ok(mind.age > saved.age);
    waitRabbit(state);
    clock.until(() => ["idle", "rest"].includes(mind.stage.action) && !mind.stage.deposit && !mind.stage.sell,
      "the unchanged fishing cycle reaches a harmless break", 700);
    const places = pleskLocalPlaces(mind.scene);
    assert.equal(requestPleskWalk(mind, mind.scene, places.rest ?? places.trade), true);
    onlyPair(state, "lopukh", "plesk");
    state.social.nextEncounterAt = 10_000; state.social.nextPassingAt = 0; state.social.nextManualAt = 0;
    state.social.passingPairs = []; state.social.passingAfter = {}; state.social.seed = 1;
    clock.until(() => state.social.meeting?.purpose === "passing", "the real crossing chance can pause the walking fisher", 10);
    const walk = stateOfPlesk(mind), passing = new Set();
    clock.until(() => {
      if (!state.social.meeting) return true;
      assert.equal(mind.stage, walk.stage); assert.equal(mind.age, walk.age); assert.deepEqual(mind.position, walk.position);
      assert.equal(mind.catchCount, walk.catchCount);
      for (const line of scene.speechFrames()) passing.add(line.id);
      return false;
    }, "the finite passing greeting preserves the exact walk and carried catch", 300);
    assert.equal(state.social.lastMeetingResult?.purpose, "passing");
    assert.equal(state.social.lastMeetingResult?.status, "completed"); assert.equal(passing.size, 2);
    clock.advance(.2); assert.equal(mind.stage, walk.stage); assert.ok(mind.age > walk.age, "the same optional walk resumes after greeting");
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("Plesk crosses her real doorway without ghost hits and shares one paused clock between the map and circle", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    requestPleskHome, requestPleskTrade, pleskMindFrame, forestResidentOccupants, PLESK, canTraverse, previewWorldScene, accountSceneLevels } = await modules(structuredClone(authored));
  const env = browser(), key = "plesk-home-shared-runtime", views = [];
  let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key };
    const worldCanvas = env.surface(), world = mountHabitat(worldCanvas, initial, { activity() {}, ready() {}, failure: assert.fail }); views.push(world);
    await finishVillagerArtwork(env);
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), initial.economyBuildings));
    probe = connectForestSession(key, effective, "circle", 100_000, 0, () => {});
    const state = probe.state, mind = state.pleskMind, clock = sceneClock(env), initialFeet = { ...mind.position };
    assert.equal(requestPleskHome(mind), true); assert.deepEqual(mind.position, initialFeet);
    let previous = initialFeet;
    clock.until(() => {
      assert.ok(distanceBetween(previous, mind.position) <= PLESK.speed * .05 + 1e-7);
      previous = { ...mind.position }; worldCanvas.calls.length = 0;
      return mind.home.phase === "enter" && mind.home.progress > .2 && mind.home.progress < .8;
    }, "Plesk walks from her pier to the actual threshold before fading", 500);
    const partial = stateOfPlesk(mind), opacity = pleskMindFrame(mind, mind.scene, false).opacity;
    assert.ok(opacity > 0 && opacity < 1);
    const circleCanvas = env.surface(), circleOptions = { ...initial, view: "circle" };
    const circle = mountHabitat(circleCanvas, circleOptions, { activity() {}, ready() {}, failure: assert.fail }); views.push(circle);
    await finishVillagerArtwork(env);
    world.configure({ ...initial, paused: true }); circle.configure({ ...circleOptions, paused: true }); await flush();
    clock.advance(1);
    assert.deepEqual(stateOfPlesk(mind), partial, "neither paused camera advances the threshold");
    assert.equal(pleskMindFrame(mind, mind.scene, true).opacity, opacity);
    world.configure(initial); circle.configure(circleOptions); await flush();
    const before = mind.elapsed;
    clock.advance(1);
    assert.ok(mind.elapsed - before > .9 && mind.elapsed - before <= 1.001, "two active views share one second of resident time");
    clock.until(() => {
      worldCanvas.calls.length = circleCanvas.calls.length = 0;
      return mind.home.phase === "inside";
    }, "the owner completes the same physical entry", 100);
    assert.equal(pleskMindFrame(mind, mind.scene, false), null);
    assert.equal(world.inspectPoint("plesk"), null);
    assert.equal(world.hitResident(mind.position.x, mind.position.y - PLESK.size / 2), null);
    assert.equal(forestResidentOccupants(state, mind.scene, { heroVisible: true }).some(actor => actor.id === "plesk"), false);
    const inside = stateOfPlesk(mind);
    for (let pass = 0; pass < 3; pass++) { world.paintWorld(env.surface().context); circle.speechFrames(); }
    assert.deepEqual(stateOfPlesk(mind), inside, "painting an indoor resident never consumes rest or door progress");
    requestPleskTrade(mind); const feet = { ...mind.position };
    assert.deepEqual(mind.position, feet, "a shop request does not reveal the resident at an old outdoor marker");
    previous = feet;
    clock.until(() => {
      assert.ok(distanceBetween(previous, mind.position) <= PLESK.speed * .05 + 1e-7);
      assert.ok(canTraverse(mind.home.door.navigation, previous, mind.position));
      previous = { ...mind.position }; worldCanvas.calls.length = circleCanvas.calls.length = 0;
      return mind.home.phase === "outside";
    }, "Plesk exits from her current indoor feet through the same private threshold", 100);
    assert.ok(world.inspectPoint("plesk"));
    assert.ok(forestResidentOccupants(state, mind.scene, { heroVisible: true }).some(actor => actor.id === "plesk"));
  } finally { views.forEach(view => view.dispose()); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});
