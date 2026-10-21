import assert from "node:assert/strict";
import test from "node:test";
import {
  browser, clearingHome, clearingHomePath, finishVillagerArtwork, flush, livingNavigation,
  modules, options, quietClearing, sceneClock, tradingFixture,
} from "./helpers/new-map-scene.mjs";

const callbacks = { activity() {}, ready() {}, failure: assert.fail };

test("only the active lesson camera defers sleep; a normal circle handoff restores the original home cycle", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    clearingActivityFrame } = await modules({ sites: [clearingHome], paths: [clearingHomePath], navigation: livingNavigation });
  const env = browser(), key = "tutorial-owner-awake"; let circle, world, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key };
    const circleCanvas = env.surface(), worldCanvas = env.surface();
    circle = mountHabitat(circleCanvas, initial, callbacks);
    world = mountHabitat(worldCanvas, { ...initial, view: "world", tutorialActive: true }, callbacks);
    await finishVillagerArtwork(env);
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, clock = sceneClock(env);
    for (let second = 0; second < 300 && state.clearing.idleSeconds < 185; second++) {
      circle.configure({ ...initial, tutorialActive: false });
      clock.advance(1);
      assert.equal(clearingActivityFrame(state.clearing).homeSleeping, false,
        "a passive circle cannot replace the world owner's lesson option");
      assert.equal(["sleep", "drowsy", "yawn"].includes(clearingActivityFrame(state.clearing).pose), false);
      circleCanvas.calls.length = worldCanvas.calls.length = 0;
    }
    assert.ok(state.clearing.idleSeconds >= 180);
    const feet = { ...state.clearing.position }, elapsed = state.clearing.elapsed;
    world.dispose(); world = null; await flush();
    assert.deepEqual(state.clearing.position, feet, "closing the lesson does not relocate the hero");
    assert.equal(state.clearing.elapsed, elapsed, "closing a view does not advance simulation time");
    clock.until(() => clearingActivityFrame(state.clearing).homeSleeping,
      "the remaining ordinary camera may send the hero home again", 1000);
  } finally { world?.dispose(); circle?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("a reduced-motion or suspended lesson cannot teleport an indoor hero or create a background wake loop", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    requestClearingSleep, clearingActivityFrame } = await modules({ sites: [clearingHome], paths: [clearingHomePath], navigation: livingNavigation });
  const env = browser(), key = "tutorial-static-awake"; let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key, view: "world" };
    scene = mountHabitat(env.surface(), initial, callbacks); await finishVillagerArtwork(env);
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, clock = sceneClock(env);
    assert.equal(requestClearingSleep(state.clearing), true);
    clock.until(() => clearingActivityFrame(state.clearing).homeSleeping, "the hero genuinely enters the house first");
    const indoors = structuredClone(state.clearing);
    for (const next of [
      { ...initial, tutorialActive: true, reducedMotion: true },
      { ...initial, tutorialActive: true, backgrounded: true },
    ]) {
      scene.configure(next); clock.advance(1);
      assert.deepEqual(state.clearing, indoors, "a frozen view cannot change doorway progress, route or clocks");
      assert.equal(env.frames.size, 0, "no recurring animation frame is introduced for the course");
    }
    scene.configure({ ...initial, tutorialActive: true });
    assert.deepEqual(state.clearing.position, indoors.position, "resuming the owner never moves feet in configure");
    let previous = { ...state.clearing.position }, sawDoor = false;
    for (let frame = 0; frame < 1000 && clearingActivityFrame(state.clearing).residing; frame++) {
      clock.step();
      const current = clearingActivityFrame(state.clearing);
      assert.ok(Math.hypot(current.x - previous.x, current.y - previous.y) <= state.clearing.size * .36 * .05 + 1e-7);
      sawDoor ||= current.opacity > 0 && current.opacity < 1;
      previous = { x: current.x, y: current.y };
    }
    assert.ok(sawDoor); assert.equal(clearingActivityFrame(state.clearing).residing, false);
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("starting and closing the lesson while walking never replace an awake hero's real shop trip", async () => {
  const { createMapEngine, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore } = await modules(tradingFixture());
  const env = browser(), key = "tutorial-keeps-existing-trip"; let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key };
    const loading = createMapEngine(env.surface(500), initial, () => {}, []);
    await finishVillagerArtwork(env); engine = await loading;
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, clock = sceneClock(env);
    assert.equal(engine.activateObject("plesk-shop"), true); clock.advance(.2);
    const visit = state.director.tradeVisit, intention = state.clearing.behavior.mind.intention;
    for (const tutorialActive of [true, false, true, false]) {
      const route = state.clearing.freeRoute, point = state.clearing.requestedPoint, feet = { ...state.clearing.position };
      engine.update({ ...initial, tutorialActive });
      assert.equal(state.director.tradeVisit, visit);
      assert.equal(state.clearing.behavior.mind.intention, intention);
      assert.equal(state.clearing.freeRoute, route); assert.equal(state.clearing.requestedPoint, point);
      assert.deepEqual(state.clearing.position, feet);
      clock.advance(.1);
    }
    clock.until(() => state.director.tradeVisit === null, "the original round trip still completes", 3000);
    assert.deepEqual(state.clearing.behavior.mind.recent.filter(item => item.key === "trade:plesk-shop").map(item => item.outcome), ["completed"]);
  } finally { engine?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});
