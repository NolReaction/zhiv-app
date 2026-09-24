import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createWorldNavigation, isWalkable, canTraverse, findWorldPath, WORLD_NAVIGATION_LIMITS } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const p = (x, y) => ({ x, y });
const rect = (x, y, width, height) => [p(x, y), p(x + width, y), p(x + width, y + height), p(x, y + height)];
const polygon = (points, id = "polygon") => ({ id, points });
const scene = (changes = {}) => ({ schemaVersion: 1, id: "navigation-test", width: 100, height: 100,
  actor: { spawn: p(15, 50), size: 20 }, focus: { x: 0, y: 0, width: 100, height: 100 },
  terrain: [], sites: [], paths: [], navigation: { version: 1, cellSize: 5,
    areas: [polygon(rect(0, 0, 100, 100), "grass")], obstacles: [], interests: [], ...changes } });
const pathSafe = (nav, path, start, end) => {
  assert.ok(path, nav.stats.lastSearch?.reason);
  assert.deepEqual(path[0], start); assert.deepEqual(path.at(-1), end);
  assert.notEqual(path[0], start); assert.notEqual(path.at(-1), end);
  for (let i = 1; i < path.length; i++) assert.ok(canTraverse(nav, path[i - 1], path[i]), `unsafe segment ${i}`);
};

test("navigation is opt-in, versioned, profile-cached and independent of the camera focus", () => {
  const source = scene(), nav = createWorldNavigation(source);
  assert.ok(nav); assert.equal(nav.radius, 2); assert.equal(createWorldNavigation(source), nav);
  assert.notEqual(createWorldNavigation(source, 3), nav);
  assert.notEqual(createWorldNavigation({ ...source }), nav);
  assert.equal(createWorldNavigation({ ...source, navigation: undefined }), null);
  assert.equal(createWorldNavigation(scene({ version: 2 })), null);
  assert.equal(createWorldNavigation(scene({ areas: [] })), null);
  assert.equal(createWorldNavigation(scene({ cellSize: 0 })), null);
  assert.equal(createWorldNavigation(source, NaN), null);
  assert.equal(createWorldNavigation(source, -1), null);
  const tinyFocus = createWorldNavigation({ ...source, focus: { x: 50, y: 50, width: 1, height: 1 } });
  assert.ok(isWalkable(tinyFocus, p(10, 10)));
  assert.equal(nav.stats.walkableCells, nav.grid.walkable.reduce((sum, n) => sum + n, 0));
});

test("straight safe paths preserve arbitrary endpoints and require the entire footprint", () => {
  const nav = createWorldNavigation(scene()), start = p(13.17, 23.42), end = p(88.33, 79.11);
  const path = findWorldPath(nav, start, end);
  pathSafe(nav, path, start, end); assert.equal(path.length, 2); assert.equal(nav.stats.lastSearch.reason, "direct");
  assert.equal(isWalkable(nav, p(1.99, 40)), false);
  assert.equal(isWalkable(nav, p(2.01, 40)), true);
  assert.equal(findWorldPath(nav, p(1, 40), end), null);
  assert.equal(findWorldPath(nav, p(NaN, 40), end), null);
  assert.equal(canTraverse(nav, start, p(Infinity, 40)), false);
});

test("thin crossed and near-missed obstacles block the swept disk even when cells are clear", () => {
  for (const points of [rect(49.9, 44, .1, 12), rect(49.9, 51.9, .1, 6)]) {
    const nav = createWorldNavigation(scene({ obstacles: [polygon(points, "thin-stem")] }));
    assert.ok(isWalkable(nav, p(15, 50))); assert.ok(isWalkable(nav, p(85, 50)));
    assert.equal(canTraverse(nav, p(15, 50), p(85, 50)), false);
    const path = findWorldPath(nav, p(15, 50), p(85, 50));
    pathSafe(nav, path, p(15, 50), p(85, 50)); assert.ok(path.length > 2);
  }
});

test("water exclusions never authorize crossings and existing site collisions stay closed", () => {
  const source = scene();
  source.water = { surfaces: [polygon(rect(48, 0, 4, 100), "river")],
    exclusions: [polygon(rect(40, 40, 20, 20), "floating-leaf")] };
  const nav = createWorldNavigation(source);
  assert.equal(isWalkable(nav, p(50, 50)), false);
  assert.equal(canTraverse(nav, p(15, 50), p(85, 50)), false);
  assert.equal(findWorldPath(nav, p(15, 50), p(85, 50)), null);
  const home = scene(); home.sites = [{ id: "home", collision: rect(40, 0, 20, 100) }];
  const houseNav = createWorldNavigation(home);
  assert.equal(findWorldPath(houseNav, p(15, 50), p(85, 50)), null);
});

test("overlapping and edge-adjacent walk polygons form a union without artificial seams", () => {
  for (const split of [45, 50]) for (const reverse of [false, true]) {
    const right = rect(split, 0, 100 - split, 100);
    const nav = createWorldNavigation(scene({ areas: [polygon(rect(0, 0, 50, 100), "left"),
      polygon(reverse ? right.reverse() : right, "right")] }), 6);
    assert.ok(isWalkable(nav, p(50, 50)));
    assert.ok(canTraverse(nav, p(15, 50), p(85, 50)));
    const path = findWorldPath(nav, p(15, 50), p(85, 50));
    pathSafe(nav, path, p(15, 50), p(85, 50)); assert.equal(path.length, 2);
    assert.ok(nav.debug.boundary.every(edge => !(edge.a.x === 50 && edge.b.x === 50)));
  }
});

test("a disk can span several polygons while concave union corners remain solid", () => {
  const nav = createWorldNavigation(scene({ areas: [polygon(rect(0, 0, 60, 35), "top"),
    polygon(rect(25, 20, 35, 70), "leg")] }), 3);
  assert.ok(isWalkable(nav, p(28, 32)), "clearance may be shared by two overlapping areas");
  assert.equal(isWalkable(nav, p(26, 36)), false, "disk touches the reentrant corner");
  assert.equal(canTraverse(nav, p(10, 20), p(45, 75)), false, "centerline crosses the concavity");
  pathSafe(nav, findWorldPath(nav, p(10, 20), p(45, 75)), p(10, 20), p(45, 75));
});

test("concave single areas and holes in a polygon union reject straight-line shortcuts", () => {
  const concave = createWorldNavigation(scene({ areas: [polygon([p(0, 0), p(90, 0), p(90, 90), p(65, 90),
    p(65, 25), p(25, 25), p(25, 90), p(0, 90)])] }));
  assert.equal(canTraverse(concave, p(10, 70), p(80, 70)), false);
  pathSafe(concave, findWorldPath(concave, p(10, 70), p(80, 70)), p(10, 70), p(80, 70));
  const ring = createWorldNavigation(scene({ areas: [polygon(rect(0, 0, 100, 25), "top"),
    polygon(rect(0, 75, 100, 25), "bottom"), polygon(rect(0, 0, 25, 100), "left"),
    polygon(rect(75, 0, 25, 100), "right")] }));
  assert.equal(isWalkable(ring, p(50, 50)), false);
  assert.equal(canTraverse(ring, p(15, 50), p(85, 50)), false);
  pathSafe(ring, findWorldPath(ring, p(15, 50), p(85, 50)), p(15, 50), p(85, 50));
});

test("arbitrary endpoint connectors never jump a thin wall to a nearby free grid cell", () => {
  const source = scene({ cellSize: 10, obstacles: [polygon(rect(0, 0, 100, 1.5), "upper"),
    polygon(rect(0, 4.5, 100, .1), "lower-wall")] });
  const nav = createWorldNavigation(source, 1), start = p(43.2, 3), end = p(70, 70);
  assert.ok(isWalkable(nav, start)); assert.ok(isWalkable(nav, end));
  assert.equal(findWorldPath(nav, start, end), null);
  assert.equal(nav.stats.lastSearch.reason, "disconnected-endpoint");
  assert.equal(findWorldPath(nav, end, start), null);
});

test("touching corners cannot connect disconnected regions by diagonal grid steps", () => {
  const nav = createWorldNavigation(scene({ cellSize: 10, areas: [polygon(rect(0, 0, 50, 50), "northwest"),
    polygon(rect(50, 50, 50, 50), "southeast")] }), .25);
  assert.equal(canTraverse(nav, p(45, 45), p(55, 55)), false);
  assert.equal(findWorldPath(nav, p(15, 15), p(85, 85)), null);
  const pointNav = createWorldNavigation(scene({ cellSize: 10, areas: [polygon(rect(0, 0, 50, 50)),
    polygon(rect(50, 50, 50, 50))] }), 0);
  assert.equal(findWorldPath(pointNav, p(15, 15), p(85, 85)), null, "zero-radius profile cannot cut a boundary corner either");
});

test("passage width respects actor radius and smoothing never clips obstacle corners", () => {
  const source = scene({ cellSize: 3, obstacles: [polygon(rect(40, 0, 20, 44), "north"),
    polygon(rect(40, 56, 20, 44), "south")] });
  const small = createWorldNavigation(source, 4), large = createWorldNavigation(source, 6.1);
  pathSafe(small, findWorldPath(small, p(15, 50), p(85, 50)), p(15, 50), p(85, 50));
  assert.equal(findWorldPath(large, p(15, 50), p(85, 50)), null);
  const corner = createWorldNavigation(scene({ obstacles: [polygon(rect(35, 0, 30, 65))] }), 4);
  const start = p(17.3, 22.1), end = p(81.6, 33.3), path = findWorldPath(corner, start, end);
  pathSafe(corner, path, start, end); assert.ok(path.some(point => point.y > 69));
  assert.deepEqual(findWorldPath(corner, start, end), path, "cached adjacency preserves deterministic path choices");
});

test("scene geometry is copied and cache invalidation uses a new scene snapshot", () => {
  const source = scene({ obstacles: [polygon(rect(45, 35, 10, 30))] }), nav = createWorldNavigation(source);
  assert.equal(canTraverse(nav, p(15, 50), p(85, 50)), false);
  source.navigation.obstacles[0].points.forEach(point => { point.y += 100; });
  assert.equal(canTraverse(nav, p(15, 50), p(85, 50)), false);
  assert.equal(canTraverse(createWorldNavigation({ ...source }), p(15, 50), p(85, 50)), true);
});

test("grid allocation rejects oversized data and failed searches stay within their work budgets", () => {
  assert.equal(createWorldNavigation(scene({ cellSize: .001 })), null);
  assert.equal(createWorldNavigation(scene({ areas: [polygon([p(0, 0), p(NaN, 20), p(20, 0)])] })), null);
  const nav = createWorldNavigation(scene({ obstacles: [polygon(rect(48, 0, 4, 100))] }));
  assert.equal(findWorldPath(nav, p(15, 50), p(85, 50)), null);
  assert.ok(nav.stats.lastSearch.visited <= WORLD_NAVIGATION_LIMITS.searchVisits);
  assert.ok(nav.stats.lastSearch.checks <= WORLD_NAVIGATION_LIMITS.searchChecks + 8);
});

test("the authored clearing reaches each interest and nearby mushroom with its actual support radius", () => {
  const nav = createWorldNavigation(TILED_WORLD);
  assert.ok(nav); assert.ok(isWalkable(nav, TILED_WORLD.actor.spawn));
  for (const interest of TILED_WORLD.navigation.interests) {
    pathSafe(nav, findWorldPath(nav, TILED_WORLD.actor.spawn, interest.position), TILED_WORLD.actor.spawn, interest.position);
  }
  for (const mushroom of TILED_WORLD.mushrooms ?? []) {
    if (Math.hypot(mushroom.position.x - TILED_WORLD.actor.spawn.x, mushroom.position.y - TILED_WORLD.actor.spawn.y) < 80) {
      pathSafe(nav, findWorldPath(nav, TILED_WORLD.actor.spawn, mushroom.position), TILED_WORLD.actor.spawn, mushroom.position);
    }
  }
});
