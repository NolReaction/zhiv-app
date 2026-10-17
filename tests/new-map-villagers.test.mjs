import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  browser,
  builderMemoryServer,
  compactVillagerFixture,
  confirmedVillagers,
  distanceBetween,
  finishVillagerArtwork,
  flush,
  modules,
  options,
  quietClearing,
  sceneClock,
} from "./helpers/new-map-scene.mjs";

test("new villagers require confirmed account access, the claimed quarry and an enabled map introduction", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore, isWalkable, canTraverse } = await modules(compactVillagerFixture());
  const env = browser(); let scene, probe;
  const owner = "villagers-unlock", key = `zhiv:mochlik:presence:${owner}`;
  let completed = 0;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key,
      economyBuildings: { quarry: 1 }, economyResidents: null,
      residentArrival: { seen: false, enabled: false, onComplete: () => completed++ } };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    await finishVillagerArtwork(env);
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, clock = sceneClock(env), miner = () => state.villagers.residents.kamneshmyg;
    assert.equal(miner().available, false); assert.equal(scene.inspectPoint("kamneshmyg"), null);
    scene.configure({ ...initial, economyResidents: confirmedVillagers("another-account", 50) });
    clock.advance(.3); assert.equal(state.economyResidents, undefined); assert.equal(miner().available, false);
    scene.configure({ ...initial, economyResidents: confirmedVillagers(owner, 1, 0) });
    clock.advance(.3); assert.equal(miner().available, false, "a construction timer or visible preview does not replace a claimed level");
    const confirmed = confirmedVillagers(owner, 2), original = structuredClone(confirmed);
    const unlocked = { ...initial, economyResidents: confirmed };
    scene.configure(unlocked); clock.advance(.3);
    assert.equal(miner().available, false); assert.equal(state.villagers.arrivalPhase, "waiting");
    assert.equal(completed, 0); assert.equal(env.timers.size, 0, "no ready timer silently completes the introduction");
    const enabled = { ...unlocked, residentArrival: { ...initial.residentArrival, enabled: true } };
    scene.configure(enabled);
    assert.equal(state.villagers.arrivalPhase, "running"); assert.equal(miner().available, true);
    const start = { ...miner().position }, navigation = state.clearing.navigation;
    assert.ok(start.y < TILED_WORLD.sites.find(site => site.id === "quarry").entry.y - 150, "the visible miner really starts at the north edge");
    assert.ok(isWalkable(navigation, start)); assert.deepEqual(scene.residentArrivalPoint(), { ...start, size: 42 });
    let previous = start;
    clock.until(() => {
      const position = miner().position;
      assert.ok(canTraverse(navigation, previous, position), "the executed approach stays outside authored physical obstacles");
      assert.ok(distanceBetween(previous, position) <= 99 * .05 + 1e-7, "the approach cannot teleport between frames");
      previous = { ...position }; return state.villagers.arrivalPhase === "greeting";
    }, "the northern run physically reaches the quarry before greeting", 600);
    assert.equal(completed, 0); assert.equal(miner().action, "greet");
    clock.advance(1); assert.equal(completed, 0, "the greeting is shown before acknowledgement");
    clock.until(() => state.villagers.arrivalPhase === "complete", "the finite greeting completes", 100);
    await flush(); assert.equal(completed, 1); assert.equal(scene.residentArrivalPoint(), null);
    scene.configure(enabled); clock.advance(1); await flush(); assert.equal(completed, 1, "reconfiguration and ordinary frames cannot repeat completion");
    assert.deepEqual(confirmed, original, "the cosmetic introduction never rewrites the confirmed economy");
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("new villagers freeze their arrival while paused, hidden, in the circle or behind a disabled presentation", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore } = await modules(compactVillagerFixture());
  const env = browser(), views = []; let probe;
  const owner = "villagers-presentation", key = `zhiv:mochlik:presence:${owner}`;
  let completed = 0;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key,
      economyBuildings: { quarry: 1 }, economyResidents: confirmedVillagers(owner),
      residentArrival: { seen: false, enabled: true, onComplete: () => completed++ } };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle); await finishVillagerArtwork(env);
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, clock = sceneClock(env);
    clock.advance(1); assert.equal(state.villagers.residents.kamneshmyg.available, false, "the circle cannot start the full-map arrival");
    const mapOptions = { ...initial, view: "world" }, world = mountHabitat(env.surface(), mapOptions, callbacks); views.push(world);
    await finishVillagerArtwork(env); clock.advance(.5);
    const miner = state.villagers.residents.kamneshmyg;
    assert.equal(state.villagers.arrivalPhase, "running"); assert.ok(miner.elapsed > 0);
    const assertFrozen = (snapshot, reason) => {
      assert.deepEqual(miner, snapshot, reason); assert.equal(completed, 0);
    };
    world.configure({ ...mapOptions, paused: true }); await flush();
    let frozen = structuredClone(miner); clock.advance(1); assertFrozen(frozen, "circle ownership cannot advance the paused map introduction");
    world.configure({ ...mapOptions, backgrounded: true }); await flush();
    frozen = structuredClone(miner); clock.advance(1); assertFrozen(frozen, "backgrounding cannot consume a run or acknowledgement");
    world.configure(mapOptions); await flush(); clock.advance(.2);
    env.visibility(true); frozen = structuredClone(miner); clock.advance(1); assertFrozen(frozen, "a hidden page has no arrival clock");
    env.visibility(false); await flush();
    const disabled = { ...mapOptions, residentArrival: { ...initial.residentArrival, enabled: false } };
    world.configure(disabled); frozen = structuredClone(miner); clock.advance(1); assertFrozen(frozen, "closing the introduction holds its exact route progress");
    world.configure({ ...disabled, reducedMotion: true }); await flush();
    assertFrozen(frozen, "reduced motion cannot skip an introduction whose presentation is disabled");
    world.configure({ ...mapOptions, reducedMotion: true }); await flush();
    assert.equal(state.villagers.arrivalPhase, "complete"); assert.equal(miner.route, null); assert.equal(completed, 1);
    circle.configure({ ...initial, reducedMotion: true }); await flush(); assert.equal(completed, 1, "a second static camera cannot write a second acknowledgement");
  } finally { views.forEach(view => view.dispose()); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("new villagers do not start or acknowledge arrival without the authoritative simulation lease", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, ApiError } = await modules(compactVillagerFixture());
  const env = browser(); let scene, probe;
  const owner = "3234-ABCD-EFGH", key = `zhiv:mochlik:presence:${owner}`, server = builderMemoryServer(owner, ApiError);
  let refuse = true, completed = 0;
  const transport = { read: (...args) => server.transport.read(...args), async command(command) {
    if (refuse && command.action === "acquire") throw new ApiError("FOREST_MEMORY_ACTIVE_ELSEWHERE", 409,
      { code: "FOREST_MEMORY_ACTIVE_ELSEWHERE", message: "FOREST_MEMORY_ACTIVE_ELSEWHERE" });
    return server.transport.command(command);
  } };
  try {
    probe = connectForestSession(key, TILED_WORLD, "circle", server.now(), 0, () => {},
      { sync: { environment: server.environment, transport } });
    const initial = { ...options, view: "world", serverNow: server.now(), presenceKey: key,
      economyBuildings: { quarry: 1 }, economyResidents: confirmedVillagers(owner),
      residentArrival: { seen: false, enabled: true, onComplete: () => completed++ } };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    await finishVillagerArtwork(env); await server.pump();
    const state = probe.state;
    assert.equal(state.memory.sync.mode, "other-device"); assert.equal(state.villagers.residents.kamneshmyg.available, false);
    const waiting = structuredClone(state.villagers); const clock = sceneClock(env); clock.advance(5);
    scene.configure(initial); await server.pump();
    assert.deepEqual(state.villagers, waiting, "a confirmed quarry and reduced-motion option cannot bypass lease refusal");
    assert.equal(completed, 0); assert.equal(env.frames.size, 0);
    refuse = false; probe.takeOverMemory(); await server.pump(); await flush();
    assert.equal(state.memory.sync.mode, "synced"); assert.equal(state.villagers.arrivalPhase, "complete");
    assert.equal(completed, 1, "the enabled static introduction acknowledges only after real ownership is granted");
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); await server.pump(); env.restore(); }
});

test("new villagers physically enter confirmed quarry work and leave after cancellation while preserving Mochlik compatibility", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    forestVillagerFrames, forestVillagerOccupants, canTraverse } = await modules(compactVillagerFixture());
  const env = browser(), views = [], probes = [], keys = [];
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const job = { id: "quarry-owned-job", stationId: "quarry", stationLevel: 1, recipeId: "quarry_stone",
      startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
    const owner = "villagers-worker", key = `zhiv:mochlik:presence:${owner}`; keys.push(key);
    const access = confirmedVillagers(owner, 1, 1, [job]), original = structuredClone(access);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key, economyBuildings: { quarry: 1 },
      economyProduction: access.production, economyResidents: access, residentArrival: { seen: true, enabled: false, onComplete: assert.fail } };
    const scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail }); views.push(scene);
    await finishVillagerArtwork(env);
    const probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {}); probes.push(probe);
    const state = probe.state, home = { ...state.clearing.position }, clock = sceneClock(env);
    const miner = state.villagers.residents.kamneshmyg, start = { ...miner.position };
    assert.equal(miner.job, true); assert.notEqual(miner.action, "work", "new work starts with the current outdoor body");
    assert.deepEqual(miner.position, start);
    let previous = { ...start }, sawPartialFade = false;
    clock.until(() => {
      assert.ok(distanceBetween(previous, miner.position) <= 33 * .05 + 1e-7, "each visible approach and threshold step respects walking speed");
      const navigation = ["enter", "inside", "exit"].includes(miner.doorPhase) ? miner.door.navigation : state.clearing.navigation;
      assert.ok(canTraverse(navigation, previous, miner.position), "only the validated private threshold may cross the miner's own collider");
      previous = { ...miner.position };
      const frame = forestVillagerFrames(state.villagers).find(frame => frame.id === "kamneshmyg");
      if (frame && frame.opacity > .05 && frame.opacity < .95) sawPartialFade = true;
      return miner.doorPhase === "inside";
    }, "the same miner approaches the entrance and actually enters the quarry", 250);
    assert.ok(sawPartialFade, "entry has visible intermediate opacity instead of disappearing in a single frame");
    assert.equal(forestVillagerFrames(state.villagers).some(frame => frame.id === "kamneshmyg"), false);
    assert.equal(forestVillagerOccupants(state.villagers).some(occupant => occupant.id === "kamneshmyg"), false);
    assert.equal(scene.inspectPoint("kamneshmyg"), null, "an indoor worker leaves no invisible map hit target");
    assert.equal(state.journeyTravel?.mining, undefined); assert.equal(state.explorationId ?? null, null);
    assert.deepEqual(state.clearing.position, home, "ordinary stone production leaves Mochlik in the clearing");
    assert.deepEqual(access, original);
    const inside = { ...miner.position }, cancelled = confirmedVillagers(owner, 2, 1);
    scene.configure({ ...initial, economyResidents: cancelled, economyProduction: cancelled.production });
    assert.equal(miner.job, false); assert.deepEqual(miner.position, inside, "cancelling a job cannot reveal the body at an old exterior stop");
    previous = { ...inside };
    clock.until(() => {
      assert.ok(distanceBetween(previous, miner.position) <= 33 * .05 + 1e-7, "the miner walks back through the same threshold");
      previous = { ...miner.position }; return miner.doorPhase === "outside";
    }, "cancellation brings the same worker safely back outside", 200);
    assert.ok(forestVillagerFrames(state.villagers).some(frame => frame.id === "kamneshmyg"));
    miner.wait = 0; miner.workNeed = 1;
    let walkedWithoutJob = false;
    for (let pass = 0; pass < 200; pass++) {
      clock.step(); assert.notEqual(miner.action, "work", "a free miner never pretends to mine without confirmed work");
      walkedWithoutJob ||= Boolean(miner.route);
    }
    assert.ok(walkedWithoutJob, "after work the miner resumes outdoor life");
    const resumedJob = { ...job, id: "quarry-cancel-mid-threshold" }, resumed = confirmedVillagers(owner, 3, 1, [resumedJob]);
    scene.configure({ ...initial, economyResidents: resumed, economyProduction: resumed.production });
    clock.until(() => miner.doorPhase === "enter" && miner.doorProgress > .15 && miner.doorProgress < .85,
      "a later assignment approaches the quarry from the miner's current walk", 300);
    const partialPosition = { ...miner.position }, partialProgress = miner.doorProgress;
    const partialOpacity = forestVillagerFrames(state.villagers).find(frame => frame.id === "kamneshmyg").opacity;
    const secondCancellation = confirmedVillagers(owner, 4, 1);
    const stopped = { ...initial, economyResidents: secondCancellation, economyProduction: secondCancellation.production };
    scene.configure(stopped);
    assert.equal(miner.job, false); assert.equal(miner.doorProgress, partialProgress);
    assert.deepEqual(miner.position, partialPosition);
    assert.equal(forestVillagerFrames(state.villagers).find(frame => frame.id === "kamneshmyg").opacity, partialOpacity,
      "mid-entry cancellation reverses the same fade without an opacity jump");
    clock.until(() => miner.doorPhase === "exit", "the first resumed owner update reverses the partial crossing", 4);
    assert.ok(miner.doorProgress < partialProgress);
    scene.configure({ ...stopped, paused: true }); const pausedThreshold = structuredClone(miner); clock.advance(2);
    assert.deepEqual(miner, pausedThreshold, "a paused threshold reversal has no separate animation timer");
    scene.configure(stopped); await flush(); previous = { ...miner.position };
    clock.until(() => {
      assert.ok(distanceBetween(previous, miner.position) <= 33 * .05 + 1e-7);
      previous = { ...miner.position }; return miner.doorPhase === "outside";
    }, "a cancelled partial entry returns to the same safe approach", 200);
    scene.dispose(); probe.release(); forgetForestSession(key);
    const legacyOwner = "villagers-worker-compat", legacyKey = `zhiv:mochlik:presence:${legacyOwner}`; keys.push(legacyKey);
    const compatibility = { ...initial, presenceKey: legacyKey, economyResidents: undefined, residentArrival: undefined,
      economyProduction: { ownerPublicId: legacyOwner, revision: 1, jobs: [job] } };
    const legacy = mountHabitat(env.surface(), compatibility, { activity() {}, ready() {}, failure: assert.fail }); views.push(legacy);
    await finishVillagerArtwork(env);
    const legacyProbe = connectForestSession(legacyKey, TILED_WORLD, "circle", 100_000, 0, () => {}); probes.push(legacyProbe);
    assert.equal(legacyProbe.state.villagers.residents.kamneshmyg.available, false);
    assert.equal(legacyProbe.state.journeyTravel?.jobId, `production:${job.id}`);
    assert.equal(legacyProbe.state.journeyTravel?.phase, "leaving", "callers without resident projection retain the legacy work journey");
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); keys.forEach(forgetForestSession); worldDevStore.reset(); env.restore(); }
});

test("new villagers keep a new resident host available when the real social loop changes both partners to greet", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore, FOREST_CONVERSATIONS } = await modules(compactVillagerFixture());
  const env = browser(); let scene, probe;
  const owner = "villagers-social-host", key = `zhiv:mochlik:presence:${owner}`;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: true });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key,
      economyBuildings: { home: 3 }, economyResidents: { ...confirmedVillagers(owner, 1, 0), buildings: { home: 3, quarry: 0 } },
      merchantArrival: { seen: true, enabled: false, onComplete: assert.fail } };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail }); await finishVillagerArtwork(env);
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, social = state.social, guest = state.villagers.residents.lopukh, host = state.villagers.residents.leaftail;
    guest.position = { x: 680, y: 690 }; host.position = { x: 735, y: 690 };
    for (const mind of [guest, host]) { mind.route = null; mind.action = "idle"; mind.wait = 60; mind.doorPhase = "outside"; mind.doorProgress = 0; }
    // Begin at the natural approach→talk boundary, using a real authored script;
    // the scene must keep the host eligible after its first greet animation.
    const script = FOREST_CONVERSATIONS.find(topic => ["lopukh-leaftail", "leaftail-lopukh"].includes(topic.pair));
    assert.ok(script);
    guest.socialVisit = { targetId: host.id, anchor: { ...host.position } };
    social.meeting = { anchor: { ...host.position }, guestAnchor: { ...guest.position }, host: host.id, guest: guest.id,
      visit: "resident", phase: "talk", age: 0 };
    social.topicHistory.push(script.id); social.current = { id: "resident-script-start", ...script.lines[0], elapsed: 0, duration: 3.8, origin: "ambient" };
    social.queue = script.lines.slice(1).map(line => ({ ...line })); social.nextEncounterAt = 10_000;
    state.clearing.waitSeconds = 60; state.director.nextDecisionAt = 60;
    const clock = sceneClock(env); clock.advance(.1);
    assert.equal(host.action, "greet"); assert.equal(guest.action, "greet"); assert.ok(social.meeting);
    const first = social.current.id; clock.advance(.2);
    assert.ok(social.meeting, "greet remains a live conversation host on the next real runtime frame");
    assert.equal(social.current.id, first); assert.ok(social.current.elapsed > 0); assert.ok(scene.speechFrames().length > 0);
    const lines = new Map([[social.current.id, { speaker: social.current.speaker, text: social.current.text }]]);
    for (let pass = 0; pass < 650 && social.meeting; pass++) {
      if (social.current) lines.set(social.current.id, { speaker: social.current.speaker, text: social.current.text });
      clock.step();
    }
    assert.equal(social.meeting, null); assert.equal(social.current, null); assert.equal(guest.socialVisit, null);
    assert.deepEqual([...lines.values()], script.lines, "all authored replies survive the host's greeting pose and finish normally");
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("new villagers share real insect visitors across cameras and release the same individual for confirmed work", async () => {
  const authored = compactVillagerFixture();
  authored.habitats = [{ id: "rabbit-meadow", species: "butterfly", capacity: 2,
    points: [{ x: 400, y: 650 }, { x: 600, y: 650 }, { x: 600, y: 835 }, { x: 400, y: 835 }],
    anchors: [{ id: "rabbit-flower", kind: "rest", position: { x: 440, y: 710 } },
      { id: "rabbit-cover", kind: "shelter", position: { x: 420, y: 680 } }] }];
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    residentFaunaEncounter, forestVillagerFrames } = await modules(authored);
  const env = browser(), views = []; let probe;
  const owner = "villagers-real-insect", key = `zhiv:mochlik:presence:${owner}`;
  try {
    worldDevStore.patch({ ...quietClearing, butterflies: "on", autoLife: true });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key,
      economyResidents: confirmedVillagers(owner, 1, 0) };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const world = mountHabitat(env.surface(), initial, callbacks); views.push(world); await finishVillagerArtwork(env);
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, rabbit = state.villagers.residents.lopukh, clock = sceneClock(env);
    rabbit.route = null; rabbit.action = "idle"; rabbit.wait = 60;
    state.social.nextEncounterAt = 1e6; state.fauna.nextEncounterAt = 1e6; state.fauna.nextVisitorAt = 0;
    state.villagerWildlife.nextBirdAt = 1e6;
    state.director.nextDecisionAt = 1e6; state.clearing.waitSeconds = 60;
    const population = state.fauna.entities.slice(), identities = population.map(entity => entity.id);
    const butterfly = population.find(entity => entity.species === "butterfly");
    assert.ok(butterfly, "the authored habitat supplies the existing individual");
    Object.assign(butterfly, { x: rabbit.position.x + 10, y: rabbit.position.y - 20,
      mode: "fly", interactionToken: null, cooldownUntil: 0, alertness: 0 });
    const feet = { ...rabbit.position };
    clock.until(() => Boolean(residentFaunaEncounter(state.fauna, "lopukh")), "the actual scene offers the nearby butterfly to the free rabbit", 50);
    const visit = residentFaunaEncounter(state.fauna, "lopukh"), token = visit.token;
    assert.equal(visit.entityId, butterfly.id); assert.equal(visit.phase, "notice");
    assert.deepEqual(rabbit.position, feet);

    const circleOptions = { ...initial, view: "circle" }, circle = mountHabitat(env.surface(), circleOptions, callbacks);
    views.push(circle); await finishVillagerArtwork(env);
    assert.equal(env.frames.size, 1, "the second camera observes the same owner clock");
    world.configure({ ...initial, paused: true }); circle.configure({ ...circleOptions, paused: true });
    const frozenFauna = structuredClone(state.fauna), frozenMind = structuredClone(rabbit), frozenWildlife = structuredClone(state.villagerWildlife);
    clock.advance(3);
    assert.deepEqual(state.fauna, frozenFauna); assert.deepEqual(rabbit, frozenMind); assert.deepEqual(state.villagerWildlife, frozenWildlife);
    world.configure(initial); await flush();
    clock.until(() => residentFaunaEncounter(state.fauna, "lopukh")?.phase === "perch", "the same individual reaches the rabbit's raised paw", 300);
    assert.equal(residentFaunaEncounter(state.fauna, "lopukh").token, token);
    assert.deepEqual(rabbit.position, feet, "the encounter holds the existing feet without teleporting either resident");
    assert.deepEqual(state.fauna.entities.map(entity => entity.id), identities);
    assert.ok(population.every((entity, index) => state.fauna.entities[index] === entity), "a resident encounter never replaces the population");
    const beforeReading = structuredClone(state.fauna);
    for (const view of [world, circle]) {
      const surface = env.surface(); view.paintWorld(surface.context); view.speechFrames();
      forestVillagerFrames(state.villagers);
    }
    assert.deepEqual(state.fauna, beforeReading, "rendering, speech and frame sampling cannot advance a held animal");

    const woodJob = { id: "rabbit-priority-work", stationId: "woodlot", stationLevel: 1, recipeId: "woodlot_wood",
      startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
    const confirmed = confirmedVillagers(owner, 2, 0, [woodJob]), original = structuredClone(confirmed);
    const animalFeet = { x: butterfly.x, y: butterfly.y };
    world.configure({ ...initial, economyResidents: confirmed });
    assert.equal(rabbit.job, true);
    assert.equal(residentFaunaEncounter(state.fauna, "lopukh")?.phase, "interrupt", "a confirmed work snapshot immediately releases the visitor");
    assert.deepEqual({ x: butterfly.x, y: butterfly.y }, animalFeet, "preemption preserves the animal's exact last position");
    assert.deepEqual(rabbit.position, feet); assert.deepEqual(confirmed, original);
    clock.advance(1);
    assert.equal(residentFaunaEncounter(state.fauna, "lopukh"), null, "the finite animal outro releases its reservation");
    assert.deepEqual(state.fauna.entities.map(entity => entity.id), identities);
    assert.equal(state.fauna.entities.find(entity => entity.id === butterfly.id), butterfly);
  } finally { views.forEach(view => view.dispose()); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("the actual Tiled quarry and caravan preserve private entrances, indoor hit absence and shared paused door progress", async () => {
  const authored = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    forestVillagerPlaces, forestVillagerFrames, forestVillagerOccupants, canTraverse, isWalkable,
    previewPointInPolygon, previewWorldScene, accountSceneLevels } = await modules(authored);
  const env = browser(), views = []; let probe;
  const owner = "villagers-authored-doors", key = `zhiv:mochlik:presence:${owner}`;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const job = { id: "authored-quarry-work", stationId: "quarry", stationLevel: 1, recipeId: "quarry_stone",
      startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
    const confirmed = { ...confirmedVillagers(owner, 1, 1, [job]), buildings: { home: 3, quarry: 1 } }, originalEconomy = structuredClone(confirmed);
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key,
      economyBuildings: { home: 3, quarry: 1 }, economyResidents: confirmed,
      merchantArrival: { seen: true, enabled: false, onComplete: assert.fail },
      residentArrival: { seen: true, enabled: false, onComplete: assert.fail } };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail }, canvas = env.surface();
    const world = mountHabitat(canvas, initial, callbacks); views.push(world); await finishVillagerArtwork(env);
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), initial.economyBuildings));
    probe = connectForestSession(key, effective, "circle", 100_000, 0, () => {});
    const state = probe.state, miner = state.villagers.residents.kamneshmyg, merchant = state.villagers.residents.leaftail;
    const scene = state.villagers.scene, source = JSON.stringify(TILED_WORLD), clock = sceneClock(env);
    const quarry = scene.sites.find(site => site.id === "quarry"), caravan = scene.sites.find(site => site.id === "leaftail-caravan");
    const miningPlaces = forestVillagerPlaces(scene, "kamneshmyg"), merchantPlaces = forestVillagerPlaces(scene, "leaftail");
    assert.equal(caravan.doorway, undefined, "the authored caravan has no invented wall doorway");
    assert.equal(miningPlaces.door.kind, "threshold"); assert.equal(merchantPlaces.door.kind, "concealment");
    assert.equal(isWalkable(miningPlaces.navigation, quarry.doorway), false, "ordinary actors still see the quarry wall");
    assert.ok(miningPlaces.door.points.some(point => distanceBetween(point, quarry.entry) < 1e-7));
    assert.ok(distanceBetween(miningPlaces.door.points.at(-1), quarry.doorway) < 1e-7);
    for (const places of [miningPlaces, merchantPlaces]) {
      for (let index = 1; index < places.door.points.length; index++) {
        assert.ok(canTraverse(places.door.navigation, places.door.points[index - 1], places.door.points[index]),
          "the actual authored threshold is validated against every other physical obstacle");
      }
    }
    assert.equal(merchantPlaces.door.navigation, merchantPlaces.navigation, "concealment keeps the complete ordinary navigation");
    assert.ok(previewPointInPolygon(merchantPlaces.door.points.at(-1), caravan.hitArea));
    let previousMiner = { ...miner.position }, previousMerchant = { ...merchant.position };
    clock.until(() => {
      assert.ok(distanceBetween(previousMiner, miner.position) <= 33 * .05 + 1e-7);
      assert.ok(distanceBetween(previousMerchant, merchant.position) <= 32 * .05 + 1e-7);
      previousMiner = { ...miner.position }; previousMerchant = { ...merchant.position };
      canvas.calls.length = 0;
      return miner.doorPhase === "inside" && merchant.doorPhase === "inside";
    }, "both actual residents physically enter their own authored place", 350);
    for (const id of ["kamneshmyg", "leaftail"]) {
      assert.equal(world.inspectPoint(id), null);
      assert.equal(forestVillagerFrames(state.villagers).some(frame => frame.id === id), false);
      assert.equal(forestVillagerOccupants(state.villagers).some(occupant => occupant.id === id), false);
    }
    const circleOptions = { ...initial, view: "circle" }, circle = mountHabitat(env.surface(), circleOptions, callbacks);
    views.push(circle); await finishVillagerArtwork(env);
    const homeElapsed = merchant.elapsed;
    clock.until(() => {
      canvas.calls.length = 0;
      return merchant.doorPhase === "exit" && merchant.doorProgress > .1 && merchant.doorProgress < .9;
    }, "the merchant naturally leaves his own home after a quiet indoor interval", 1500);
    assert.ok(merchant.elapsed - homeElapsed > 20, "the merchant spends a meaningful interval indoors instead of camping on the trail");
    const partial = { ...merchant.position }, frozenMerchant = structuredClone(merchant), frozenMiner = structuredClone(miner);
    world.configure({ ...initial, paused: true }); circle.configure({ ...circleOptions, paused: true });
    clock.advance(2);
    assert.deepEqual(merchant, frozenMerchant); assert.deepEqual(miner, frozenMiner);
    circle.configure({ ...circleOptions, reducedMotion: true }); await flush(); clock.advance(2);
    assert.deepEqual(merchant.position, partial); assert.equal(merchant.doorProgress, frozenMerchant.doorProgress,
      "reduced motion leaves a partially visible doorway at its exact progress");
    circle.configure({ ...circleOptions, paused: true }); world.configure(initial); await flush();
    previousMerchant = { ...merchant.position };
    clock.until(() => {
      assert.ok(distanceBetween(previousMerchant, merchant.position) <= 32 * .05 + 1e-7);
      previousMerchant = { ...merchant.position }; canvas.calls.length = 0;
      return merchant.doorPhase === "outside";
    }, "the resumed owner continues the same exit without a frame jump", 100);
    assert.ok(isWalkable(merchantPlaces.navigation, merchant.position));
    assert.ok(world.inspectPoint("leaftail"));

    const cancelled = { ...confirmedVillagers(owner, 2, 1), buildings: { home: 3, quarry: 1 } };
    world.configure({ ...initial, economyResidents: cancelled });
    clock.until(() => { canvas.calls.length = 0; return miner.doorPhase === "outside"; }, "the miner also exits the actual quarry after the job disappears", 200);
    assert.ok(isWalkable(miningPlaces.navigation, miner.position)); assert.equal(miner.job, false);
    assert.deepEqual(confirmed, originalEconomy);
    assert.equal(JSON.stringify(TILED_WORLD), source, "private entrances never edit the Tiled export, public collision or source markers");
  } finally { views.forEach(view => view.dispose()); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});
