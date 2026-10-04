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
const { forestResidentFrames, drawForestResidents } = await vite.ssrLoadModule("/features/world/forest-residents.ts");
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

test("explicit empty, ambiguous or malformed destinations never fall back to legacy lines", () => {
  const legacy = legacyWorld();
  assert.equal(forestTrails(legacy).size, 2);
  assert.deepEqual(forestTrailDestination(legacy, "workshop"), { x: 80, y: 80 });
  assert.equal(forestResidentFrames(legacy, 10, false).length, 2);
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

test("both residents tour multiple reachable destinations continuously and cache all path searches", () => {
  const scene = simpleWorld(), nav = createWorldNavigation(scene);
  forestResidentFrames(scene, 0, false);
  const lastSearch = nav.stats.lastSearch, visits = new Map(), previous = new Map();
  for (let elapsed = 0; elapsed <= 250; elapsed += .25) {
    const frames = forestResidentFrames(scene, elapsed, false);
    assert.equal(frames.length, 2);
    for (const frame of frames) {
      assert.ok(isWalkable(nav, frame));
      assert.ok(frame.x < 200, "the isolated destination cannot teleport a resident to another island");
      const last = previous.get(frame.id);
      if (last) assert.ok(Math.hypot(frame.x - last.x, frame.y - last.y) <= 9 * .25 + 1e-8,
        "bounded speed remains continuous at corners, waits and cycle wrap");
      previous.set(frame.id, frame);
      const stop = scene.destinations.find(point => Math.hypot(frame.x - point.position.x, frame.y - point.position.y) < 1e-6);
      if (frame.pose === "idle" && stop) {
        const visited = visits.get(frame.id) ?? new Set(); visited.add(stop.id); visits.set(frame.id, visited);
      }
    }
  }
  assert.strictEqual(nav.stats.lastSearch, lastSearch, "render frames never rerun pathfinding");
  for (const id of ["forest-carpenter", "shore-neighbour"]) assert.deepEqual([...visits.get(id)].sort(), ["home", "quarry", "workshop"]);
  assert.deepEqual(forestResidentFrames(scene, Number.NaN, false), forestResidentFrames(scene, 0, false));
  assert.deepEqual(forestResidentFrames(scene, Number.POSITIVE_INFINITY, false), forestResidentFrames(scene, 0, false));
  assert.deepEqual(forestResidentFrames(scene, 0, true), forestResidentFrames(scene, 10000, true));
});

test("disconnected or singular destination networks render no walking residents", () => {
  const base = simpleWorld();
  for (const destinations of [[], [base.destinations[0]], [base.destinations[0], base.destinations[3]]]) {
    const scene = { ...base, destinations };
    assert.deepEqual(forestResidentFrames(scene, 0, false), []);
    assert.deepEqual(forestResidentFrames(scene, 10000, true), []);
  }
  const withoutHome = { ...base, destinations: [base.destinations[3], base.destinations[1], base.destinations[2]] };
  assert.equal(forestResidentFrames(withoutHome, 10, false).length, 2, "isolated first marker does not hide another usable component");
});
