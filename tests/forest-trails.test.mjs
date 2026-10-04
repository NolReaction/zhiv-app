import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { createWorldNavigation, canTraverse, isWalkable, findWorldPath } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { forestTrails, forestTrailDestination, findForestTrailPath } = await vite.ssrLoadModule("/features/world/forest-trails.ts");
const { forestResidentFrames, drawForestResidents } = await vite.ssrLoadModule("/features/world/forest-residents.ts");
const { chooseForestGoal, createForestBehavior } = await vite.ssrLoadModule("/features/world/forest-behavior.ts");
const world = (level = 1) => previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD),
  home: Math.max(1, level), workshop: level, quarry: level });

test("authored paths connect home, workshop, quarry and fishing on the same safe navigation at every building level", () => {
  for (let level = 0; level <= 5; level++) {
    const scene = world(level), nav = createWorldNavigation(scene), trails = forestTrails(scene);
    assert.equal(trails.size, 3); assert.strictEqual(forestTrails(scene), trails, "immutable scene compiles once");
    assert.ok(nav.stats.cells < 65_536, "expanded island still fits the bounded grid");
    for (const target of ["workshop", "quarry", "fishing"]) {
      const authored = trails.get(`trail-${target}`), endpoint = forestTrailDestination(scene, target);
      assert.deepEqual(endpoint, authored.points.at(-1)); assert.ok(isWalkable(nav, endpoint));
      for (let i = 1; i < authored.points.length; i++) assert.ok(canTraverse(nav, authored.points[i - 1], authored.points[i]), `${target} segment ${i}, level ${level}`);
      const found = findForestTrailPath(scene, scene.actor.spawn, target);
      assert.ok(found?.length > 1, `${target} connected at level ${level}`);
      for (let i = 1; i < found.length; i++) assert.ok(canTraverse(nav, found[i - 1], found[i]));
      assert.deepEqual(found.at(-1), endpoint);
    }
  }
});

test("world roads never open the broken bridge, market bank, river or a direct shortcut through the northern trees", () => {
  const scene = world(), nav = createWorldNavigation(scene);
  for (const point of [{ x: 620, y: 1040 }, { x: 380, y: 950 }, { x: 1190, y: 880 }]) {
    assert.equal(isWalkable(nav, point), false); assert.equal(findWorldPath(nav, scene.actor.spawn, point), null);
  }
  assert.equal(canTraverse(nav, scene.actor.spawn, forestTrailDestination(scene, "quarry")), false);
  assert.equal(canTraverse(nav, scene.actor.spawn, forestTrailDestination(scene, "fishing")), false);
});

test("unknown or blocked authored roads fail closed instead of moving residents through hazards", () => {
  const base = world();
  assert.equal(forestTrails({ ...base, paths: [] }).size, 0);
  const blocked = { ...base, paths: base.paths.map(path => path.id === "trail-fishing"
    ? { ...path, points: [base.actor.spawn, { x: 1190, y: 880 }] } : path) };
  assert.equal(forestTrailDestination(blocked, "fishing"), null);
  assert.equal(findForestTrailPath(blocked, base.actor.spawn, "fishing"), null);
  assert.deepEqual(forestResidentFrames(blocked, 10, false).map(frame => frame.id), ["forest-carpenter"]);
});

test("two residents follow safe roads, pause and share deterministic time across the circle and map", () => {
  const scene = world(), nav = createWorldNavigation(scene), poses = new Set();
  for (let elapsed = 0; elapsed < 240; elapsed += .5) {
    const frames = forestResidentFrames(scene, elapsed, false);
    assert.equal(frames.length, 2); assert.deepEqual(forestResidentFrames(scene, elapsed, false), frames);
    for (const frame of frames) { assert.ok(isWalkable(nav, frame), frame.id); poses.add(frame.pose); }
    assert.ok(frames[0].y <= frames[1].y);
  }
  assert.deepEqual([...poses].sort(), ["idle", "walk"]);
  assert.deepEqual(forestResidentFrames(scene, 0, true), forestResidentFrames(scene, 10000, true));
  assert.ok(forestResidentFrames(scene, 10, true).every(frame => frame.pose === "idle" && frame.frame === 0));
});

test("offscreen residents are culled before sprite creation and need no additional canvas or image readback", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement() { assert.fail("offscreen sprite must not allocate"); } } });
  try {
    const ctx = { canvas: { width: 100, height: 100 }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
    drawForestResidents(ctx, world(), 0, false, 700, "behind");
    drawForestResidents(ctx, world(), 0, false, 700, "front");
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; }
});

test("opening remote roads keeps casual sampled goals in the authored home neighbourhood", () => {
  const scene = world(), nav = createWorldNavigation(scene), home = scene.actor.spawn;
  let seed = 13;
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
  for (let n = 0; n < 40; n++) {
    const goal = chooseForestGoal(nav, scene.navigation.interests, createForestBehavior(), {
      position: home, size: scene.actor.size, elapsed: 10, awakeUntil: 0, rain: 0, dusk: 0, random,
    });
    assert.ok(goal); assert.ok(Math.hypot(goal.position.x - home.x, goal.position.y - home.y) < 160);
  }
});
