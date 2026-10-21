import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { browser, compactVillagerFixture, confirmedVillagers, finishVillagerArtwork, modules, options, quietClearing, sceneClock } from "./helpers/new-map-scene.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { createForestVillagers, rehydrateForestVillagers, configureForestVillagers, advanceForestVillagers,
  forestVillagerFrames, forestVillagerOccupants, settleForestVillagerArrival, requestForestVillagerVisit } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-mind.ts");
const { forestVillagerPlaces } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-navigation.ts");
const { canTraverse, isWalkable } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { accountSceneLevels } = await vite.ssrLoadModule("/features/world/state/economy/economy-scene-state.ts");
const { previewWorldScene, previewSiteVisual } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { residentScenePresentation } = await vite.ssrLoadModule("/features/world/scene/resident-scene-presentation.ts");
const { announceSceneLopukhArrival } = await vite.ssrLoadModule("/features/world/scene/resident-scene-arrival.ts");
const { residentSceneSocialContext } = await vite.ssrLoadModule("/features/world/scene/resident-scene-social.ts");
const { createForestSocial } = await vite.ssrLoadModule("/features/world/characters/social/forest-social.ts");
const now = Date.parse("2026-10-18T12:00:00Z");
const levels = accountSceneLevels(TILED_WORLD, 1, undefined, { woodlot: 1 });
const world = previewWorldScene(TILED_WORLD, levels);
const config = { confirmed: true, buildings: { home: 1, quarry: 0, woodlot: 1 }, allowLopukhArrival: true, now };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test("closed woodlot retains its authored interaction and collision without artwork or resident", () => {
  const zero = accountSceneLevels(TILED_WORLD, 1, undefined, { woodlot: 0 });
  const authored = TILED_WORLD.sites.find(site => site.id === "lopukh-home");
  const closed = previewWorldScene(TILED_WORLD, zero), site = closed.sites.find(site => site.id === "lopukh-home");
  assert.equal(zero["lopukh-home"], 0);
  assert.equal(accountSceneLevels(TILED_WORLD, 1)["lopukh-home"], 0, "unknown account does not briefly show an unlocked home");
  assert.equal(accountSceneLevels(TILED_WORLD, 1, { levels: { "lopukh-home": 1 }, previewBuildings: true })["lopukh-home"], 1, "explicit DEV art preview remains available");
  assert.equal(previewSiteVisual(authored, zero).image, "");
  assert.deepEqual(site.hitArea, authored.hitArea); assert.deepEqual(site.collision, authored.collision);
  assert.deepEqual(site.entry, authored.entry);
  const state = createForestVillagers(closed);
  configureForestVillagers(state, closed, { ...config, confirmed: false });
  assert.equal(state.residents.lopukh.available, false, "preview and cached levels do not grant access");
  configureForestVillagers(state, closed, { ...config, buildings: { woodlot: 0 }, lopukhArrivalSeen: true });
  assert.equal(state.lopukhArrivalPending, false); assert.equal(state.residents.lopukh.available, false);
  assert.equal(forestVillagerFrames(state).some(frame => frame.id === "lopukh"), false);
  assert.equal(forestVillagerOccupants(state).some(frame => frame.id === "lopukh"), false);
  assert.deepEqual(residentScenePresentation({ villagers: state, elapsed: 0 }, closed).homes, []);
  assert.equal(previewSiteVisual(authored, levels).image, authored.states.find(state => state.level === 1).image);
});

test("real map rabbit runs continuously from the right edge, pauses, survives handoff and greets once", () => {
  let state = createForestVillagers(world);
  configureForestVillagers(state, world, { ...config, allowLopukhArrival: false });
  assert.equal(state.residents.lopukh.available, false); assert.equal(state.lopukhArrivalPending, true);
  configureForestVillagers(state, world, config);
  const places = forestVillagerPlaces(world, "lopukh"), start = { ...state.residents.lopukh.position };
  assert.ok(start.x >= world.width - 10); assert.ok(isWalkable(places.navigation, start));
  assert.equal(state.lopukhArrivalPhase, "running");
  assert.equal(requestForestVillagerVisit(state, world, "lopukh", { id: "interrupt", position: places.home.position, size: 44 }), false);
  advanceForestVillagers(state, world, .5, { now, lopukhArrivalActive: false });
  assert.deepEqual(state.residents.lopukh.position, start);
  let frames = 0, walked = 0;
  const social = { villagers: state, elapsed: 0, social: createForestSocial("lopukh-arrival"), economyResidents: confirmedVillagers("owner", 1, 0, [], 1) };
  residentSceneSocialContext(social, now);
  while (state.lopukhArrivalPhase !== "complete" && frames++ < 600) {
    const before = { ...state.residents.lopukh.position };
    advanceForestVillagers(state, world, .05, { now, lopukhArrivalActive: true });
    const after = state.residents.lopukh.position, step = distance(before, after);
    assert.ok(step <= 39 * 3 * .05 + .001, "one distance budget per tick; no arrival teleport");
    assert.ok(canTraverse(places.navigation, before, after)); walked += step;
    if (frames === 20) {
      state = rehydrateForestVillagers(world, state, now); social.villagers = state;
      assert.deepEqual(state.residents.lopukh.position, after, "handoff retains real feet");
    }
    residentSceneSocialContext(social, now);
  }
  assert.ok(frames < 600); assert.ok(walked > 300);
  assert.equal(state.lopukhArrivalCompleted, true);
  assert.ok(distance(state.residents.lopukh.position, places.home.position) < .01);
  assert.equal(forestVillagerFrames(state).find(frame => frame.id === "lopukh").arriving, false);
  assert.deepEqual(social.social.welcomes.map(item => item.resident), ["lopukh"]);
  residentSceneSocialContext(social, now); assert.equal(social.social.welcomes.length, 1);
});

test("seen existing owners restore normally, reduced motion settles only after permission to free feet", async () => {
  const restored = createForestVillagers(world);
  configureForestVillagers(restored, world, { ...config, allowLopukhArrival: false, lopukhArrivalSeen: true });
  assert.equal(restored.lopukhArrivalPhase, "complete"); assert.equal(restored.residents.lopukh.available, true);
  const social = { villagers: restored, elapsed: 0, social: createForestSocial("restored"), economyResidents: confirmedVillagers("owner", 1, 0, [], 1) };
  residentSceneSocialContext(social, now); assert.deepEqual(social.social.welcomes ?? [], []);
  const state = createForestVillagers(world);
  configureForestVillagers(state, world, { ...config, allowLopukhArrival: false });
  assert.equal(settleForestVillagerArrival(state, [], "lopukh"), false);
  configureForestVillagers(state, world, config);
  const target = forestVillagerPlaces(world, "lopukh").home.position;
  assert.equal(settleForestVillagerArrival(state, [{ id: "mochlik", position: target, size: 50 }], "lopukh"), true);
  assert.ok(distance(state.residents.lopukh.position, target) > 0, "occupied doorstep uses another authored safe stop");
  assert.equal(state.lopukhArrivalCompleted, true);
  const session = { villagers: state }; let delivered = 0;
  announceSceneLopukhArrival(session, () => assert.fail("stale canvas cannot complete another owner’s introduction"), () => false);
  announceSceneLopukhArrival(session, () => delivered++, () => true);
  await new Promise(resolve => setImmediate(resolve));
  announceSceneLopukhArrival({ villagers: rehydrateForestVillagers(world, state, now) }, () => delivered++, () => true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(delivered, 1);
});

test("runtime fences foreign revisions, camera ownership, pause and reduced-motion arrival completion", async () => {
  const api = await modules(compactVillagerFixture()), env = browser(); let scene, probe, completions = 0;
  const owner = "lopukh-runtime", key = `zhiv:mochlik:presence:${owner}`;
  try {
    api.worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: now, presenceKey: key,
      economyBuildings: { woodlot: 0 }, economyResidents: confirmedVillagers(owner, 1, 0, [], 0),
      lopukhArrival: { seen: false, enabled: false, onComplete: () => completions++ } };
    scene = api.mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    await finishVillagerArtwork(env);
    probe = api.connectForestSession(key, api.TILED_WORLD, "circle", now, 0, () => {});
    const clock = sceneClock(env), state = probe.state;
    assert.equal(state.villagers.residents.lopukh.available, false); assert.equal(scene.inspectPoint("lopukh"), null);
    scene.configure({ ...initial, economyResidents: confirmedVillagers("foreign", 99, 0, [], 1) });
    clock.advance(.2); assert.equal(state.economyResidents.revision, 1); assert.equal(scene.lopukhArrivalPoint(), null);
    const unlocked = { ...initial, economyBuildings: { woodlot: 1 }, economyResidents: confirmedVillagers(owner, 2, 0, [], 1) };
    scene.configure(unlocked); await finishVillagerArtwork(env); clock.advance(.1);
    assert.equal(state.villagers.residents.lopukh.available, false, "a claimed station still waits for the presentation");
    const enabled = { ...unlocked, lopukhArrival: { ...initial.lopukhArrival, enabled: true } };
    scene.configure(enabled); clock.advance(.2);
    assert.equal(state.villagers.lopukhArrivalPhase, "running"); assert.ok(scene.lopukhArrivalPoint());
    scene.noticeResident("lopukh"); assert.equal(state.social.current?.speaker === "lopukh", false, "arrival cannot speak before greeting ends");
    const feet = { ...state.villagers.residents.lopukh.position };
    scene.configure({ ...enabled, paused: true }); clock.advance(2);
    assert.deepEqual(state.villagers.residents.lopukh.position, feet); assert.equal(completions, 0);
    scene.configure({ ...enabled, reducedMotion: true }); await finishVillagerArtwork(env);
    assert.equal(state.villagers.lopukhArrivalCompleted, true);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(completions, 1);
    scene.configure({ ...enabled, reducedMotion: true }); await new Promise(resolve => setImmediate(resolve)); assert.equal(completions, 1);
  } finally {
    scene?.dispose(); probe?.release(); api.forgetForestSession(key); env.restore();
  }
});
