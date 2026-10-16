import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { browser, distanceBetween, finishVillagerArtwork, modules, options, quietClearing, sceneClock } from "./helpers/new-map-scene.mjs";

const authored = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
const scenarios = [
  { scenario: "walk", actor: "lopukh" },
  { scenario: "work", actor: "builder" },
  { scenario: "work", actor: "kamneshmyg" },
  { scenario: "work", actor: "lopukh" },
  { scenario: "carry", actor: "lopukh" },
  { scenario: "conversation", actor: "lopukh", target: "leaftail" },
  { scenario: "trade-visit", actor: "mochlik" },
  { scenario: "plesk-home", actor: "plesk" },
  { scenario: "butterfly", actor: "mochlik" },
  { scenario: "watch-birds", actor: "mochlik" },
];

for (const [index, selection] of scenarios.entries()) test(`isolated DEV ${selection.scenario} for ${selection.actor} finishes through the actual Tiled controllers`, async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    rehearsalSceneOptions, normalizeWorldDevSceneRequest, previewWorldScene, accountSceneLevels } = await modules(structuredClone(authored));
  const env = browser(); let scene, probe;
  const request = normalizeWorldDevSceneRequest({ id: 1000 + index, ...selection });
  const original = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "real-account-presence",
    economyJourney: { id: "real-journey", routeId: "cave", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() },
    economyBuildings: { home: 1, quarry: 0, workshop: 1 },
    onGardenHarvestEvent() { assert.fail("an isolated rehearsal cannot publish account harvests"); } };
  const originalCopy = { ...structuredClone({ ...original, onGardenHarvestEvent: undefined }), onGardenHarvestEvent: original.onGardenHarvestEvent };
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false,
      butterflies: selection.scenario === "butterfly" ? "on" : "off", birds: selection.scenario === "watch-birds" ? "on" : "off" });
    const initial = rehearsalSceneOptions(original, request), canvas = env.surface();
    scene = mountHabitat(canvas, initial, { activity() {}, ready() {}, failure: assert.fail }); await finishVillagerArtwork(env);
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), initial.economyBuildings));
    probe = connectForestSession(initial.presenceKey, effective, "circle", 100_000, 0, () => {}, { persistence: false, sync: false });
    const state = probe.state, runtime = state.devSceneRehearsal, clock = sceneClock(env);
    assert.ok(runtime); assert.equal(state.memory.enabled, false); assert.equal(state.memory.sync, undefined);
    assert.notEqual(initial.presenceKey, original.presenceKey); assert.equal(initial.economyJourney, null);
    const feet = selection.actor === "mochlik" ? state.clearing.position : selection.actor === "builder" ? state.builderMind.position
      : selection.actor === "plesk" ? state.pleskMind.position : state.villagers.residents[selection.actor].position;
    const start = { ...feet }, actions = new Set(), heard = new Map();
    if (selection.scenario === "butterfly") {
      const entity = state.fauna.entities.find(entity => entity.species === "butterfly");
      assert.ok(entity, "the test reuses an existing member of the authored population");
      Object.assign(entity, { x: state.clearing.position.x + 15, y: state.clearing.position.y - 20,
        mode: "fly", interactionToken: null, cooldownUntil: 0, alertness: 0 });
    }
    if (selection.scenario === "work" && selection.actor === "kamneshmyg") {
      const frozen = () => ({ elapsed: state.elapsed, preview: runtime.preview.elapsed,
        position: { ...state.villagers.residents.kamneshmyg.position },
        doorPhase: state.villagers.residents.kamneshmyg.doorPhase,
        doorProgress: state.villagers.residents.kamneshmyg.doorProgress,
        job: state.villagers.residents.kamneshmyg.job });
      const before = frozen();
      for (const mode of ["pause", "reduced", "hidden"]) {
        const later = rehearsalSceneOptions({ ...original, serverNow: 900_000,
          paused: mode === "pause", reducedMotion: mode === "reduced" }, request);
        assert.equal(later.serverNow, initial.serverNow, "parent wall-clock updates cannot age a synthetic job");
        assert.deepEqual(later.economyProduction.jobs, initial.economyProduction.jobs);
        scene.configure(later);
        if (mode === "hidden") env.visibility(true);
        clock.step(180_000);
        assert.deepEqual(frozen(), before, `${mode} freezes the copy beyond the synthetic job deadline`);
        if (mode === "hidden") env.visibility(false);
        scene.configure(initial);
      }
      assert.equal(state.villagers.residents.kamneshmyg.job, true);
    }
    const identities = state.fauna.entities.map(entity => entity.id), source = JSON.stringify(TILED_WORLD);
    const complete = () => {
      if (selection.actor === "lopukh") actions.add(state.villagers.residents.lopukh.action);
      for (const frame of scene.speechFrames()) heard.set(frame.id, frame);
      canvas.calls.length = 0;
      return ["complete", "blocked", "stopped"].includes(runtime.preview.phase);
    };
    clock.until(complete, `the finite ${selection.scenario} controller reaches a terminal result`, 1850);
    assert.equal(runtime.preview.phase, "complete", JSON.stringify({ message: runtime.preview.message, elapsed: runtime.preview.elapsed,
      actor: selection.actor, accepted: runtime.accepted, stage: runtime.stage, target: runtime.target,
      directorReason: state.director.reason, faunaReason: state.fauna.lastReason, pendingLife: state.pendingLife,
      clearingStage: state.clearing.stage, encounter: state.fauna.encounter,
      position: selection.actor === "mochlik" ? state.clearing.position : selection.actor === "builder" ? state.builderMind.position
        : selection.actor === "plesk" ? state.pleskMind.position : state.villagers.residents[selection.actor].position }));
    if (selection.scenario === "walk") assert.ok(distanceBetween(start, state.villagers.residents.lopukh.position) > 20);
    if (selection.scenario === "work" && selection.actor === "kamneshmyg") assert.equal(state.villagers.residents.kamneshmyg.doorPhase, "inside");
    if (selection.scenario === "carry") {
      assert.ok(actions.has("carry")); assert.ok(actions.has("unload"));
      assert.ok(state.villagers.residents.lopukh.woodwork.completedCycles > 0);
    }
    if (selection.scenario === "conversation" || selection.scenario === "trade-visit") {
      assert.equal(state.social.lastMeetingResult?.status, "completed"); assert.equal(heard.size, 4);
    }
    if (selection.scenario === "plesk-home") assert.equal(state.pleskMind.home.phase, "inside");
    if (selection.scenario === "butterfly") { assert.equal(runtime.sawAction, true); assert.ok(runtime.animalToken); }
    if (selection.scenario === "watch-birds") { assert.equal(runtime.sawAction, true); assert.ok(runtime.birdId); }
    assert.deepEqual(state.fauna.entities.map(entity => entity.id), identities);
    assert.equal(JSON.stringify(TILED_WORLD), source); assert.deepEqual(original, originalCopy);
    const elapsed = state.elapsed, result = structuredClone(runtime); clock.advance(2);
    assert.equal(state.elapsed, elapsed, "a terminal isolated scene stops its owner clock"); assert.deepEqual(runtime, result);
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(`dev:scene:${request.id}`); worldDevStore.reset(); env.restore(); }
});
