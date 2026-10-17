import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { browser, distanceBetween, finishVillagerArtwork, modules, options, quietClearing, sceneClock } from "./helpers/new-map-scene.mjs";
const authored = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
const cases = [
  { scenario: "narrow-passing", actor: "lopukh" }, { scenario: "occupied-door", actor: "lopukh" },
  { scenario: "carry-crossing", actor: "lopukh" }, { scenario: "work-interruption", actor: "lopukh" },
  { scenario: "work-interruption", actor: "kamneshmyg" },
  { scenario: "leaftail-arrival", actor: "leaftail" },
  ...["mochlik", "plesk", "builder", "lopukh", "kamneshmyg", "leaftail"].map(actor => ({ scenario: "home", actor })),
];
for (const [index, selection] of cases.entries()) test(`DEV actual Tiled ${selection.scenario}/${selection.actor} uses normal controllers and finishes`, async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore, rehearsalSceneOptions,
    normalizeWorldDevSceneRequest, previewWorldScene, accountSceneLevels } = await modules(structuredClone(authored));
  const env = browser(); let scene, probe;
  const request = normalizeWorldDevSceneRequest({ id: 5000 + index, seed: 17, ...selection });
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, butterflies: "off", birds: "off" });
    const original = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "unchanged-account", economyBuildings: { home: 1, quarry: 0, workshop: 1 },
      residentArrival: { seen: false, enabled: true, onComplete() { assert.fail("the real miner acknowledgement must stay outside the copy"); } },
      merchantArrival: { seen: false, enabled: true, onComplete() { assert.fail("the real merchant acknowledgement must stay outside the copy"); } } };
    const initial = rehearsalSceneOptions(original, request), surface = env.surface();
    scene = mountHabitat(surface, initial, { activity() {}, ready() {}, failure: assert.fail }); await finishVillagerArtwork(env);
    const effective = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, undefined, worldDevStore.getSnapshot(), initial.economyBuildings));
    probe = connectForestSession(initial.presenceKey, effective, "circle", 100_000, 0, () => {}, { persistence: false, sync: false });
    const state = probe.state, runtime = state.devSceneRehearsal, clock = sceneClock(env), phases = new Set(), actions = new Set();
    assert.ok(runtime); assert.equal(state.memory.enabled, false);
    const begin = { lopukh: { ...state.villagers.residents.lopukh.position }, kamneshmyg: { ...state.villagers.residents.kamneshmyg.position } };
    let previous = structuredClone(begin), maxStep = 0;
    const complete = () => {
      phases.add(runtime.stress?.phase); actions.add(state.villagers.residents.lopukh.action);
      for (const id of ["lopukh", "kamneshmyg"]) { maxStep = Math.max(maxStep, distanceBetween(previous[id], state.villagers.residents[id].position)); previous[id] = { ...state.villagers.residents[id].position }; }
      surface.calls.length = 0; return ["complete", "blocked", "stopped"].includes(runtime.preview.phase);
    };
    clock.until(complete, "the real stress/home scene reaches a finite result", 3100);
    assert.equal(runtime.preview.phase, "complete", JSON.stringify({ request, message: runtime.preview.message, stress: runtime.stress,
      actors: ["lopukh", "kamneshmyg"].map(id => { const m = state.villagers.residents[id]; return { id, position: m.position, action: m.action, door: m.doorPhase, intent: m.intent, job: m.job, wait: m.wait, target: m.target?.id, route: m.route?.length, wood: m.woodwork }; }), social: state.social.meeting }));
    assert.ok(maxStep < 4, `feet stay continuous through setup and activity (${maxStep})`);
    if (selection.scenario === "narrow-passing") { assert.ok(phases.has("staging")); assert.ok(phases.has("crossing")); }
    if (selection.scenario === "occupied-door") assert.equal(runtime.stress.sawBlockedDoor, true);
    if (selection.scenario === "carry-crossing") { assert.ok(actions.has("carry")); assert.ok(actions.has("unload")); assert.equal(runtime.stress.sawCarry, true); }
    if (selection.scenario === "work-interruption") { assert.ok(phases.has("talking")); assert.equal(runtime.stress.workStarted, true); assert.equal(state.social.lastMeetingResult.status, "interrupted"); }
    if (selection.scenario === "leaftail-arrival") assert.equal(state.leaftailBoat.completed, true);
    assert.deepEqual(original.economyBuildings, { home: 1, quarry: 0, workshop: 1 });
    const stopped = structuredClone(runtime), elapsed = state.elapsed; clock.advance(1); assert.equal(state.elapsed, elapsed); assert.deepEqual(runtime, stopped);
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(`dev:scene:${request.id}`); worldDevStore.reset(); env.restore(); }
});
