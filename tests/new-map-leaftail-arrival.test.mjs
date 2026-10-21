import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  browser, distanceBetween, finishVillagerArtwork, flush, modules, options,
  quietClearing, sceneClock,
} from "./helpers/new-map-scene.mjs";

const authored = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
const access = (ownerPublicId, revision, home) => ({ ownerPublicId, revision, buildings: { home, quarry: 0, woodlot: 1 },
  production: { ownerPublicId, revision, jobs: [] } });
const callback = () => ({ activity() {}, ready() {}, failure: assert.fail });
const tick = (clock, canvases = []) => { for (const canvas of canvases) canvas.calls.length = 0; clock.step(); };
function until(clock, predicate, message, canvases = [], limit = 1400) {
  for (let index = 0; index < limit && !predicate(); index++) tick(clock, canvases);
  assert.ok(predicate(), message);
}
function frozenBoat(state) {
  const boat = state.leaftailBoat;
  return { phase: boat.phase, elapsed: boat.elapsed, age: boat.age, position: { ...boat.position },
    distance: boat.distance, walked: boat.walked, speed: boat.speed, completed: boat.completed };
}

test("the real map keeps LeafTail absent before confirmed home 3, then executes one continuous boat arrival", async () => {
  const { createMapEngine, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    accountSceneLevels, previewWorldScene, forestVillagerFrames, canTraverse } = await modules(structuredClone(authored));
  const env = browser(), owner = "merchant-boat-runtime", key = `zhiv:mochlik:presence:${owner}`;
  let engine, probe, complete = 0;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const canvas = env.surface(420, 700);
    // Unlike the compact fixtures, the complete authored map exercises image
    // feathering. A real canvas always supplies a finite DOMMatrix here.
    canvas.context.canvas = canvas;
    canvas.context.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000,
      presenceKey: key, economyBuildings: { home: 2, quarry: 0, woodlot: 1 }, economyResidents: access(owner, 1, 2),
      residentArrival: { seen: true, enabled: false, onComplete: assert.fail },
      merchantArrival: { seen: false, enabled: false, onComplete: () => complete++ } };
    const loading = createMapEngine(canvas, initial, assert.fail, []);
    await finishVillagerArtwork(env); engine = await loading;
    let state;
    const observe = buildings => {
      probe?.release();
      const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), buildings));
      probe = connectForestSession(key, effective, "circle", 100_000, 0, () => {}); state = probe.state;
    };
    observe(initial.economyBuildings);
    const leaf = () => state.villagers.residents.leaftail, clock = sceneClock(env);
    assert.equal(leaf().available, false); assert.equal(state.leaftailBoat?.completed ?? false, false);
    const unconfirmed = { ...initial, economyBuildings: { ...initial.economyBuildings, home: 5 }, economyResidents: null };
    engine.update(unconfirmed); await finishVillagerArtwork(env); observe(unconfirmed.economyBuildings); tick(clock, [canvas]);
    assert.equal(leaf().available, false, "artwork and an unconfirmed high-level house cannot introduce a merchant");
    engine.update({ ...unconfirmed, economyResidents: access("foreign-merchant", 20, 3) }); tick(clock, [canvas]);
    assert.equal(state.economyResidents.ownerPublicId, owner); assert.equal(leaf().available, false);
    const confirmed = access(owner, 2, 3), original = structuredClone(confirmed);
    const unlocked = { ...initial, economyBuildings: { ...initial.economyBuildings, home: 3 }, economyResidents: confirmed };
    engine.update(unlocked); await finishVillagerArtwork(env); observe(unlocked.economyBuildings); tick(clock, [canvas]);
    assert.equal(leaf().available, false, "a confirmed unlock waits for the introduction overlay");
    assert.equal(state.leaftailBoat.phase, "waiting"); assert.equal(complete, 0);
    const enabled = { ...unlocked, merchantArrival: { ...initial.merchantArrival, enabled: true } };
    engine.update(enabled); await finishVillagerArtwork(env); tick(clock, [canvas]);
    assert.equal(state.leaftailBoat.phase, "sailing", JSON.stringify({ boat: frozenBoat(state), unlocked: state.leaftailBoat.unlocked,
      allowed: state.leaftailBoat.allowed, access: state.economyResidents?.buildings, leaf: { initialized: leaf().initialized, available: leaf().available },
      frames: env.frames.size })); assert.equal(leaf().available, false);
    assert.equal(forestVillagerFrames(state.villagers).some(frame => frame.id === "leaftail"), false,
      "the seated boat passenger cannot acquire a second ordinary body on the trail");
    engine.setGuidePlace("leaftail-caravan", 170);
    const phases = new Set([state.leaftailBoat.phase]); let previous = { ...state.leaftailBoat.position }, previousPhase = state.leaftailBoat.phase;
    until(clock, () => {
      const boat = state.leaftailBoat;
      assert.ok(distanceBetween(previous, boat.position) <= 48 * .05 + .02,
        `${boat.phase}: a real map frame cannot teleport the arrival`);
      if (boat.phase !== "complete") {
        assert.equal(leaf().available, false);
        assert.equal(forestVillagerFrames(state.villagers).some(frame => frame.id === "leaftail"), false);
      }
      phases.add(boat.phase);
      if (["sailing", "landing", "walking"].includes(boat.phase)) {
        const navigation = boat.phase === "sailing" ? boat.route.water : boat.phase === "landing" ? boat.route.shore : boat.route.ground;
        assert.ok(canTraverse(navigation, boat.phase === previousPhase ? previous : boat.position, boat.position),
          "the executed segment respects water, the private landing or ordinary ground obstacles");
      }
      previous = { ...boat.position }; previousPhase = boat.phase;
      return boat.completed;
    }, "the real map finishes sailing, landing, walking and greeting within 70 active seconds", [canvas]);
    for (const phase of ["sailing", "landing", "walking", "greeting", "complete"]) assert.ok(phases.has(phase), phase);
    assert.ok(state.leaftailBoat.elapsed > 25 && state.leaftailBoat.elapsed < 60);
    assert.equal(leaf().available, true);
    assert.ok(distanceBetween(leaf().position, state.leaftailBoat.route.target) < 2.1,
      "the ordinary merchant takes over at the exact arrival feet");
    await flush(); assert.equal(complete, 1);
    engine.update(enabled); await flush(); for (let i = 0; i < 20; i++) tick(clock, [canvas]);
    assert.equal(complete, 1); assert.deepEqual(confirmed, original, "an introduction cannot change confirmed jobs, inventory or levels");
    assert.equal(state.explorationId, null, "the boat never creates an economic expedition");
  } finally { engine?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("a shared circle cannot show or advance an unseen merchant, and map pause and camera handoff preserve the crossing", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    accountSceneLevels, previewWorldScene } = await modules(structuredClone(authored));
  const env = browser(), owner = "merchant-boat-camera", key = `zhiv:mochlik:presence:${owner}`, views = [];
  let probe, complete = 0;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const confirmed = access(owner, 1, 3), original = structuredClone(confirmed);
    const circleOptions = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key,
      economyBuildings: confirmed.buildings, economyResidents: confirmed,
      residentArrival: { seen: true, enabled: false, onComplete: assert.fail } };
    const circleCanvas = env.surface(), circle = mountHabitat(circleCanvas, circleOptions, callback()); views.push(circle);
    await finishVillagerArtwork(env);
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), confirmed.buildings));
    probe = connectForestSession(key, effective, "circle", 100_000, 0, () => {});
    const state = probe.state, clock = sceneClock(env);
    for (let i = 0; i < 20; i++) tick(clock, [circleCanvas]);
    assert.equal(state.villagers.residents.leaftail.available, false, "no presentation prop does not mean the arrival has been seen");
    const worldOptions = { ...circleOptions, view: "world", merchantArrival: { seen: false, enabled: true, onComplete: () => complete++ } };
    const worldCanvas = env.surface(), world = mountHabitat(worldCanvas, worldOptions, callback()); views.push(world);
    await finishVillagerArtwork(env); for (let i = 0; i < 20; i++) tick(clock, [circleCanvas, worldCanvas]);
    assert.equal(state.leaftailBoat.phase, "sailing"); assert.ok(state.leaftailBoat.elapsed > 0);
    circle.configure(circleOptions); await flush();
    const progress = state.leaftailBoat.elapsed;
    for (let i = 0; i < 5; i++) tick(clock, [circleCanvas, worldCanvas]);
    assert.ok(state.leaftailBoat.elapsed > progress, "a passive circle does not revoke the map's arrival permission");
    for (const change of [{ paused: true }, { backgrounded: true }]) {
      world.configure({ ...worldOptions, ...change }); await flush(); const frozen = frozenBoat(state);
      for (let i = 0; i < 40; i++) tick(clock, [circleCanvas, worldCanvas]);
      assert.deepEqual(frozenBoat(state), frozen); assert.equal(complete, 0);
    }
    world.configure(worldOptions); await flush(); tick(clock, [circleCanvas, worldCanvas]);
    env.visibility(true); const hidden = frozenBoat(state);
    for (let i = 0; i < 40; i++) tick(clock, [circleCanvas, worldCanvas]);
    assert.deepEqual(frozenBoat(state), hidden); assert.equal(complete, 0);
    env.visibility(false); await flush(); tick(clock, [circleCanvas, worldCanvas]);
    const disabled = { ...worldOptions, merchantArrival: { ...worldOptions.merchantArrival, enabled: false } };
    world.configure(disabled); await flush(); const frozen = frozenBoat(state);
    for (let i = 0; i < 20; i++) tick(clock, [circleCanvas, worldCanvas]);
    assert.deepEqual(frozenBoat(state), frozen);
    world.dispose();
    for (let i = 0; i < 20; i++) tick(clock, [circleCanvas]);
    assert.deepEqual(frozenBoat(state), frozen, "the circle cannot consume an unfinished full-map introduction after ownership handoff");
    const replacementCanvas = env.surface(), replacement = mountHabitat(replacementCanvas, worldOptions, callback()); views.push(replacement);
    await finishVillagerArtwork(env);
    assert.deepEqual(state.leaftailBoat.position, frozen.position, "opening the next map preserves the same boat feet");
    until(clock, () => state.leaftailBoat.completed, "the replacement world owner resumes the same finite crossing", [circleCanvas, replacementCanvas]);
    await flush(); assert.equal(complete, 1);
    circle.configure(circleOptions); replacement.configure(worldOptions); await flush();
    for (let i = 0; i < 20; i++) tick(clock, [circleCanvas, replacementCanvas]);
    assert.equal(complete, 1);
    replacement.dispose();
    const completedMap = mountHabitat(env.surface(), worldOptions, callback()); views.push(completedMap);
    await finishVillagerArtwork(env); await flush();
    assert.equal(complete, 1, "a camera remount before the persisted seen flag rerenders cannot acknowledge twice");
    assert.deepEqual(confirmed, original);
  } finally { views.forEach(view => view.dispose()); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("reduced-motion arrival acknowledges only an enabled presentation once, and never leaks to another account", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    accountSceneLevels, previewWorldScene } = await modules(structuredClone(authored));
  const env = browser(), views = [], probes = [], keys = []; let complete = 0;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const owner = "merchant-static", key = `zhiv:mochlik:presence:${owner}`; keys.push(key);
    const confirmed = access(owner, 1, 3), initial = { ...options, reducedMotion: true, view: "world", serverNow: 100_000,
      presenceKey: key, economyBuildings: confirmed.buildings, economyResidents: confirmed,
      merchantArrival: { seen: false, enabled: false, onComplete: () => complete++ } };
    const world = mountHabitat(env.surface(), initial, callback()); views.push(world); await finishVillagerArtwork(env);
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), confirmed.buildings));
    const probe = connectForestSession(key, effective, "circle", 100_000, 0, () => {}); probes.push(probe);
    assert.equal(probe.state.villagers.residents.leaftail.available, false); assert.equal(complete, 0);
    const enabled = { ...initial, merchantArrival: { ...initial.merchantArrival, enabled: true } };
    world.configure(enabled);
    // Replace the static owner before its pending completion microtask runs.
    // There is no later animation frame to repair a lost acknowledgement.
    world.dispose();
    const replacement = mountHabitat(env.surface(), enabled, callback()); views.push(replacement);
    await finishVillagerArtwork(env); await flush();
    assert.equal(probe.state.leaftailBoat.completed, true); assert.equal(probe.state.villagers.residents.leaftail.available, true);
    assert.equal(complete, 1); assert.equal(env.frames.size, 0, "static introduction does not leave a cosmetic animation loop");
    replacement.configure(enabled); await flush(); assert.equal(complete, 1);
    const different = "merchant-static-other", otherKey = `zhiv:mochlik:presence:${different}`; keys.push(otherKey);
    const otherAccess = access(different, 1, 2), otherOptions = { ...initial, presenceKey: otherKey,
      economyBuildings: otherAccess.buildings, economyResidents: otherAccess,
      merchantArrival: { seen: true, enabled: true, onComplete: assert.fail } };
    const otherWorld = mountHabitat(env.surface(), otherOptions, callback()); views.push(otherWorld); await finishVillagerArtwork(env);
    const other = connectForestSession(otherKey, effective, "circle", 100_000, 0, () => {}); probes.push(other);
    assert.equal(other.state.villagers.residents.leaftail.available, false,
      "a previous account's seen flag cannot override this account's confirmed house gate");
    assert.notEqual(other.state, probe.state); assert.equal(complete, 1);
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); keys.forEach(key => forgetForestSession(key)); worldDevStore.reset(); env.restore(); }
});

test("the merchant arrival guide tracks a finite body contour and keeps HUD clearance", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url)), vite = await createServer({ appType: "custom", configFile: false, root,
    optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { leaftailArrivalGuideTarget, mapGuideCamera } = await vite.ssrLoadModule("/features/world/scene/map-guide-target.ts");
    const { worldToScreen } = await vite.ssrLoadModule("/features/world/scene/camera.ts");
    const target = leaftailArrivalGuideTarget({ x: 920, y: 900, size: 72 });
    assert.equal(target.id, "leaftail-arrival"); assert.equal(target.place, "leaftail-caravan"); assert.equal(target.label, "Листохвост");
    assert.equal(target.hitArea.length, 4);
    const view = { width: 390, height: 844 }, insets = { top: 90, bottom: 210 };
    const camera = mapGuideCamera(target, view, { width: authored.width, height: authored.height }, insets);
    for (const corner of target.hitArea) {
      const point = worldToScreen(corner, camera, view);
      assert.ok(point.x >= 0 && point.x <= view.width);
      assert.ok(point.y >= insets.top && point.y <= view.height - insets.bottom);
    }
    for (const bad of [{ x: NaN, y: 1, size: 44 }, { x: 1, y: Infinity, size: 44 }, { x: 1, y: 1, size: 0 }])
      assert.equal(leaftailArrivalGuideTarget(bad), undefined);
  } finally { await vite.close(); }
});


test("the actual boat handover invites one old neighbour through a real Tiled route and never repeats the introduction", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    accountSceneLevels, previewWorldScene, forestVillagerPlaces, canTraverse } = await modules(structuredClone(authored));
  const env = browser(), owner = "merchant-first-welcome", key = `zhiv:mochlik:presence:${owner}`;
  let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: true });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key,
      economyBuildings: { home: 3, quarry: 0, woodlot: 1 }, economyResidents: access(owner, 1, 3),
      economyConstruction: { ownerPublicId: owner, revision: 1, jobs: [{ id: "welcome-home-upgrade", stationId: "home", targetLevel: 4,
        startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() }] },
      lopukhArrival: { seen: true, enabled: false, onComplete: assert.fail },
      residentArrival: { seen: true, enabled: false, onComplete: assert.fail },
      merchantArrival: { seen: false, enabled: true, onComplete() {} } };
    const canvas = env.surface(); scene = mountHabitat(canvas, initial, callback()); await finishVillagerArtwork(env);
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), initial.economyBuildings));
    probe = connectForestSession(key, effective, "circle", 100_000, 0, () => {});
    const state = probe.state, rabbit = state.villagers.residents.lopukh, clock = sceneClock(env);
    // Deliberately leave Lopukh as the only free neighbour: the builder owns a
    // real construction job and Plesk keeps a cast while the full arrival runs.
    assert.equal(rabbit.available, true, "the authored yard enables the established neighbour");
    rabbit.route = null; rabbit.action = "idle"; rabbit.intent = "wander"; rabbit.wait = 10_000;
    const fisher = state.pleskMind;
    fisher.intent = "fish"; fisher.stage = { ...fisher.stage, action: "fish", duration: 10_000 };
    fisher.age = 0; fisher.queue = [];
    state.social.nextEncounterAt = state.social.nextPassingAt = state.social.nextAnimalAt = 10_000;
    state.clearing.waitSeconds = state.director.nextDecisionAt = 10_000;
    until(clock, () => state.leaftailBoat?.completed, "a genuine boat arrival completes before any welcome", [canvas]);
    assert.equal(state.social.meeting, null); assert.equal(state.villagers.residents.leaftail.action, "inspect");
    until(clock, () => state.social.meeting?.purpose === "welcome", "one available neighbour accepts the first introduction", [canvas], 400);
    assert.equal(state.social.meeting.host, "leaftail"); assert.equal(state.social.meeting.phase, "approach");
    assert.equal(state.builderMind.job?.id, "welcome-home-upgrade"); assert.equal(fisher.intent, "fish");
    const guest = state.social.meeting.guest;
    assert.equal(guest, "lopukh", "the nearby idle resident visits, without recruiting the player");
    const start = { ...rabbit.position }, navigation = forestVillagerPlaces(state.villagers.scene, "lopukh").navigation;
    let previous = start; const heard = new Map();
    until(clock, () => {
      assert.ok(canTraverse(navigation, previous, rabbit.position));
      assert.ok(distanceBetween(previous, rabbit.position) <= 39 * .05 + 1e-7);
      previous = { ...rabbit.position };
      return state.social.meeting?.phase === "talk";
    }, "the established resident reaches the newcomer's genuine outdoor feet", [canvas], 400);
    assert.ok(distanceBetween(start, rabbit.position) > 10);
    until(clock, () => {
      for (const line of scene.speechFrames()) heard.set(line.id, line);
      return !state.social.meeting;
    }, "the finite first introduction completes and releases both residents", [canvas], 700);
    assert.equal(state.social.lastMeetingResult?.purpose, "welcome"); assert.equal(state.social.lastMeetingResult?.status, "completed");
    assert.equal(heard.size, 4); assert.ok([...heard.values()].some(line => /запас тишины/.test(line.text)));
    assert.equal(rabbit.socialVisit, null); assert.deepEqual(state.social.welcomedResidents, ["leaftail"]);
    scene.configure({ ...initial, merchantArrival: { ...initial.merchantArrival, seen: true, enabled: false } });
    await finishVillagerArtwork(env);
    // Arriving now replaces the abandoned exterior and may transfer the live
    // simulation to its committed geometry. Observe that session, not old feet.
    const settled = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(),
      initial.economyBuildings, { merchantArrived: true }));
    probe.release(); probe = connectForestSession(key, settled, "circle", 100_000, 0, () => {});
    for (let i = 0; i < 80; i++) tick(clock, [canvas]);
    assert.equal(probe.state.social.meeting, null); assert.equal(probe.state.social.welcomes.length, 0,
      "seen refresh and occupied exterior geometry do not gather the neighbours again");
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});
