import assert from 'node:assert/strict';
import test from 'node:test';
import { browser, compactVillagerFixture, confirmedVillagers, finishVillagerArtwork, modules, options, quietClearing, sceneClock } from './helpers/new-map-scene.mjs';

test('the real map starts, freezes and stops a DEV rehearsal without advancing the parked account', async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore, previewWorldScene, accountSceneLevels } = await modules(compactVillagerFixture());
  const env = browser(); let engine, account, rehearsal;
  const owner = 'rehearsal-account', initial = { ...options, reducedMotion: false, serverNow: 100000,
    presenceKey: `zhiv:mochlik:presence:${owner}`, economyResidents: confirmedVillagers(owner), economyBuildings: { quarry: 1 },
    residentArrival: { seen: true, enabled: false, onComplete: assert.fail } };
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const loading = createMapEngine(env.surface(400), initial, assert.fail, []);
    await finishVillagerArtwork(env); engine = await loading;
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), initial.economyBuildings));
    account = connectForestSession(initial.presenceKey, effective, 'circle', 100000, 0, () => {});
    const natural = account.state, before = structuredClone({ elapsed: natural.elapsed, clearing: natural.clearing,
      villagers: natural.villagers, pleskMind: natural.pleskMind, builderMind: natural.builderMind });
    worldDevStore.triggerScene('walk', 'lopukh');
    await finishVillagerArtwork(env);
    const request = worldDevStore.getSnapshot().scenePreview;
    rehearsal = connectForestSession(`dev:scene:${request.id}`, effective, 'circle', 100000, 0, () => {}, { persistence: false, sync: false });
    const runtime = rehearsal.state.devSceneRehearsal, clock = sceneClock(env);
    assert.ok(runtime, 'the map switches to the actual isolated scene controller');
    assert.notEqual(rehearsal.state, natural); assert.equal(rehearsal.state.memory.enabled, false);
    clock.advance(.5);
    engine.update({ ...initial, reducedMotion: true });
    const paused = structuredClone(rehearsal.state.villagers), elapsed = rehearsal.state.elapsed;
    clock.advance(2); assert.equal(rehearsal.state.elapsed, elapsed); assert.deepEqual(rehearsal.state.villagers, paused);
    engine.update(initial);
    clock.until(() => worldDevStore.getSceneFeedback()?.phase === 'complete', 'the actual DEV walk completes', 1300);
    assert.equal(runtime.preview.phase, 'complete');
    assert.deepEqual({ elapsed: natural.elapsed, clearing: natural.clearing, villagers: natural.villagers,
      pleskMind: natural.pleskMind, builderMind: natural.builderMind }, before, 'every real actor keeps its original state');
    worldDevStore.stopScene();
    assert.equal(worldDevStore.getSnapshot().scenePreview, null);
    assert.deepEqual(natural.clearing.position, before.clearing.position);
    const previous = natural.elapsed; clock.advance(.5);
    assert.ok(natural.elapsed > previous, 'Stop returns clock ownership to the original map');
  } finally { engine?.dispose(); account?.release(); rehearsal?.release(); worldDevStore.reset(); env.restore(); }
});
