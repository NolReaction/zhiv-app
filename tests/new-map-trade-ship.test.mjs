import assert from "node:assert/strict";
import test from "node:test";
import { browser, finishVillagerArtwork, flush, modules, options, quietClearing, sceneClock } from "./helpers/new-map-scene.mjs";

const callbacks = { activity() {}, ready() {}, failure: assert.fail };
const shipPath = "/world/ships/trade-ship.png?v=608f97253e98";

test("real circle/map share the ship voyage; loading, hidden, pause and reduced motion freeze it", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore, tradeShipGangwayGeometry } = await modules();
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
    const target = env.surface();
    function bridgePainted(expected) {
      const state = worldDevStore.getTradeShipMotion();
      const geometry = tradeShipGangwayGeometry({ ...state, gangway: 1, time: probe.state.elapsed, still: false });
      target.calls.length = 0; world.paintWorld(target.context);
      const joint = target.calls.findIndex(call => call.method === "translate"
        && Math.abs(call.args[0] - geometry.from.x) < 1e-7 && Math.abs(call.args[1] - geometry.from.y) < 1e-7);
      if (!expected) { assert.equal(joint, -1, "no bridge geometry is painted before/after its stationary phases"); return; }
      const png = target.calls.findIndex(call => call.method === "drawImage" && call.args[0] === sprite);
      assert.ok(joint >= 0 && png > joint, "bridge is painted under the real PNG at its matching hinge");
      const length = Math.hypot(geometry.to.x - geometry.from.x, geometry.to.y - geometry.from.y) * state.gangway;
      assert.ok(target.calls.slice(joint, png).some(call => call.method === "fillRect"
        && call.args[0] === 0 && call.args[1] === -geometry.width / 2
        && Math.abs(call.args[2] - length) < 1e-7 && call.args[3] === geometry.width), "visible bridge length follows the shared animation");
    }
    bridgePainted(false);
    clock.until(() => worldDevStore.getTradeShipPhase() === "deploying", "the actual scene deploys only after arrival", 500);
    assert.ok(worldDevStore.getTradeShipMotion().gangway < 1e-8, "only a frame-rounding remainder may enter deployment");
    const berth = worldDevStore.getTradeShipMotion();
    clock.advance(.6);
    const deploying = worldDevStore.getTradeShipMotion();
    assert.ok(deploying.gangway > 0 && deploying.gangway < 1);
    assert.equal(deploying.x, berth.x); assert.equal(deploying.y, berth.y); bridgePainted(true);
    worldDevStore.patch({ paused: true }); const pausedBridge = worldDevStore.getTradeShipMotion();
    clock.advance(1); assert.equal(worldDevStore.getTradeShipMotion(), pausedBridge, "bridge deployment respects scene pause");
    worldDevStore.patch({ paused: false });
    clock.until(() => worldDevStore.getTradeShipPhase() === "docked", "ship becomes ready only after the bridge is fully deployed", 100);
    assert.equal(worldDevStore.getTradeShipMotion().gangway, 1); bridgePainted(true);
    assert.ok(target.calls.some(call => call.method === "drawImage" && call.args[0] === sprite), "actual world painter draws the PNG");
    worldDevStore.triggerTradeShip("depart");
    assert.equal(worldDevStore.getTradeShipPhase(), "retracting");
    assert.equal(worldDevStore.getTradeShipMotion().gangway, 1);
    clock.advance(.6); const retracting = worldDevStore.getTradeShipMotion();
    assert.ok(retracting.gangway > 0 && retracting.gangway < 1); bridgePainted(true);
    assert.equal(retracting.x, berth.x); assert.equal(retracting.y, berth.y);
    clock.until(() => worldDevStore.getTradeShipPhase() === "departing", "the actual ship waits for complete retraction before moving", 100);
    assert.equal(worldDevStore.getTradeShipMotion().gangway, 0); bridgePainted(false);
    clock.until(() => worldDevStore.getTradeShipPhase() === "departed", "ship leaves the actual scene", 500);
    target.calls.length = 0; world.paintWorld(target.context);
    assert.equal(target.calls.some(call => call.method === "drawImage" && call.args[0] === sprite), false, "departed ship is not painted");
    assert.equal(Object.keys(probe.state).some(key => /trade.?ship/i.test(key)), false, "preview never enters saved forest state");
    worldDevStore.triggerTradeShip("dock"); bridgePainted(true);
    worldDevStore.patch({ tradeShipPreview: false }); bridgePainted(false);
  } finally { world?.dispose(); circle?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("a read-only world never loads or paints the owner's DEV ship", async () => {
  const { mountHabitat, forgetForestSession, worldDevStore, tradeShipGangwayGeometry } = await modules();
  const env = browser(), key = "trade-ship-foreign-view"; let scene;
  try {
    worldDevStore.triggerTradeShip("dock");
    scene = mountHabitat(env.surface(), { ...options, reducedMotion: false, view: "world", readOnly: true, presenceKey: key }, callbacks);
    await finishVillagerArtwork(env);
    assert.equal(env.requests.some(path => path.includes("/world/ships/")), false);
    const frozen = worldDevStore.getTradeShipMotion(), clock = sceneClock(env);
    clock.advance(1); assert.equal(worldDevStore.getTradeShipMotion(), frozen);
    const geometry = tradeShipGangwayGeometry({ ...frozen, time: 0, still: true }), target = env.surface();
    scene.paintWorld(target.context);
    assert.equal(target.calls.some(call => call.method === "translate"
      && Math.abs(call.args[0] - geometry.from.x) < 1e-7 && Math.abs(call.args[1] - geometry.from.y) < 1e-7), false,
    "a foreign world also omits the owner's bridge");
  } finally { scene?.dispose(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});
