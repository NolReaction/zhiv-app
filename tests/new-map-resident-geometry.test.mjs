import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { browser, finishVillagerArtwork, modules, options, quietClearing, sceneClock } from "./helpers/new-map-scene.mjs";

test("an unrelated house upgrade preserves Pleska's feet and active clock in an independent geometry session", async () => {
  const authored = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const { mountHabitat, connectForestSession, forgetForestSession, previewWorldScene, accountSceneLevels,
    worldDevStore, requestPleskWalk, pleskLocalPlaces, canTraverse, PLESK, TILED_WORLD } = await modules(authored);
  const env = browser(), key = "pleska-geometry-continuity", probes = []; let scene;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000,
      presenceKey: key, economyBuildings: { home: 1, quarry: 0, woodlot: 1 } };
    const effective = buildings => previewWorldScene(TILED_WORLD,
      accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), buildings));
    const firstWorld = effective(initial.economyBuildings);
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    await finishVillagerArtwork(env);
    const probe = connectForestSession(key, firstWorld, "circle", 100_000, 0, () => {}); probes.push(probe);
    const previous = probe.state.pleskMind, places = pleskLocalPlaces(firstWorld);
    assert.ok(requestPleskWalk(previous, firstWorld, places.rest));
    const clock = sceneClock(env); clock.advance(3);
    const feet = { ...previous.position }, elapsed = previous.elapsed, caught = previous.catchCount;
    const nextOptions = { ...initial, economyBuildings: { ...initial.economyBuildings, home: 2 } };
    const nextWorld = effective(nextOptions.economyBuildings);
    assert.deepEqual(firstWorld.sites.find(site => site.id === "plesk-shop"), nextWorld.sites.find(site => site.id === "plesk-shop"));
    scene.configure(nextOptions); await finishVillagerArtwork(env);
    const nextProbe = connectForestSession(key, nextWorld, "circle", 100_000, 0, () => {}); probes.push(nextProbe);
    const next = nextProbe.state.pleskMind;
    assert.notEqual(nextProbe.state, probe.state); assert.notEqual(next, previous);
    assert.deepEqual(next.position, feet, "another building's geometry cannot teleport the fisher");
    assert.equal(next.elapsed, elapsed); assert.equal(next.catchCount, caught);
    assert.equal(next.stage.target.id, places.rest.id);
    for (let frame = 0; frame < 20; frame++) {
      const before = { ...next.position }; clock.advance(.05);
      assert.ok(Math.hypot(next.position.x - before.x, next.position.y - before.y) <= PLESK.speed * .05 + .001);
      assert.ok(canTraverse(pleskLocalPlaces(nextWorld).nav, before, next.position));
    }
    assert.ok(next.elapsed > elapsed); assert.notDeepEqual(next.position, feet);
    assert.deepEqual(previous.position, feet); assert.equal(previous.elapsed, elapsed, "the old mounted session keeps independent clocks and feet");
  } finally {
    scene?.dispose(); probes.forEach(probe => probe.release()); forgetForestSession(key); worldDevStore.reset(); env.restore();
  }
});

test("a geometry handoff joins an existing Pleska session without replacing its pending customer", async () => {
  const authored = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const { mountHabitat, connectForestSession, forgetForestSession, previewWorldScene, accountSceneLevels,
    worldDevStore, requestPleskTrade, TILED_WORLD } = await modules(authored);
  const env = browser(), key = "pleska-geometry-existing", probes = []; let scene;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000,
      presenceKey: key, economyBuildings: { home: 1, quarry: 0, woodlot: 1 } };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    await finishVillagerArtwork(env);
    const nextOptions = { ...initial, economyBuildings: { ...initial.economyBuildings, home: 2 } };
    const nextWorld = previewWorldScene(TILED_WORLD,
      accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), nextOptions.economyBuildings));
    const existing = connectForestSession(key, nextWorld, "circle", 100_000, 0, () => {}); probes.push(existing);
    assert.equal(existing.created, true);
    const mind = existing.state.pleskMind; requestPleskTrade(mind);
    assert.equal(mind.tradePending, true); assert.equal(mind.elapsed, 0);
    scene.configure(nextOptions); await finishVillagerArtwork(env);
    const joined = connectForestSession(key, nextWorld, "circle", 100_000, 0, () => {}); probes.push(joined);
    assert.equal(joined.created, false); assert.equal(joined.state.pleskMind, mind);
    assert.equal(mind.tradePending, true, "a newly joined camera cannot replace another session's invitation");
    assert.equal(mind.elapsed, 0);
  } finally {
    scene?.dispose(); probes.forEach(probe => probe.release()); forgetForestSession(key); worldDevStore.reset(); env.restore();
  }
});
