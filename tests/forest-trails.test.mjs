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
const { forestTrails, forestDestinations, forestTrailDestination, findForestTrailPath } = await vite.ssrLoadModule("/features/world/forest-trails.ts");
const { forestResidentFrames, forestResidentAt, drawForestResidents } = await vite.ssrLoadModule("/features/world/forest-residents.ts");
const { chooseForestGoal, createForestBehavior } = await vite.ssrLoadModule("/features/world/forest-behavior.ts");
const world = (level = 1) => previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD),
  home: Math.max(1, level), workshop: level, quarry: level });

test("all authored destinations connect through WalkAreas at every building level", () => {
  for (let level = 0; level <= 5; level++) {
    const scene = world(level), nav = createWorldNavigation(scene), destinations = forestDestinations(scene);
    assert.ok(destinations.size >= 4); assert.strictEqual(forestDestinations(scene), destinations, "immutable scene compiles once");
    assert.ok(nav.stats.cells < 65_536, "expanded island still fits the bounded grid");
    for (const target of scene.destinations.map(point => point.id)) {
      const endpoint = forestTrailDestination(scene, target);
      assert.deepEqual(endpoint, scene.destinations.find(point => point.id === target).position);
      assert.ok(isWalkable(nav, endpoint));
      const found = findForestTrailPath(scene, scene.actor.spawn, target);
      assert.ok(found?.length > 1, `${target} connected at level ${level}`);
      for (let i = 1; i < found.length; i++) assert.ok(canTraverse(nav, found[i - 1], found[i]));
      assert.deepEqual(found.at(-1), endpoint);
    }
    assert.deepEqual(forestResidentFrames({ ...scene, paths: [] }, 12, false), forestResidentFrames(scene, 12, false),
      "destination tours do not require the old centre lines");
  }
});

const rectangle = (id, x, y, width, height) => ({ id, points: [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
] });
const destination = (id, x, y) => ({ id, position: { x, y }, pauseSeconds: 4 });
const simpleWorld = () => ({ ...world(), actor: { spawn: { x: 30, y: 80 }, size: 20 }, sites: [], paths: [], water: undefined, campfires: [],
  destinations: [destination("home", 30, 80), destination("workshop", 80, 80), destination("quarry", 160, 80), destination("fishing", 290, 80)],
  navigation: { version: 1, cellSize: 4, interests: [],
    areas: [rectangle("left", 0, 0, 106, 160), rectangle("right", 96, 0, 104, 160), rectangle("isolated", 260, 0, 70, 160)],
    obstacles: [rectangle("wall", 100, 30, 16, 90)],
  },
});
const legacyWorld = () => {
  const scene = simpleWorld();
  return { ...scene, destinations: undefined, paths: [
    { id: "trail-workshop", points: [{ x: 30, y: 80 }, { x: 80, y: 80 }] },
    { id: "trail-fishing", points: [{ x: 30, y: 80 }, { x: 30, y: 130 }] },
  ] };
};

test("destination paths cross overlapping areas and detour around obstacles without moving markers", () => {
  const scene = simpleWorld(), nav = createWorldNavigation(scene), target = forestTrailDestination(scene, "quarry");
  assert.equal(canTraverse(nav, scene.actor.spawn, target), false);
  const path = findForestTrailPath(scene, scene.actor.spawn, "quarry");
  assert.ok(path.length > 2);
  assert.deepEqual(path.at(-1), target);
  for (let i = 1; i < path.length; i++) assert.ok(canTraverse(nav, path[i - 1], path[i]));
  assert.equal(findForestTrailPath(scene, scene.actor.spawn, "fishing"), null, "isolated destinations stay unreachable");
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
  const base = legacyWorld();
  assert.equal(forestTrails({ ...base, paths: [] }).size, 0);
  const blocked = { ...base, paths: base.paths.map(path => path.id === "trail-fishing"
    ? { ...path, points: [base.actor.spawn, { x: 108, y: 70 }] } : path) };
  assert.equal(forestTrailDestination(blocked, "fishing"), null);
  assert.equal(findForestTrailPath(blocked, base.actor.spawn, "fishing"), null);
  assert.deepEqual(forestResidentFrames(blocked, 10, false), []);
});

test("the legacy Pleska preview remains deterministic while active residents use session frames", () => {
  const scene = world(), nav = createWorldNavigation(scene), actions = new Set();
  for (let elapsed = 0; elapsed < 300; elapsed += .5) {
    const frames = forestResidentFrames(scene, elapsed, false);
    assert.equal(frames.length, 1); assert.equal(frames[0].id, "plesk");
    assert.deepEqual(forestResidentFrames(scene, elapsed, false), frames);
    assert.ok(isWalkable(nav, frames[0])); actions.add(frames[0].action);
  }
  for (const action of ["fish", "walk", "trade", "rest"]) assert.ok(actions.has(action));
  assert.deepEqual(forestResidentFrames(scene, 0, true), forestResidentFrames(scene, 10000, true));
  assert.ok(forestResidentFrames(scene, 10, true).every(frame => frame.action === "fish" && frame.frame === 0));
});

test("mixed resident hits resolve the frontmost body independently of registry order and masks", () => {
  const scene = world(), plesk = forestResidentFrames(scene, 10, true)[0];
  const builder = { id: "builder", x: plesk.x, y: plesk.y + 3, size: 40, action: "idle", direction: "front", frame: 0, phase: 0 };
  const point = { x: plesk.x, y: plesk.y - 18 }, original = structuredClone([plesk, builder]);
  for (const frames of [[plesk, builder], [builder, plesk]]) {
    assert.equal(forestResidentAt(scene, 10, true, point, frames), "builder");
    assert.equal(forestResidentAt(scene, 10, true, point, frames.map(frame => frame.id === "builder" ? { ...frame, y: plesk.y - 3 } : frame)), "plesk");
  }
  const mask = { ...rectangle("counter", point.x - 20, point.y - 20, 40, 40), frontY: plesk.y + 1 };
  assert.equal(forestResidentAt({ ...scene, occluders: [mask] }, 10, true, point, [plesk, builder]), "builder", "a resident in front of a mask remains interactive");
  assert.equal(forestResidentAt({ ...scene, occluders: [{ ...mask, frontY: builder.y + 1 }] }, 10, true, point, [plesk, builder]), null);
  assert.equal(forestResidentAt(scene, 10, true, { x: point.x + 100, y: point.y }, [builder]), null, "the builder's tool and surroundings are not a broad invisible target");
  assert.deepEqual([plesk, builder], original, "hit sorting does not reorder or mutate shared resident frames");
});

test("offscreen residents are culled before sprite creation and need no additional canvas or image readback", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement() { assert.fail("offscreen sprite must not allocate"); } } });
  try {
    const ctx = { canvas: { width: 100, height: 100 }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      drawImage() { assert.fail("offscreen resident must not draw its sprite"); } };
    drawForestResidents(ctx, world(), 0, false, 700, "behind");
    drawForestResidents(ctx, world(), 0, false, 700, "front");
    drawForestResidents(ctx, world(), 0, false, 700, "front", [{ id: "builder", x: 1000, y: 1000,
      size: 40, action: "work", direction: "front", frame: 1, phase: .3 }]);
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

test("explicit empty, ambiguous or malformed destinations never fall back to legacy lines", () => {
  const legacy = legacyWorld();
  assert.equal(forestTrails(legacy).size, 2);
  assert.deepEqual(forestTrailDestination(legacy, "workshop"), { x: 80, y: 80 });
  assert.equal(forestResidentFrames(legacy, 10, false).length, 0, "a personal resident never occupies the hero legacy fishing route");
  const empty = { ...legacy, destinations: [] };
  assert.equal(forestTrailDestination(empty, "workshop"), null);
  assert.equal(findForestTrailPath(empty, legacy.actor.spawn, "workshop"), null);
  assert.deepEqual(forestResidentFrames(empty, 10, false), []);
  for (const invalid of [
    [destination("workshop", 80, 80), destination("workshop", 75, 80)],
    [destination("workshop", Number.NaN, 80)],
    [destination("workshop", 108, 80)],
    [{ ...destination("workshop", 80, 80), siteId: "missing-site" }],
    [{ ...destination("workshop", 80, 80), pauseSeconds: Number.POSITIVE_INFINITY }],
    [{ ...destination("workshop", 80, 80), pauseSeconds: 0 }],
    [{ ...destination("workshop", 80, 80), pauseSeconds: 61 }],
    [null],
    Array.from({ length: 17 }, (_, index) => destination(`stop-${index}`, 30 + index * 3, 80)),
  ]) {
    const scene = { ...legacy, destinations: invalid };
    assert.equal(forestTrailDestination(scene, "workshop"), null);
    assert.deepEqual(forestResidentFrames(scene, 10, false), []);
  }
});

test("resident interaction targets the visible body and respects foreground masks", () => {
  const scene = world(), resident = forestResidentFrames(scene, 10, true)[0];
  const body = { x: resident.x, y: resident.y - resident.size * .5 };
  assert.equal(forestResidentAt(scene, 10, true, body), "plesk");
  assert.equal(forestResidentAt(scene, 10, true, resident.waterTarget), null, "the line and bobber never steal river taps");
  assert.equal(forestResidentAt(scene, 10, true, { x: Number.NaN, y: body.y }), null);
  const mask = { ...rectangle("resident-cover", body.x - 10, body.y - 10, 20, 20), frontY: resident.y + 1 };
  assert.equal(forestResidentAt({ ...scene, occluders: [mask] }, 10, true, body), null);
  assert.equal(forestResidentAt({ ...scene, occluders: [{ ...mask, frontY: resident.y - 1 }] }, 10, true, body), "plesk");
  assert.equal(forestResidentAt({ ...scene, destinations: [] }, 10, true, body), null);
});
