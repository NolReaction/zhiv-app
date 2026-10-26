import assert from "node:assert/strict";
import test from "node:test";
import { browser, finishVillagerArtwork, flush, modules, options, quietClearing, sceneClock } from "./helpers/new-map-scene.mjs";

const callbacks = { activity() {}, ready() {}, failure: assert.fail };
const shipPath = "/world/ships/trade-ship.png?v=608f97253e98";

test("real circle/map share the ship voyage; loading, hidden, pause and reduced motion freeze it", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore } = await modules();
  const env = browser(), key = "trade-ship-shared-owner";
  let circle, world, probe;
  const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key };
  try {
    worldDevStore.patch(quietClearing);
    circle = mountHabitat(env.surface(), initial, callbacks);
    world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks);
    await finishVillagerArtwork(env);
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerTradeShip("arrive");
    await env.waitForImage(shipPath);
    const start = worldDevStore.getTradeShipMotion();
    clock.advance(1); assert.equal(worldDevStore.getTradeShipMotion(), start, "no invisible progress while PNG is pending");
    const sprite = env.finishPath(shipPath); await flush();
    const before = probe.state.elapsed;
    clock.advance(1);
    assert.ok(worldDevStore.getTradeShipMotion().elapsed > .9);
    assert.ok(Math.abs(worldDevStore.getTradeShipMotion().elapsed - (probe.state.elapsed - before)) < 1e-8,
      "two mounted views advance the shared voyage exactly once per simulation step");
    for (const [suspend, resume, reason] of [
      [() => worldDevStore.patch({ paused: true }), () => worldDevStore.patch({ paused: false }), "DEV pause"],
      [() => env.visibility(true), () => env.visibility(false), "hidden document"],
      [() => world.configure({ ...initial, view: "world", reducedMotion: true }),
        () => world.configure({ ...initial, view: "world" }), "reduced motion"],
    ]) {
      suspend(); const frozen = worldDevStore.getTradeShipMotion();
      clock.advance(1); assert.equal(worldDevStore.getTradeShipMotion(), frozen, reason);
      resume(); assert.equal(worldDevStore.getTradeShipMotion(), frozen, `${reason} cannot catch up during configure`);
      clock.advance(.2);
    }
    const beforeSwitch = worldDevStore.getTradeShipMotion();
    world.dispose(); world = null; await flush();
    assert.equal(worldDevStore.getTradeShipMotion(), beforeSwitch, "closing map keeps the exact ship frame");
    clock.advance(.3); assert.ok(worldDevStore.getTradeShipMotion().elapsed > beforeSwitch.elapsed);
    world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks);
    await finishVillagerArtwork(env);
    assert.notEqual(worldDevStore.getTradeShipMotion().elapsed, 0, "opening map does not restart arrival");
    clock.until(() => worldDevStore.getTradeShipPhase() === "docked", "ship docks in the actual scene", 500);
    const target = env.surface(); world.paintWorld(target.context);
    assert.ok(target.calls.some(call => call.method === "drawImage" && call.args[0] === sprite), "actual world painter draws the PNG");
    worldDevStore.triggerTradeShip("depart");
    clock.until(() => worldDevStore.getTradeShipPhase() === "departed", "ship leaves the actual scene", 500);
    target.calls.length = 0; world.paintWorld(target.context);
    assert.equal(target.calls.some(call => call.method === "drawImage" && call.args[0] === sprite), false, "departed ship is not painted");
    assert.equal(Object.keys(probe.state).some(key => /trade.?ship/i.test(key)), false, "preview never enters saved forest state");
  } finally { world?.dispose(); circle?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("a read-only world never loads or paints the owner's DEV ship", async () => {
  const { mountHabitat, forgetForestSession, worldDevStore } = await modules();
  const env = browser(), key = "trade-ship-foreign-view"; let scene;
  try {
    worldDevStore.triggerTradeShip("dock");
    scene = mountHabitat(env.surface(), { ...options, reducedMotion: false, view: "world", readOnly: true, presenceKey: key }, callbacks);
    await finishVillagerArtwork(env);
    assert.equal(env.requests.some(path => path.includes("/world/ships/")), false);
    const frozen = worldDevStore.getTradeShipMotion(), clock = sceneClock(env);
    clock.advance(1); assert.equal(worldDevStore.getTradeShipMotion(), frozen);
  } finally { scene?.dispose(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});
