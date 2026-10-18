import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldNavigation, canTraverse, findWorldPath, isWalkable } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { forestTorchFootprints, forestTorchGeometryKey } = await vite.ssrLoadModule("/features/world/environment/lighting/forest-torch-fixture.ts");
const { forestSceneFingerprint } = await vite.ssrLoadModule("/features/world/state/memory/forest-memory.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { forestDestinations } = await vite.ssrLoadModule("/features/world/navigation/forest-trails.ts");
const torch = (changes = {}) => ({ id: "torch", kind: "torch", position: { x: 100, y: 83.5 }, radius: 70,
  intensity: 1, color: "#ffb45d", flicker: .12, ...changes });
const source = (lights = [torch()]) => ({ schemaVersion: 1, id: "torch-navigation", width: 200, height: 200,
  sites: [], paths: [], terrain: [], focus: { x: 0, y: 0, width: 200, height: 200 },
  actor: { spawn: { x: 30, y: 100 }, size: 50 }, lights,
  navigation: { version: 1, cellSize: 5, interests: [], obstacles: [], areas: [{ id: "grass", points: [
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 },
  ] }] } });

test("every walking actor profile detours around the physical foot of a lit or extinguished torch", () => {
  for (const radius of [3.6, 4, 4.2, 4.4, 5, 8]) for (const intensity of [0, 1]) {
    const nav = createWorldNavigation(source([torch({ intensity })]), radius);
    const start = { x: 30, y: 100 }, end = { x: 170, y: 100 };
    assert.equal(isWalkable(nav, { x: 100, y: 100 }), false);
    assert.equal(isWalkable(nav, { x: 100, y: 83.5 }), true, "flame is above the footprint");
    assert.equal(canTraverse(nav, start, end), false);
    const path = findWorldPath(nav, start, end);
    assert.ok(path?.length > 2, `profile ${radius}, intensity ${intensity}`);
    assert.deepEqual(path.at(-1), end);
    for (let i = 1; i < path.length; i++) assert.ok(canTraverse(nav, path[i - 1], path[i]));
  }
});

test("disabled sources, lanterns and glows leave walking ground open; height never moves the post", () => {
  for (const light of [torch({ enabled: false }), torch({ kind: "lantern" }), torch({ kind: "glow" })]) {
    assert.deepEqual(forestTorchFootprints([light]), []);
    const nav = createWorldNavigation(source([light]));
    assert.equal(canTraverse(nav, { x: 30, y: 100 }, { x: 170, y: 100 }), true);
  }
  assert.deepEqual(forestTorchFootprints([torch({ height: 100 })]), forestTorchFootprints([torch()]));
});

test("moving a torch gets new geometry and memory identity while light styling is cosmetic", () => {
  const first = source(), original = createWorldNavigation(first), shifted = source([torch({ position: { x: 140, y: 83.5 } })]);
  assert.strictEqual(createWorldNavigation(first), original);
  const next = createWorldNavigation(shifted);
  assert.notEqual(original, next);
  assert.equal(isWalkable(next, { x: 100, y: 100 }), true);
  assert.equal(isWalkable(next, { x: 140, y: 100 }), false);
  assert.notEqual(forestSceneFingerprint(first), forestSceneFingerprint(shifted));
  const styled = source([torch({ intensity: 0, radius: 150, color: "#ffffff", height: 90 })]);
  assert.equal(forestSceneFingerprint(first), forestSceneFingerprint(styled));
  assert.notEqual(forestSceneFingerprint(first), forestSceneFingerprint(source([torch({ enabled: false })])));
  assert.equal(forestTorchGeometryKey([torch(), torch({ id: "second" })]),
    forestTorchGeometryKey([torch({ id: "second" }), torch()]));
});

test("all six authored torch feet stay blocked without disconnecting travel markers at any building tier", () => {
  assert.equal(TILED_WORLD.lights.filter(light => light.kind === "torch" && light.enabled !== false).length, 6);
  for (let level = 0; level <= 5; level++) {
    const scene = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), home: Math.max(1, level), workshop: level, quarry: level });
    const nav = createWorldNavigation(scene);
    for (const light of scene.lights.filter(light => light.kind === "torch" && light.enabled !== false))
      assert.equal(isWalkable(nav, { x: light.position.x, y: light.position.y + 16.5 }), false, light.id);
    const destinations = forestDestinations(scene);
    for (const target of scene.destinations.filter(target => !target.id.startsWith("builder-"))) {
      assert.ok(destinations.has(target.id), `${target.id} remains valid at tier ${level}`);
      assert.ok(findWorldPath(nav, scene.actor.spawn, target.position), `${target.id} stays connected at tier ${level}`);
    }
  }
});
