import assert from "node:assert/strict";
import test from "node:test";
import { browser, finishVillagerArtwork, flush, mapProjection, modules, options, quietClearing, sceneClock } from "./helpers/new-map-scene.mjs";

const callbacks = { activity() {}, ready() {}, failure: assert.fail };
const shipPath = "/world/ships/trade-ship.png?v=608f97253e98";
function authority(owner, revision, lighthouse) {
  return { ownerPublicId: owner, revision, buildings: { lighthouse }, production: { ownerPublicId: owner, revision, jobs: [] } };
}

test("confirmed lighthouse queues the first ship offscreen, then an uncovered map focuses and starts exactly once", async () => {
  const { mountHabitat, createMapEngine, forgetForestSession, connectTradeShipArrival, worldDevStore } = await modules();
  const env = browser(), owner = "first-production-ship", key = `zhiv:mochlik:presence:${owner}`;
  const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key, economyResidents: authority(owner, 1, 0) };
  let circle, engine, probe;
  try {
    worldDevStore.reset(); worldDevStore.patch(quietClearing);
    circle = mountHabitat(env.surface(), initial, callbacks); await finishVillagerArtwork(env);
    probe = connectTradeShipArrival(owner, () => {});
    const clock = sceneClock(env);
    assert.equal(probe.getFrame(), null);
    // Neither a cached level nor a completed-but-unclaimed job is authoritative.
    circle.configure({ ...initial, economyBuildings: { lighthouse: 1 }, economyResidents: null,
      economyConstruction: { ownerPublicId: owner, revision: 2, jobs: [{ id: "ready", stationId: "lighthouse", targetLevel: 1,
        startedAt: new Date(0).toISOString(), finishesAt: new Date(1).toISOString() }] } });
    clock.advance(.2); assert.equal(probe.getFrame(), null);
    const unlocked = { ...initial, economyResidents: authority(owner, 2, 1) };
    circle.configure(unlocked); await finishVillagerArtwork(env);
    assert.equal(circle.tradeShipFrame().pending, true);
    const pending = probe.getFrame().motion;
    clock.advance(2); assert.equal(probe.getFrame().motion, pending, "the circle cannot consume an unseen introduction");
    const canvas = env.surface(390, 844);
    const loading = createMapEngine(canvas, { ...unlocked, tradeShipArrivalEnabled: false }, assert.fail, []);
    await finishVillagerArtwork(env); engine = await loading;
    const coveredCamera = mapProjection(canvas);
    clock.advance(.3); assert.equal(probe.getFrame().pending, true, "an overlay keeps the introduction pending");
    engine.update({ ...unlocked, tradeShipArrivalEnabled: true }); await flush();
    assert.equal(probe.getFrame().pending, false);
    assert.notDeepEqual(mapProjection(canvas), coveredCamera, "the first visible start focuses its own berth");
    clock.advance(.5); assert.ok(probe.getFrame().motion.elapsed > .4);
    engine.update({ ...unlocked, tradeShipArrivalEnabled: false });
    const covered = probe.getFrame().motion; clock.advance(.5); assert.equal(probe.getFrame().motion, covered);
    engine.update({ ...unlocked, tradeShipArrivalEnabled: true });
    clock.advance(.2); const beforeRemount = probe.getFrame().motion;
    engine.dispose(); engine = null; await flush();
    clock.advance(.5); assert.equal(probe.getFrame().motion, beforeRemount, "a circle-only owner pauses the production arrival");
    const reopening = createMapEngine(canvas, { ...unlocked, tradeShipArrivalEnabled: true }, assert.fail, []);
    await finishVillagerArtwork(env); engine = await reopening;
    assert.equal(probe.getFrame().motion, beforeRemount, "remounting cannot restart or fast-forward the intro");
    // Losing current confirmation during an unrelated optimistic action retains prior authority.
    engine.update({ ...unlocked, economyResidents: null, tradeShipArrivalEnabled: true });
    clock.advance(.2); assert.ok(probe.getFrame().motion.elapsed > beforeRemount.elapsed);
    const production = probe.getFrame().motion;
    worldDevStore.triggerTradeShip("arrive"); clock.advance(.5);
    assert.equal(probe.getFrame().motion, production, "a DEV demonstration cannot advance the production record");
    worldDevStore.patch({ tradeShipPreview: false });
    clock.until(() => probe.getFrame().motion.phase === "docked", "the real arrival deploys and becomes persistent", 500);
    assert.equal(probe.getFrame().motion.gangway, 1);
    const docked = probe.getFrame().motion;
    engine.update({ ...unlocked, economyResidents: authority(owner, 3, 0), tradeShipArrivalEnabled: true });
    assert.equal(probe.getFrame(), null, "a later confirmed locked state hides even a completed cosmetic ship");
    engine.update({ ...unlocked, economyResidents: authority(owner, 4, 1), tradeShipArrivalEnabled: true });
    await finishVillagerArtwork(env); assert.equal(probe.getFrame().motion, docked);
    engine.dispose(); engine = null; circle.dispose(); circle = null;
    const restored = mountHabitat(env.surface(), { ...unlocked, economyResidents: authority(owner, 4, 1) }, callbacks);
    circle = restored; await finishVillagerArtwork(env);
    assert.equal(circle.tradeShipFrame().motion.phase, "docked"); assert.equal(circle.tradeShipFrame().pending, false);
  } finally { engine?.dispose(); circle?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("production image failures wait, same-map reopen retries, and reduced motion settles without a hidden clock loop", async () => {
  const { mountHabitat, forgetForestSession, worldDevStore } = await modules();
  const env = browser(), owner = "ship-reduced-retry", key = `zhiv:mochlik:presence:${owner}`;
  const initial = { ...options, reducedMotion: true, view: "world", serverNow: 100_000, presenceKey: key,
    economyResidents: authority(owner, 1, 1), tradeShipArrivalEnabled: true };
  let scene;
  try {
    worldDevStore.reset(); worldDevStore.patch(quietClearing);
    scene = mountHabitat(env.surface(), initial, callbacks);
    await env.waitForImage(shipPath); env.finishPath(shipPath, true); await finishVillagerArtwork(env);
    assert.equal(scene.tradeShipFrame(), null); assert.equal(scene.startTradeShipArrival(), false);
    scene.configure({ ...initial, backgrounded: true }); scene.configure(initial);
    await finishVillagerArtwork(env);
    assert.ok(scene.tradeShipFrame()?.pending, "waking the same mounted map retries the optional PNG");
    assert.equal(scene.startTradeShipArrival(), true);
    assert.equal(scene.tradeShipFrame().motion.phase, "docked");
    for (let i = 0; i < 5; i++) { scene.configure(initial); await flush(); }
    assert.equal(scene.tradeShipFrame().motion.phase, "docked");
    assert.equal(scene.startTradeShipArrival(), false, "already settled is an idempotent no-op");
    const frozen = scene.tradeShipFrame().motion; sceneClock(env).advance(1);
    assert.equal(scene.tradeShipFrame().motion, frozen, "reduced motion never creates another animation clock");
  } finally { scene?.dispose(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("foreign views and account switches cannot borrow an owner's lighthouse or saved ship", async () => {
  const { mountHabitat, forgetForestSession, worldDevStore } = await modules();
  const env = browser(), owner = "ship-owner-isolation", key = `zhiv:mochlik:presence:${owner}`;
  const initial = { ...options, view: "world", presenceKey: key, economyResidents: authority(owner, 1, 1), tradeShipArrivalEnabled: true };
  let scene, foreign;
  try {
    worldDevStore.reset(); scene = mountHabitat(env.surface(), initial, callbacks); await finishVillagerArtwork(env);
    assert.equal(scene.startTradeShipArrival(), true); assert.equal(scene.tradeShipFrame().motion.phase, "docked");
    foreign = mountHabitat(env.surface(), { ...initial, readOnly: true }, callbacks); await finishVillagerArtwork(env);
    assert.equal(foreign.tradeShipFrame(), null); assert.equal(foreign.startTradeShipArrival(), false);
    scene.configure({ ...initial, presenceKey: "zhiv:mochlik:presence:ship-other-account", economyResidents: null });
    assert.equal(scene.tradeShipFrame(), null, "the new unconfirmed account cannot inherit eligibility or a frame");
    scene.configure({ ...initial, presenceKey: "zhiv:mochlik:presence:ship-other-account", economyResidents: authority(owner, 2, 1) });
    assert.equal(scene.tradeShipFrame(), null, "foreign confirmed data cannot unlock the current owner");
  } finally { foreign?.dispose(); scene?.dispose(); forgetForestSession(key); forgetForestSession("zhiv:mochlik:presence:ship-other-account"); worldDevStore.reset(); env.restore(); }
});

test("a reduced-motion map reveals a late optional PNG without waiting for a pan or animation frame", async () => {
  const { createMapEngine, connectTradeShipArrival, forgetForestSession, worldDevStore } = await modules();
  const env = browser(), owner = "ship-map-late-png", key = `zhiv:mochlik:presence:${owner}`;
  let engine, probe;
  try {
    worldDevStore.reset();
    const loading = createMapEngine(env.surface(390, 844), { ...options, presenceKey: key, view: "world",
      economyResidents: authority(owner, 1, 1), tradeShipArrivalEnabled: true }, assert.fail, []);
    for (let pass = 0; pass < 20 && !env.pending.some(request => request.path === shipPath); pass++) {
      for (const request of [...env.pending]) if (request.path !== shipPath) env.finishPath(request.path);
      await flush();
    }
    await env.waitForImage(shipPath);
    // Finish the required world batch while deliberately holding back the ship.
    for (let pass = 0; pass < 10; pass++) {
      for (const request of [...env.pending]) if (request.path !== shipPath) env.finishPath(request.path);
      await flush();
    }
    engine = await loading; probe = connectTradeShipArrival(owner, () => {});
    assert.equal(probe.getFrame().pending, true);
    env.finishPath(shipPath); await flush();
    assert.equal(probe.getFrame().motion.phase, "docked", "asset-ready callback repaints the outer map and settles accessibly");
    assert.equal(probe.getFrame().pending, false);
  } finally { engine?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});
