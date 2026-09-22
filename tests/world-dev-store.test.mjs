import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createWorldDevStore, WORLD_DEV_DEFAULTS, WORLD_DEV_POSES, WORLD_DEV_ENABLED, worldDevStore } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");

test("development store starts from authored scene defaults with stable server snapshots", () => {
  const store = createWorldDevStore(true);
  assert.equal(WORLD_DEV_ENABLED, process.env.NODE_ENV === "development");
  assert.equal(worldDevStore.getSnapshot(), WORLD_DEV_DEFAULTS);
  assert.equal(store.getSnapshot(), WORLD_DEV_DEFAULTS);
  assert.deepEqual(store.getSnapshot().levels, initialPreviewLevels(TILED_WORLD));
  assert.equal(store.getServerSnapshot(), WORLD_DEV_DEFAULTS);
  store.patch({ weather: "rain", timeOfDay: "night", paused: true });
  assert.equal(store.getServerSnapshot(), WORLD_DEV_DEFAULTS);
  assert.equal(createWorldDevStore(true).getSnapshot(), WORLD_DEV_DEFAULTS);
});

test("disabled store ignores every mutation and does not register subscribers", () => {
  const store = createWorldDevStore(false);
  const unsubscribe = store.subscribe(() => assert.fail("disabled store notified a listener"));
  store.patch({ weather: "downpour", heroScale: 2, levels: { unknown: 1 } });
  store.triggerPose("greet"); store.triggerBirds(); store.triggerCamera("pet"); store.reportArtError("broken image"); store.reset();
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
  store.patch({ weather: "cloudy", equipment });
  const after = store.getSnapshot();
  assert.equal(store.getSnapshot(), after);
  assert.equal(notifications, 1);
  assert.equal(before.weather, "auto");
  assert.equal(after.weather, "cloudy");
  equipment.palette = "autumn";
  assert.equal(after.equipment.palette, "fern");
  assert.throws(() => { after.equipment.palette = "autumn"; }, TypeError);
  assert.throws(() => { after.levels.unknown = 3; }, TypeError);
  assert.throws(() => { after.heroScale = 10; }, TypeError);
  store.patch({ weather: "cloudy", equipment: { ...after.equipment }, levels: { ...after.levels } });
  assert.equal(store.getSnapshot(), after);
  assert.equal(notifications, 1);
  unsubscribe(); store.patch({ weather: "clear" });
  assert.equal(notifications, 1);
});

test("visual controls accept valid options and ignore malformed values", () => {
  const store = createWorldDevStore(true);
  const controls = { weather: "downpour", timeOfDay: "dusk", butterflies: "off", fireflies: "on", birds: "off",
    paused: true, reducedMotion: "on", pose: "fishing-walk", direction: "back", showHero: false, showBuildings: false,
    heroShadow: false, buildingShadow: false, debug: true };
  store.patch(controls);
  for (const [key, value] of Object.entries(controls)) assert.equal(store.getSnapshot()[key], value);
  const before = store.getSnapshot();
  store.patch({ weather: "storm", timeOfDay: "noon", butterflies: true, fireflies: 0, birds: null, paused: "yes",
    reducedMotion: false, pose: "dance", direction: "north", showHero: 0, showBuildings: null, heroShadow: "off",
    buildingShadow: 1, debug: undefined, equipment: { palette: "fern", head: 0, neck: null }, unknown: true });
  store.patch(null); store.patch([]); store.patch(undefined);
  assert.equal(store.getSnapshot(), before);
  assert.equal("unknown" in store.getSnapshot(), false);
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
  for (const action of ["in", "out", "overview", "pet", "pet"]) {
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
