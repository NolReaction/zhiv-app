import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldDevStore, WORLD_DEV_SCENARIOS } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");
const { applyForestDevScenario } = await vite.ssrLoadModule("/features/world/dev/forest-dev-scenarios.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { advanceForestDirector } = await vite.ssrLoadModule("/features/world/simulation/forest-director.ts");
const { forestPersistenceOverridden } = await vite.ssrLoadModule("/features/world/dev/forest-dev-memory.ts");
const source = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url)));
const options = { autoLife: true, blocked: false, dusk: 1, rain: 0, homeAvailable: true };
test("presets publish atomically, preserve artwork and accessibility settings, and cannot run in production", () => {
  const store = createWorldDevStore(true); let updates = 0; store.subscribe(() => updates++);
  store.patch({ levels: { home: 4 }, heroScale: 1.12, paused: true, pose: "sleep", reducedMotion: "on" });
  const before = store.getSnapshot(); let lastId = 0;
  for (const { id } of WORLD_DEV_SCENARIOS) {
    const count = updates; store.triggerScenario(id); const state = store.getSnapshot();
    assert.equal(updates, count + 1); assert.equal(state.levels, before.levels); assert.equal(state.heroScale, 1.12);
    assert.equal(state.reducedMotion, "on"); assert.equal(state.paused, false); assert.equal(state.pose, id === "plesk" ? before.pose : "auto");
    if (id === "ground-birds") { assert.equal(state.timeOfDay, "day"); assert.equal(state.weather, "clear"); }
    assert.ok(state.scenarioEvent.id > lastId); lastId = state.scenarioEvent.id;
    assert.ok(forestPersistenceOverridden(state, before.levels));
    assert.ok(Object.isFrozen(state.scenarioEvent));
  }
  store.reset(); store.triggerScenario("birds"); assert.ok(store.getSnapshot().scenarioEvent.id > lastId);
  const current = store.getSnapshot(); store.triggerScenario("bogus"); assert.equal(store.getSnapshot(), current);
  const disabled = createWorldDevStore(false), initial = disabled.getSnapshot(); disabled.triggerScenario("campfire"); assert.equal(disabled.getSnapshot(), initial);
});
test("scenarios retain real feet, prepare repeatable birds and let the coordinator reach the fire", () => {
  const session = connectForestSession(undefined, source, "circle", 0, 0, () => {}, { persistence: false });
  const state = session.state, feet = { ...state.clearing.position };
  applyForestDevScenario(state, "birds", options);
  assert.equal(state.birdSeed, 0); assert.equal(state.birdStarted, state.elapsed); assert.deepEqual(state.clearing.position, feet);
  applyForestDevScenario(state, "ground-birds", { ...options, dusk: 0 });
  assert.equal(state.birdSeed, 6); assert.equal(state.birdStarted, state.elapsed); assert.deepEqual(state.clearing.position, feet);
  for (const fire of state.life.campfires) fire.wetness = 1;
  applyForestDevScenario(state, "campfire", options); assert.equal(state.pendingLife, "campfire"); assert.deepEqual(state.clearing.position, feet);
  for (let i = 0; i < 700 && !state.director.campfireVisit; i++) advanceForestDirector(state, .05, options);
  assert.ok(state.director.campfireVisit, state.director.reason);
  applyForestDevScenario(state, "rain", { ...options, rain: 1 }); assert.equal(state.director.campfireVisit, null);
  applyForestDevScenario(state, "tired", options); assert.equal(state.clearing.behavior.mind.needs.energy, .18);
  assert.equal(state.clearing.awakeUntil, state.clearing.elapsed); session.release();
});

test("resident checks preserve hero activity and only active overrides suspend memory", () => {
  const store = createWorldDevStore(true), levels = store.getSnapshot().levels;
  store.patch({ residentDirection: "back" }); store.triggerCamera("plesk");
  assert.equal(forestPersistenceOverridden(store.getSnapshot(), levels), false, "inspection alone does not disable persistence");
  store.triggerResident("reel");
  assert.equal(forestPersistenceOverridden(store.getSnapshot(), levels), true);
  store.patch({ residentPreview: null });
  assert.equal(forestPersistenceOverridden(store.getSnapshot(), levels), false);
  store.patch({ pose: "sleep" }); store.triggerLife("butterfly");
  const heroEvent = store.getSnapshot().lifeEvent;
  store.triggerScenario("plesk");
  assert.equal(store.getSnapshot().lifeEvent, heroEvent);
  assert.equal(store.getSnapshot().residentPreview.action, "routine");
  assert.equal(store.getSnapshot().cameraEvent.action, "plesk");
  assert.equal(store.getSnapshot().timeOfDay, "day");
  store.triggerScenario("fishing");
  assert.equal(store.getSnapshot().cameraEvent.action, "fishing");
  assert.equal(store.getSnapshot().timeOfDay, "day");
  const session = connectForestSession(undefined, source, "circle", 0, 0, () => {}, { persistence: false });
  session.state.animation = { marker: "untouched" };
  const feet = { ...session.state.clearing.position }, animation = session.state.animation;
  for (const kind of ["plesk", "fishing"]) applyForestDevScenario(session.state, kind, options);
  assert.deepEqual(session.state.clearing.position, feet);
  assert.equal(session.state.animation, animation, "dedicated scene previews do not run the clearing director");
  session.release();
});
