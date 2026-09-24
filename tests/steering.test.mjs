import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createWorldNavigation, canTraverse, findWorldPath } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { prepareSteeringPath, desiredSteeringSpeed, WORLD_STEERING_LIMITS } = await vite.ssrLoadModule("/features/world/steering.ts");
const p = (x, y) => ({ x, y });
const rect = (x, y, width, height) => [p(x, y), p(x + width, y), p(x + width, y + height), p(x, y + height)];
const polygon = (points, id = "polygon") => ({ id, points });
function scene(changes = {}) {
  return { schemaVersion: 1, id: "steering-test", width: 200, height: 200, terrain: [], sites: [], paths: [],
    actor: { spawn: p(20, 20), size: 20 }, focus: { x: 0, y: 0, width: 200, height: 200 },
    navigation: { version: 1, cellSize: 4, areas: [polygon(rect(0, 0, 200, 200), "grass")],
      obstacles: [], interests: [], ...changes } };
}
function assertSafe(nav, result, original) {
  assert.ok(result);
  assert.deepEqual(result.points[0], original[0]); assert.deepEqual(result.points.at(-1), original.at(-1));
  assert.notEqual(result.points[0], original[0]);
  assert.equal(result.distances[0], 0); assert.equal(result.distances.at(-1), result.length);
  assert.equal(result.points.length, result.speedLimits.length);
  assert.ok(result.points.length <= WORLD_STEERING_LIMITS.points);
  assert.ok(result.checks <= WORLD_STEERING_LIMITS.checks);
  for (let i = 1; i < result.points.length; i++) {
    assert.ok(canTraverse(nav, result.points[i - 1], result.points[i]), `unsafe chord ${i}`);
    assert.ok(result.distances[i] > result.distances[i - 1]);
    assert.ok(result.speedLimits[i] >= 0 && result.speedLimits[i] <= 1);
  }
}

test("an open right-angle approach rounds with small heading increments and exact interaction endpoints", () => {
  const nav = createWorldNavigation(scene()), source = [p(20.125, 20.75), p(100, 20.75), p(100, 100.25)];
  const result = prepareSteeringPath(nav, source, 20);
  assertSafe(nav, result, source); assert.equal(result.roundedCorners, 1);
  assert.ok(result.points.length > 12); assert.ok(result.length < 159.375);
  let biggestTurn = 0;
  for (let i = 1; i < result.points.length - 1; i++) {
    const a = result.points[i - 1], b = result.points[i], c = result.points[i + 1];
    const before = Math.atan2(b.y - a.y, b.x - a.x), after = Math.atan2(c.y - b.y, c.x - b.x);
    biggestTurn = Math.max(biggestTurn, Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before))));
  }
  assert.ok(biggestTurn < .1, `heading changed ${biggestTurn} radians`);
  assert.ok(result.speedLimits.slice(1, -1).some(cap => cap < .8), "the turn limits lateral acceleration");
});

test("A* detours remain safe around walls, water and site collision without mutating navigation", () => {
  for (const kind of ["obstacle", "water", "house"]) {
    const source = scene(), blocker = rect(75, 20, 20, 110);
    if (kind === "obstacle") source.navigation.obstacles = [polygon(blocker, "stone")];
    if (kind === "water") source.water = { surfaces: [polygon(blocker, "river")], exclusions: [polygon(rect(70, 70, 30, 10), "leaf")] };
    if (kind === "house") source.sites = [{ id: "home", collision: blocker }];
    const nav = createWorldNavigation(source), path = findWorldPath(nav, p(35, 70), p(145, 70));
    assert.ok(path?.length > 2);
    const before = JSON.stringify({ stats: nav.stats, debug: nav.debug, grid: Array.from(nav.grid.walkable) });
    const result = prepareSteeringPath(nav, path, 20);
    assertSafe(nav, result, path);
    assert.equal(JSON.stringify({ stats: nav.stats, debug: nav.debug, grid: Array.from(nav.grid.walkable) }), before);
  }
});

test("narrow bent walk areas cannot be rounded across the concave outside corner", () => {
  const nav = createWorldNavigation(scene({ cellSize: 1, areas: [polygon(rect(10, 10, 80, 6), "horizontal"),
    polygon(rect(84, 10, 6, 95), "vertical")] }));
  const source = [p(20, 13), p(87, 13), p(87, 90)], result = prepareSteeringPath(nav, source, 20);
  assertSafe(nav, result, source);
  assert.ok(result.roundedCorners <= 1);
  assert.ok(result.points.every(point => point.x >= 12 && point.y <= 103));
});

test("a near-reversal retains its safe authored corner and slows without a zero-speed trap", () => {
  const nav = createWorldNavigation(scene()), source = [p(20, 50), p(110, 50), p(25, 51)];
  const result = prepareSteeringPath(nav, source, 20);
  assertSafe(nav, result, source); assert.equal(result.roundedCorners, 0); assert.deepEqual(result.points, source);
  const turnSpeed = desiredSteeringSpeed(result, result.distances[1], 7.2, 16);
  assert.ok(turnSpeed > 0 && turnSpeed <= 7.2 * .21);
});

test("blocked or malformed source paths are rejected rather than silently moving their endpoints", () => {
  const nav = createWorldNavigation(scene({ obstacles: [polygon(rect(80, 0, 20, 200), "wall")] }));
  assert.equal(prepareSteeringPath(nav, [p(20, 40), p(150, 40)], 20), null);
  assert.equal(prepareSteeringPath(nav, [p(80, 50)], 20), null);
  for (const source of [[], [p(NaN, 20)], [p(20, Infinity)]]) assert.equal(prepareSteeringPath(nav, source, 20), null);
  for (const size of [0, -1, NaN, Infinity]) assert.equal(prepareSteeringPath(nav, [p(20, 20), p(40, 20)], size), null);
});

test("duplicate and extremely short segments preserve exact finite start and destination", () => {
  const nav = createWorldNavigation(scene());
  for (const source of [[p(20, 20)], [p(20, 20), p(20, 20)],
    [p(20, 20), p(20, 20), p(20 + 1e-9, 20), p(40, 20), p(40, 20)]]) {
    const result = prepareSteeringPath(nav, source, 20);
    assertSafe(nav, result, source);
    for (let travelled = 0; travelled <= result.length; travelled += .5) {
      assert.ok(Number.isFinite(desiredSteeringSpeed(result, travelled, 7.2, 16)));
    }
  }
});

test("preparation is deterministic, bounded and independent of frame or random state", () => {
  const nav = createWorldNavigation(scene()), source = [];
  const corners = [p(20, 20), p(100, 20), p(100, 100), p(20, 100)];
  for (let i = 0; i < WORLD_STEERING_LIMITS.inputPoints; i++) source.push({ ...corners[i % corners.length] });
  const result = prepareSteeringPath(nav, source, 20);
  assertSafe(nav, result, source);
  assert.ok(result.roundedCorners > 0 && result.roundedCorners < source.length - 2,
    "work limits retain the safe remaining original corners");
  assert.deepEqual(prepareSteeringPath(nav, source, 20), result);
  assert.equal(prepareSteeringPath(nav, [...source, p(170, 70)], 20), null);
});

test("braking begins before a turn and respects every future cap across changing walking speeds", () => {
  const nav = createWorldNavigation(scene()), result = prepareSteeringPath(nav, [p(20, 20), p(60, 20), p(60, 100)], 20);
  const firstSlow = result.speedLimits.findIndex(cap => cap < .8);
  assert.ok(firstSlow > 0);
  assert.ok(desiredSteeringSpeed(result, result.distances[firstSlow] - .25, 7.2, 16) < 7.2);
  for (const maxSpeed of [7.2, 6.5, 5.4, 7.2]) for (let at = 0; at < result.length; at += .17) {
    const actual = desiredSteeringSpeed(result, at, maxSpeed, 16);
    assert.ok(actual > 0 && actual <= maxSpeed);
    for (let i = 1; i < result.points.length; i++) if (result.distances[i] >= at) {
      const allowedSquared = (result.speedLimits[i] * maxSpeed) ** 2 + 32 * (result.distances[i] - at);
      assert.ok(actual * actual <= allowedSquared + 1e-8, `late braking at ${at} toward ${i}`);
    }
  }
});

test("a long final straight does not crawl, but decelerates to the exact final position", () => {
  const nav = createWorldNavigation(scene()), result = prepareSteeringPath(nav, [p(20, 20), p(170, 20)], 20);
  assert.equal(desiredSteeringSpeed(result, 100, 7.2, 16), 7.2);
  assert.ok(desiredSteeringSpeed(result, result.length - .1, 7.2, 16) < 2);
  assert.equal(desiredSteeringSpeed(result, result.length, 7.2, 16), 0);
  assert.equal(desiredSteeringSpeed(result, NaN, 7.2, 16), 0);
  assert.equal(desiredSteeringSpeed(result, 10, 0, 16), 0);
});
