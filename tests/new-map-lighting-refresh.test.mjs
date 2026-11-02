import assert from "node:assert/strict";
import test from "node:test";
import { browser, builderMemoryServer, fishingFixture, fixture, flush, livingNavigation, modules, options, quietClearing } from "./helpers/new-map-scene.mjs";

test("saved torch moves refresh both live cameras and physical navigation without remounting or mutating old geometry", async () => {
  const torch = { id: "live-torch", kind: "torch", position: { x: 600, y: 674 }, radius: 50,
    intensity: .6, color: "#ffcd84", flicker: 0, height: 20 };
  // Conditional geometry exercises the effective-scene cache, not only the root.
  const navigation = { ...livingNavigation, obstacles: [{ id: "hidden-wall", when: { siteId: "home", level: 2 },
    points: [{ x: 575, y: 615 }, { x: 580, y: 615 }, { x: 580, y: 620 }] }] };
  const { mountHabitat, worldDevStore, worldLightingEditorStore: editor, connectForestSession,
    TILED_WORLD, refreshWorldLighting, previewWorldScene, isWalkable } = await modules({ lights: [torch], navigation });
  const env = browser(), scenes = [], probes = [];
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "live-lighting-account" };
    let ready = 0;
    const callbacks = { activity() {}, ready() { ready++; }, failure: assert.fail };
    for (const view of ["circle", "world"]) scenes.push(mountHabitat(env.surface(), { ...initial, view }, callbacks));
    env.finish(); await flush();
    const initialWorld = previewWorldScene(TILED_WORLD, {});
    assert.notEqual(initialWorld, TILED_WORLD);
    const probe = scene => {
      const value = connectForestSession(initial.presenceKey, previewWorldScene(scene, {}), "circle", 0, 0, () => {});
      probes.push(value); return value;
    };
    const original = probe(TILED_WORLD), before = { x: 600, y: 690.5 }, after = { x: 690, y: 690.5 };
    assert.equal(isWalkable(original.state.clearing.navigation, before), false);
    assert.equal(isWalkable(original.state.clearing.navigation, after), true);
    const requests = env.requests.length;
    editor.selectLight(torch.id); editor.patchLight({ position: { x: 690, y: 674 } });
    const moved = { ...TILED_WORLD, lights: [{ ...torch, position: { x: 690, y: 674 } }] };
    assert.equal(refreshWorldLighting(moved), true);
    editor.reconcileProjectBaseline(moved);
    await flush();
    const updated = probe(moved);
    assert.notEqual(updated.state, original.state, "new post position retires old routes");
    assert.equal(isWalkable(updated.state.clearing.navigation, before), true);
    assert.equal(isWalkable(updated.state.clearing.navigation, after), false);
    assert.equal(isWalkable(original.state.clearing.navigation, before), false, "retired world is immutable");
    for (const view of scenes) assert.deepEqual(view.lightingLights().find(light => light.id === torch.id).position, { x: 690, y: 674 });
    assert.equal(env.frames.size, 1, "two mounted cameras share the replacement clock");
    assert.equal(editor.getSnapshot().selectedId, torch.id);
    assert.equal(editor.getSnapshot().canUndo, true);
    assert.equal(ready, 2, "neither canvas remounted");
    assert.equal(env.requests.length, requests, "moving a post needs no new artwork requests");
    const brighter = { ...moved, lights: [{ ...moved.lights[0], intensity: .8 }] };
    assert.equal(refreshWorldLighting(brighter), true);
    editor.adoptProjectScene(brighter); await flush();
    assert.equal(probe(brighter).state, updated.state, "flame edits keep the exact simulation");
    const removed = { ...brighter, lights: [] };
    assert.equal(refreshWorldLighting(removed), true);
    editor.adoptProjectScene(removed); await flush();
    assert.equal(isWalkable(probe(removed).state.clearing.navigation, after), true);
    assert.equal(env.frames.size, 1);
    assert.equal(ready, 2);
    assert.equal(refreshWorldLighting({ ...removed, actor: { ...removed.actor, spawn: { x: 640, y: 660 } } }), false);
    scenes.forEach(scene => scene.dispose());
    assert.equal(refreshWorldLighting(moved), false, "disposed renderers cannot accept unowned HMR");
  } finally { probes.forEach(probe => probe.release()); scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});


test("lighting refresh retains fishing phases and transfers the same memory lease across both cameras", async () => {
  const torch = { id: "lease-torch", kind: "torch", position: { x: 600, y: 674 }, radius: 50,
    intensity: .6, color: "#ffcd84", flicker: 0, height: 20 };
  const { mountHabitat, connectForestSession, TILED_WORLD, refreshWorldLighting, ApiError,
    worldLightingEditorStore: editor } = await modules({ ...fishingFixture(), lights: [torch] });
  const env = browser(), scenes = [], probes = [];
  const owner = "1234-ABCD-EFGH", key = `zhiv:mochlik:presence:${owner}`, server = builderMemoryServer(owner, ApiError);
  const commands = [], errors = [];
  const transport = { read: server.transport.read, async command(command) {
    commands.push(command);
    try { return await server.transport.command(command); } catch (error) { errors.push(error); throw error; }
  } };
  try {
    const source = connectForestSession(key, TILED_WORLD, "circle", server.now(), 0, () => {},
      { sync: { environment: server.environment, transport } }); probes.push(source);
    const journey = { id: "refresh-fishing", routeId: "shore", rewards: { fish: 4 },
      startedAt: new Date(0).toISOString(), finishesAt: new Date(700_000).toISOString() };
    const initial = { ...options, reducedMotion: false, serverNow: server.now(), presenceKey: key, economyJourney: journey };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    for (const view of ["circle", "world"]) scenes.push(mountHabitat(env.surface(), { ...initial, view }, callbacks));
    env.finish(); await flush(); await server.pump();
    scenes.forEach((scene, index) => scene.configure({ ...initial, view: index ? "world" : "circle" }));
    assert.equal(source.state.memory.sync.mode, "synced");
    assert.equal(source.state.journeyTravel.phase, "fishing");
    const travel = source.state.journeyTravel, beganAt = travel.beganAt, fishingAt = travel.fishingAt;
    source.saveMemory(); await server.pump();
    const leaseAcquires = commands.filter(command => command.action === "acquire").length;
    const brighter = { ...TILED_WORLD, lights: [{ ...torch, intensity: .8 }] };
    assert.equal(refreshWorldLighting(brighter), true); editor.adoptProjectScene(brighter);
    await flush(); await server.pump();
    assert.equal(source.state.journeyTravel, travel);
    assert.equal(travel.phase, "fishing"); assert.equal(travel.beganAt, beganAt); assert.equal(travel.fishingAt, fishingAt);
    assert.equal(travel.scene, brighter);
    const moved = { ...brighter, lights: [{ ...brighter.lights[0], position: { x: 640, y: 674 } }] };
    assert.equal(refreshWorldLighting(moved), true); editor.adoptProjectScene(moved);
    await flush(); await server.pump();
    const target = connectForestSession(key, moved, "circle", server.now(), 0, () => {}); probes.push(target);
    assert.notEqual(target.state, source.state);
    assert.equal(target.state.memory.sync.mode, "synced");
    target.saveMemory(); await server.pump(15_000);
    assert.equal(target.state.memory.sync.mode, "synced");
    assert.equal(commands.filter(command => command.action === "acquire").length, leaseAcquires, "geometry adopts the exact writer, without reacquiring its lease");
    assert.deepEqual(errors, [], "no lease or revision conflict during either camera handoff");
    assert.equal(env.frames.size, 1);
  } finally { probes.forEach(probe => probe.release()); scenes.forEach(scene => scene.dispose()); env.restore(); }
});


test("a failed optional distant image cannot block a ready circle's saved torch geometry", async () => {
  const torch = { id: "optional-torch", kind: "torch", position: { x: 600, y: 674 }, radius: 50,
    intensity: .6, color: "#ffcd84", flicker: 0, height: 20 };
  const remote = { id: "remote", image: "/lighting-optional-retry.webp", bounds: { x: 20, y: 20, width: 80, height: 80 } };
  const { mountHabitat, connectForestSession, TILED_WORLD, refreshWorldLighting, isWalkable,
    worldLightingEditorStore: editor } = await modules({ terrain: [...fixture.terrain, remote], lights: [torch], navigation: livingNavigation });
  const env = browser(); let scene, probe;
  try {
    const key = "optional-light-refresh"; let ready = 0;
    scene = mountHabitat(env.surface(), { ...options, presenceKey: key }, { activity() {}, ready() { ready++; }, failure: assert.fail });
    env.finishPath("/test-ground.webp"); await flush();
    env.finishPath(remote.image, true); await flush();
    const moved = { ...TILED_WORLD, lights: [{ ...torch, position: { x: 690, y: 674 } }] };
    assert.equal(refreshWorldLighting(moved), true); editor.adoptProjectScene(moved); await flush();
    probe = connectForestSession(key, moved, "circle", 0, 0, () => {});
    assert.equal(isWalkable(probe.state.clearing.navigation, { x: 600, y: 690.5 }), true);
    assert.equal(isWalkable(probe.state.clearing.navigation, { x: 690, y: 690.5 }), false);
    assert.deepEqual(scene.lightingLights().find(light => light.id === torch.id).position, { x: 690, y: 674 });
    assert.equal(ready, 1, "lighting commits before the optional retry completes");
    assert.equal(env.pending.find(request => request.path === remote.image).image.fetchPriority, "low");
    env.finishPath(remote.image, true); await flush();
    assert.equal(ready, 1);
  } finally { probe?.release(); scene?.dispose(); env.restore(); }
});
