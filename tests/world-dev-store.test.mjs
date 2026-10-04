import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldDevStore, WORLD_DEV_DEFAULTS, WORLD_DEV_POSES, WORLD_DEV_RESIDENT_ACTIONS, WORLD_DEV_ENABLED, worldDevStore } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");

test("development store starts from authored scene defaults with stable server snapshots", () => {
  const store = createWorldDevStore(true);
  assert.equal(WORLD_DEV_ENABLED, process.env.NODE_ENV === "development");
  assert.equal(worldDevStore.getSnapshot(), WORLD_DEV_DEFAULTS);
  assert.equal(store.getSnapshot(), WORLD_DEV_DEFAULTS);
  assert.equal(store.getSnapshot().autoLife, true);
  assert.equal(store.getSnapshot().puddles, true);
  assert.equal(store.getSnapshot().waterBreeze, true);
  assert.equal(store.getSnapshot().waterFish, "auto");
  assert.equal(store.getSnapshot().cookingPreview, null);
  assert.equal(store.getSnapshot().lifeEvent, null);
  assert.deepEqual(store.getSnapshot().levels, initialPreviewLevels(TILED_WORLD));
  assert.equal(store.getServerSnapshot(), WORLD_DEV_DEFAULTS);
  store.patch({ weather: "rain", timeOfDay: "night", paused: true });
  assert.equal(store.getServerSnapshot(), WORLD_DEV_DEFAULTS);
  assert.equal(createWorldDevStore(true).getSnapshot(), WORLD_DEV_DEFAULTS);
});

test("disabled store ignores every mutation and does not register subscribers", () => {
  const store = createWorldDevStore(false);
  const unsubscribe = store.subscribe(() => assert.fail("disabled store notified a listener"));
  store.patch({ weather: "downpour", heroScale: 2, levels: { unknown: 1 }, autoLife: false, puddles: false,
    debugWater: true, debugNavigation: true, debugFauna: true, navigationMode: "routes" });
  store.triggerPose("greet"); store.triggerLife("butterfly"); store.triggerLife("bush"); store.triggerLife("idle");
  for (const kind of ["water-bush", "harvest-berries", "grow-berries"]) store.triggerLife(kind);
  store.triggerBirds(); store.triggerCamera("pet"); store.reportArtError("broken image"); store.reset();
  store.triggerResident("cast", true); store.triggerScenario("plesk"); store.triggerScenario("fishing");
  store.triggerCooking("sequence", true);
  assert.equal(store.getSnapshot(), WORLD_DEV_DEFAULTS);
  assert.equal(store.getServerSnapshot(), WORLD_DEV_DEFAULTS);
  unsubscribe(); unsubscribe();
});

test("snapshots are immutable and only real changes notify subscribed listeners", () => {
  const store = createWorldDevStore(true);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  store.patch({}); store.patch({ ...WORLD_DEV_DEFAULTS }); store.reset();
  assert.equal(notifications, 0);
  const before = store.getSnapshot();
  const equipment = { palette: "fern", head: "leaf_hat", neck: null };
  store.patch({ weather: "drizzle", equipment });
  const after = store.getSnapshot();
  assert.equal(store.getSnapshot(), after);
  assert.equal(notifications, 1);
  assert.equal(before.weather, "auto");
  assert.equal(after.weather, "drizzle");
  equipment.palette = "autumn";
  assert.equal(after.equipment.palette, "fern");
  assert.throws(() => { after.equipment.palette = "autumn"; }, TypeError);
  assert.throws(() => { after.levels.unknown = 3; }, TypeError);
  assert.throws(() => { after.heroScale = 10; }, TypeError);
  store.patch({ weather: "drizzle", equipment: { ...after.equipment }, levels: { ...after.levels } });
  assert.equal(store.getSnapshot(), after);
  assert.equal(notifications, 1);
  unsubscribe(); store.patch({ weather: "clear" });
  assert.equal(notifications, 1);
});

test("visual controls accept valid options and ignore malformed values", () => {
  const store = createWorldDevStore(true);
  const controls = { weather: "downpour", timeOfDay: "night", butterflies: "off", fireflies: "on", birds: "off", waterFish: "on", waterBreeze: false,
    paused: true, autoLife: false, puddles: false, reducedMotion: "on", pose: "fishing-walk", direction: "back", showHero: false, showBuildings: false,
    heroShadow: false, buildingShadow: false, debug: true, debugWater: true,
    debugNavigation: true, debugFauna: true, navigationMode: "routes" };
  store.patch(controls);
  for (const [key, value] of Object.entries(controls)) assert.equal(store.getSnapshot()[key], value);
  const before = store.getSnapshot();
  store.patch({ weather: "storm", timeOfDay: "noon", butterflies: true, fireflies: 0, birds: null, waterFish: true, waterBreeze: "yes", paused: "yes",
    reducedMotion: false, autoLife: "yes", puddles: 1, pose: "dance", direction: "north", showHero: 0, showBuildings: null, heroShadow: "off",
    buildingShadow: 1, debug: undefined, debugWater: "true", debugNavigation: 1, debugFauna: "on", navigationMode: "free",
    equipment: { palette: "fern", head: 0, neck: null }, unknown: true });
  store.patch(null); store.patch([]); store.patch(undefined);
  assert.equal(store.getSnapshot(), before);
  assert.equal("unknown" in store.getSnapshot(), false);
});

test("visual controls offer only day and night, with dry weather or rain intensity", () => {
  const store = createWorldDevStore(true);
  for (const timeOfDay of ["day", "night", "auto"]) {
    store.patch({ timeOfDay });
    assert.equal(store.getSnapshot().timeOfDay, timeOfDay);
  }
  for (const weather of ["clear", "drizzle", "rain", "downpour", "auto"]) {
    store.patch({ weather });
    assert.equal(store.getSnapshot().weather, weather);
  }
  const before = store.getSnapshot();
  store.patch({ weather: "cloudy", timeOfDay: "dusk" });
  assert.equal(store.getSnapshot(), before, "removed cloud and dusk presets cannot be restored by an old control");
});

test("water outlines switch independently from general map markup and reset with the view", () => {
  const store = createWorldDevStore(true);
  assert.equal(store.getSnapshot().debugWater, false);
  store.patch({ debugWater: true });
  assert.equal(store.getSnapshot().debugWater, true);
  assert.equal(store.getSnapshot().debug, false);
  store.patch({ debug: true, debugWater: false });
  assert.equal(store.getSnapshot().debug, true);
  assert.equal(store.getSnapshot().debugWater, false);
  store.patch({ debugWater: true });
  store.reset();
  assert.equal(store.getSnapshot().debug, false);
  assert.equal(store.getSnapshot().debugWater, false);
});

test("navigation and fauna diagnostics are independent ephemeral views", () => {
  const store = createWorldDevStore(true);
  assert.equal(store.getSnapshot().debugNavigation, false);
  assert.equal(store.getSnapshot().debugFauna, false);
  assert.equal(store.getSnapshot().navigationMode, "auto");
  store.patch({ debugNavigation: true, navigationMode: "routes" });
  assert.equal(store.getSnapshot().debugNavigation, true);
  assert.equal(store.getSnapshot().debugFauna, false);
  assert.equal(store.getSnapshot().debug, false);
  assert.equal(store.getSnapshot().debugWater, false);
  store.patch({ debugNavigation: false, debugFauna: true });
  assert.equal(store.getSnapshot().debugNavigation, false);
  assert.equal(store.getSnapshot().debugFauna, true);
  assert.equal(store.getSnapshot().navigationMode, "routes");
  assert.equal(createWorldDevStore(true).getSnapshot(), WORLD_DEV_DEFAULTS, "another mount has no persisted overrides");
  store.reset();
  assert.equal(store.getSnapshot(), WORLD_DEV_DEFAULTS);
});

test("hero scale clamps finite values without accepting non-numeric input", () => {
  const store = createWorldDevStore(true);
  store.patch({ heroScale: -100 }); assert.equal(store.getSnapshot().heroScale, .5);
  store.patch({ heroScale: 100 }); assert.equal(store.getSnapshot().heroScale, 2);
  store.patch({ heroScale: 1.25 }); assert.equal(store.getSnapshot().heroScale, 1.25);
  const before = store.getSnapshot();
  for (const value of [NaN, Infinity, -Infinity, "1", null, undefined]) store.patch({ heroScale: value });
  assert.equal(store.getSnapshot(), before);
});

test("building overrides accept only authored site states and preserve untouched levels", () => {
  const store = createWorldDevStore(true);
  const sceneBefore = structuredClone(TILED_WORLD);
  for (const site of TILED_WORLD.sites) {
    for (const visual of site.states) {
      const before = store.getSnapshot();
      const levels = { [site.id]: visual.level, unknown: 123 };
      store.patch({ levels });
      assert.equal(store.getSnapshot().levels[site.id], visual.level);
      assert.equal("unknown" in store.getSnapshot().levels, false);
      for (const other of TILED_WORLD.sites.filter(other => other.id !== site.id)) {
        assert.equal(store.getSnapshot().levels[other.id], before.levels[other.id]);
      }
      levels[site.id] = -999;
      assert.equal(store.getSnapshot().levels[site.id], visual.level);
    }
    const before = store.getSnapshot();
    for (const level of [-999, NaN, Infinity, 1.5, "1", null]) store.patch({ levels: { [site.id]: level } });
    assert.equal(store.getSnapshot(), before);
  }
  store.patch({ levels: { unknown: 3 } });
  assert.deepEqual(Object.keys(store.getSnapshot().levels).sort(), TILED_WORLD.sites.map(site => site.id).sort());
  assert.deepEqual(TILED_WORLD, sceneBefore);
});

test("repeated pose and bird actions use increasing IDs even after a reset", () => {
  const store = createWorldDevStore(true);
  let notifications = 0;
  store.subscribe(() => notifications++);
  store.triggerPose("greet"); const first = store.getSnapshot().animation;
  store.triggerPose("greet"); const second = store.getSnapshot().animation;
  assert.ok(second.id > first.id);
  assert.equal(second.pose, "greet");
  assert.throws(() => { second.id = 999; }, TypeError);
  store.triggerBirds(); const firstBird = store.getSnapshot().birdEvent;
  store.triggerBirds(); const secondBird = store.getSnapshot().birdEvent;
  assert.ok(secondBird > firstBird);
  store.reset(); assert.equal(store.getSnapshot(), WORLD_DEV_DEFAULTS);
  store.triggerPose("greet"); store.triggerBirds();
  assert.ok(store.getSnapshot().animation.id > second.id);
  assert.ok(store.getSnapshot().birdEvent > secondBird);
  assert.equal(notifications, 7);
  const before = store.getSnapshot();
  store.triggerPose("dance"); store.triggerPose("auto");
  store.patch({ animation: { id: 999, pose: "jump" }, birdEvent: 999, artError: "arbitrary error" });
  assert.equal(store.getSnapshot(), before);
});

test("every supported pixel pose can be held and triggered", () => {
  const store = createWorldDevStore(true);
  assert.equal(new Set(WORLD_DEV_POSES).size, WORLD_DEV_POSES.length);
  for (const pose of WORLD_DEV_POSES) {
    store.patch({ pose }); store.triggerPose(pose);
    assert.equal(store.getSnapshot().pose, pose);
    assert.equal(store.getSnapshot().animation.pose, pose);
  }
  store.patch({ pose: "auto" }); assert.equal(store.getSnapshot().pose, "auto");
});

test("life events are immutable, validated and repeat with new IDs across resets", () => {
  const store = createWorldDevStore(true);
  let previousId = 0;
  for (const kind of ["butterfly", "firefly", "mushroom", "leaf", "bush", "home-sleep", "wake", "grow-mushrooms", "water-bush", "harvest-berries", "grow-berries", "watch-birds", "idle", "idle"]) {
    const before = store.getSnapshot();
    store.triggerLife(kind);
    const after = store.getSnapshot();
    assert.notEqual(after, before);
    assert.equal(after.lifeEvent.kind, kind);
    assert.ok(after.lifeEvent.id > previousId);
    previousId = after.lifeEvent.id;
    assert.throws(() => { after.lifeEvent.kind = "firefly"; }, TypeError);
    assert.throws(() => { after.lifeEvent.id = 999; }, TypeError);
  }
  const beforeInvalid = store.getSnapshot();
  for (const kind of ["dance", "auto", "", null, undefined, {}, 1]) store.triggerLife(kind);
  for (const lifeEvent of [{ id: 999, kind: "butterfly" }, {}, "idle", 1]) store.patch({ lifeEvent });
  assert.equal(store.getSnapshot(), beforeInvalid);
  store.patch({ lifeEvent: null });
  assert.equal(store.getSnapshot().lifeEvent, null);
  assert.equal(beforeInvalid.lifeEvent.kind, "idle", "cancelling preserves the earlier immutable snapshot");
  store.reset();
  assert.equal(store.getSnapshot(), WORLD_DEV_DEFAULTS);
  store.triggerLife("butterfly");
  assert.ok(store.getSnapshot().lifeEvent.id > previousId);
});

test("life actions atomically replace held poses and gestures, and idle disables automatic life", () => {
  const store = createWorldDevStore(true);
  store.patch({ pose: "sleep" });
  store.triggerPose("greet");
  const poseSnapshot = store.getSnapshot();
  const events = [];
  store.subscribe(() => events.push(store.getSnapshot()));
  store.triggerLife("mushroom");
  assert.equal(events.length, 1);
  assert.equal(events[0].pose, "auto");
  assert.equal(events[0].animation, null);
  assert.equal(events[0].lifeEvent.kind, "mushroom");
  assert.equal(events[0].autoLife, true);
  assert.equal(poseSnapshot.pose, "sleep");
  assert.equal(poseSnapshot.animation.pose, "greet");
  store.triggerLife("idle");
  assert.equal(events.length, 2);
  assert.equal(events[1].lifeEvent.kind, "idle");
  assert.equal(events[1].autoLife, false);
  store.triggerLife("firefly");
  assert.equal(store.getSnapshot().autoLife, false, "manual actions do not silently restart automatic life");
});

test("one-shot and held poses cancel life events without accepting forged replacements", () => {
  const store = createWorldDevStore(true);
  store.triggerLife("butterfly");
  const first = store.getSnapshot().lifeEvent;
  store.triggerPose("jump");
  assert.equal(store.getSnapshot().lifeEvent, null);
  assert.equal(store.getSnapshot().animation.pose, "jump");
  store.triggerLife("firefly");
  const second = store.getSnapshot().lifeEvent;
  assert.ok(second.id > first.id);
  store.patch({ pose: "sleep", lifeEvent: { id: 999, kind: "mushroom" } });
  assert.equal(store.getSnapshot().lifeEvent, null);
  assert.equal(store.getSnapshot().pose, "sleep");
  store.triggerLife("butterfly");
  const beforeInvalid = store.getSnapshot();
  store.patch({ pose: "dance" });
  store.triggerPose("dance");
  assert.equal(store.getSnapshot(), beforeInvalid, "invalid poses cannot cancel a life event");
});

test("selecting a held pose cancels a manual gesture without reusing its event ID", () => {
  const store = createWorldDevStore(true);
  store.triggerPose("greet");
  const first = store.getSnapshot().animation;
  let notifications = 0;
  store.subscribe(() => notifications++);
  store.patch({ pose: "sleep", animation: null });
  const cancelled = store.getSnapshot();
  assert.equal(cancelled.pose, "sleep");
  assert.equal(cancelled.animation, null);
  assert.equal(notifications, 1, "pose and cancellation publish atomically");
  store.patch({ animation: null });
  store.patch({ animation: { id: first.id, pose: "greet" } });
  assert.equal(store.getSnapshot(), cancelled);
  assert.equal(notifications, 1);
  store.triggerPose("greet");
  const second = store.getSnapshot().animation;
  assert.ok(second.id > first.id);
  store.reset();
  assert.equal(store.getSnapshot(), WORLD_DEV_DEFAULTS);
  store.triggerPose("greet");
  assert.ok(store.getSnapshot().animation.id > second.id);
});

test("camera events validate actions and keep increasing IDs across reset", () => {
  const store = createWorldDevStore(true);
  let previousId = 0;
  for (const action of ["in", "out", "overview", "pet", "plesk", "fishing", "pet"]) {
    store.triggerCamera(action);
    const event = store.getSnapshot().cameraEvent;
    assert.equal(event.action, action);
    assert.ok(event.id > previousId);
    assert.throws(() => { event.action = "in"; }, TypeError);
    previousId = event.id;
  }
  store.reset(); assert.equal(store.getSnapshot().cameraEvent, null);
  store.triggerCamera("pet"); assert.ok(store.getSnapshot().cameraEvent.id > previousId);
  const before = store.getSnapshot();
  store.triggerCamera("teleport"); store.patch({ cameraEvent: { id: 999, action: "in" } });
  assert.equal(store.getSnapshot(), before);
});

test("art error reporting is transient and reset restores every default", () => {
  const store = createWorldDevStore(true);
  let notifications = 0;
  store.subscribe(() => notifications++);
  store.reportArtError("Unable to load house"); store.reportArtError("Unable to load house");
  assert.equal(notifications, 1);
  assert.equal(store.getSnapshot().artError, "Unable to load house");
  store.reportArtError(null); assert.equal(store.getSnapshot().artError, null);
  store.patch({ paused: true, debug: true, heroScale: 2, equipment: { palette: "autumn", head: null, neck: "amber_scarf" } });
  store.reportArtError("another image"); store.triggerPose("jump"); store.triggerBirds();
  store.reset(); assert.equal(store.getSnapshot(), WORLD_DEV_DEFAULTS);
  store.patch({ equipment: { palette: "moss", head: null, neck: null } });
  store.patch({ equipment: null }); assert.equal(store.getSnapshot().equipment, null);
});

test("Plesk actions use isolated immutable previews, independent direction and replay IDs", () => {
  const store = createWorldDevStore(true);
  store.patch({ direction: "back", residentDirection: "right", pose: "sleep", paused: true, reducedMotion: "on" });
  let previousId = 0;
  for (const action of [...WORLD_DEV_RESIDENT_ACTIONS, "routine"]) {
    let updates = 0; const unsubscribe = store.subscribe(() => updates++);
    store.triggerResident(action, true);
    const state = store.getSnapshot();
    assert.equal(updates, 1, "preview and camera update together"); unsubscribe();
    assert.equal(state.residentPreview.action, action);
    assert.equal(state.residentPreview.direction, "right");
    assert.equal(state.residentPreview.repeat, true);
    assert.ok(state.residentPreview.id > previousId); previousId = state.residentPreview.id;
    assert.equal(state.cameraEvent.action, "plesk");
    assert.equal(state.pose, "sleep"); assert.equal(state.direction, "back");
    assert.equal(state.paused, true); assert.equal(state.reducedMotion, "on");
    assert.ok(Object.isFrozen(state.residentPreview));
  }
  const active = store.getSnapshot().residentPreview;
  store.patch({ residentDirection: "left" });
  assert.equal(store.getSnapshot().residentPreview.id, active.id, "turning never restarts animation time");
  assert.equal(store.getSnapshot().residentPreview.direction, "left");
  assert.equal(active.direction, "right", "old snapshots remain unchanged");
  store.triggerResident("catch");
  assert.equal(store.getSnapshot().residentPreview.repeat, false);
  assert.ok(store.getSnapshot().residentPreview.id > previousId);
  previousId = store.getSnapshot().residentPreview.id;
  store.patch({ residentPreview: null }); assert.equal(store.getSnapshot().residentPreview, null);
  store.reset(); store.triggerResident("catch");
  assert.ok(store.getSnapshot().residentPreview.id > previousId);
  const beforeInvalid = store.getSnapshot();
  for (const action of ["dance", "auto", null, undefined, {}, 1]) store.triggerResident(action);
  store.triggerResident("walk", "yes");
  store.patch({ residentDirection: "north", residentPreview: { id: 999, action: "cast", direction: "back", repeat: true } });
  assert.equal(store.getSnapshot(), beforeInvalid, "patching cannot forge an event or unsupported direction");
});

test("cooking previews replace competing hero actions atomically and validate replay events", () => {
  const store = createWorldDevStore(true);
  store.patch({ paused: true, reducedMotion: "on", pose: "sleep", autoLife: false });
  store.triggerScenario("fishing");
  store.triggerPose("greet");
  let previousId = 0;
  for (const action of ["sequence", "prepare", "stir", "taste", "serve"]) {
    let updates = 0;
    const unsubscribe = store.subscribe(() => updates++);
    store.triggerCooking(action, true);
    const state = store.getSnapshot();
    unsubscribe(); assert.equal(updates, 1, "the preview and camera change in one publish");
    assert.deepEqual(state.cookingPreview, { id: state.cookingPreview.id, action, repeat: true });
    assert.ok(state.cookingPreview.id > previousId); previousId = state.cookingPreview.id;
    assert.ok(Object.isFrozen(state.cookingPreview));
    assert.equal(state.pose, "auto"); assert.equal(state.animation, null);
    assert.equal(state.lifeEvent, null); assert.equal(state.scenarioEvent, null);
    assert.equal(state.cameraEvent.action, "pet");
  }
  const valid = store.getSnapshot();
  for (const action of ["fish", "auto", "", null, undefined, {}, 1]) store.triggerCooking(action);
  store.triggerCooking("prepare", "yes");
  store.patch({ cookingPreview: { id: 999, action: "stir", repeat: true } });
  assert.equal(store.getSnapshot(), valid, "patches cannot forge a clock or invalid cooking action");
  store.patch({ cookingPreview: null }); assert.equal(store.getSnapshot().cookingPreview, null);
  store.triggerCooking("serve"); assert.equal(store.getSnapshot().cookingPreview.repeat, false);
  for (const replace of [() => store.triggerPose("greet"), () => store.triggerLife("idle"),
    () => store.patch({ pose: "sleep" }), () => store.triggerScenario("fishing")]) {
    store.triggerCooking("sequence"); replace();
    assert.equal(store.getSnapshot().cookingPreview, null, "another explicit hero action cancels cooking");
  }
  store.reset(); store.triggerCooking("stir");
  assert.ok(store.getSnapshot().cookingPreview.id > previousId, "reset cannot reuse an already consumed event ID");
});

test("water fish and breeze controls are independent validated visual preferences", () => {
  const store = createWorldDevStore(true);
  for (const waterFish of ["off", "on", "auto"]) {
    store.patch({ waterFish, waterBreeze: false });
    assert.equal(store.getSnapshot().waterFish, waterFish);
    assert.equal(store.getSnapshot().waterBreeze, false);
    assert.equal(store.getSnapshot().birds, "auto");
    assert.equal(store.getSnapshot().weather, "auto");
  }
  const valid = store.getSnapshot();
  for (const waterFish of [true, false, "many", null, 3]) store.patch({ waterFish });
  for (const waterBreeze of ["off", null, 1]) store.patch({ waterBreeze });
  assert.equal(store.getSnapshot(), valid);
  store.reset(); assert.equal(store.getSnapshot().waterFish, "auto"); assert.equal(store.getSnapshot().waterBreeze, true);
});
