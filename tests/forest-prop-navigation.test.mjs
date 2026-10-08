import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createWorldNavigation, canTraverse, canTraverseWorldObstacle, findWorldPath, isWalkable,
  withWorldNavigationObstacle } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { createClearingActivity, setClearingNavigationObstacle, requestClearingPoint,
  advanceClearingActivity, isClearingAtPoint, requestClearingBush, requestClearingSleep } = await vite.ssrLoadModule("/features/world/simulation/clearing-activity.ts");
const point = (x, y) => ({ x, y });
const rect = (x, y, width, height) => [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
const scene = () => ({ schemaVersion: 1, id: "prop-navigation", width: 400, height: 400,
  terrain: [], sites: [], focus: { x: 50, y: 50, width: 300, height: 300 },
  actor: { spawn: point(200, 210), size: 40 },
  paths: [{ id: "legacy", behavior: "clearing", activity: "look", points: [point(200, 210), point(240, 210)] }],
  navigation: { version: 1, cellSize: 5, areas: [{ id: "grass", points: rect(140, 145, 140, 140) }],
    obstacles: [], interests: [] } });
const conditions = { enabled: true, blocked: false, dusk: 0, rain: 0 };
const footprint = rect(218, 207, 10, 6);

test("parked prop navigation is session-local and lifting restores the shared static profile", () => {
  const source = scene(), first = createClearingActivity(source, 1), second = createClearingActivity(source, 2);
  const base = first.navigation, cells = base.grid.walkable.slice(), originalDebug = JSON.stringify(base.debug);
  assert.equal(second.navigation, base);
  // Populate static edge caches before creating the temporary variant.
  findWorldPath(base, point(200, 210), point(250, 210));
  const originalStats = structuredClone(base.stats);
  assert.equal(setClearingNavigationObstacle(first, footprint), true);
  const temporary = first.navigation;
  assert.notEqual(temporary, base);
  assert.equal(canTraverse(temporary, point(200, 210), point(250, 210)), false);
  assert.equal(canTraverse(second.navigation, point(200, 210), point(250, 210)), true);
  const path = findWorldPath(temporary, point(200, 210), point(250, 210));
  assert.ok(path?.length > 2);
  for (let index = 1; index < path.length; index++) assert.ok(canTraverse(temporary, path[index - 1], path[index]));
  assert.deepEqual(base.grid.walkable, cells);
  assert.equal(JSON.stringify(base.debug), originalDebug);
  assert.deepEqual(base.stats, originalStats);
  setClearingNavigationObstacle(first, footprint.map(point => ({ ...point })));
  assert.equal(first.navigation, temporary, "stationary prop does not rebuild the grid every tick");
  setClearingNavigationObstacle(first, null);
  assert.equal(first.navigation, base);
  assert.equal(canTraverse(first.navigation, point(200, 210), point(250, 210)), true);
});

test("a newly dropped basket replans an existing walk without moving the feet through it", () => {
  const state = createClearingActivity(scene(), 1), target = point(250, 210);
  assert.equal(requestClearingPoint(state, target), true);
  assert.equal(state.freeRoute.points.length, 2);
  for (let i = 0; i < 10; i++) advanceClearingActivity(state, .025, conditions);
  const beforeDrop = { ...state.position };
  assert.equal(setClearingNavigationObstacle(state, footprint), true);
  assert.deepEqual(state.position, beforeDrop);
  let detoured = false;
  for (let i = 0; i < 3000 && !isClearingAtPoint(state, target); i++) {
    const before = { ...state.position };
    advanceClearingActivity(state, .025, conditions);
    assert.ok(Math.hypot(before.x - state.position.x, before.y - state.position.y) <= state.size * .36 * .025 + .001);
    assert.ok(canTraverseWorldObstacle(state.navigation, before, state.position));
    assert.ok(isWalkable(state.navigation, state.position));
    detoured ||= Math.abs(state.position.y - target.y) > 5;
  }
  assert.equal(detoured, true);
  assert.ok(isClearingAtPoint(state, target));
});

test("legacy paths pause before a parked prop and resume after it is lifted", () => {
  const state = createClearingActivity(scene(), 1);
  setClearingNavigationObstacle(state, footprint);
  const options = { ...conditions, navigationMode: "routes" };
  let paused = false;
  for (let i = 0; i < 2000 && !paused; i++) {
    const before = { ...state.position };
    advanceClearingActivity(state, .025, options);
    assert.ok(canTraverseWorldObstacle(state.navigation, before, state.position));
    paused = state.behavior.reason === "parked-prop-blocked";
  }
  assert.equal(paused, true);
  const foot = { ...state.position };
  for (let i = 0; i < 40; i++) advanceClearingActivity(state, .025, options);
  assert.deepEqual(state.position, foot);
  setClearingNavigationObstacle(state, null);
  for (let i = 0; i < 1000 && state.stage !== "activity"; i++) advanceClearingActivity(state, .025, options);
  assert.equal(state.stage, "activity");
  assert.deepEqual(state.position, point(240, 210));
});

test("temporary footprints reject malformed geometry and never replace the static obstacles", () => {
  const source = scene(); source.navigation.obstacles.push({ id: "stone", points: rect(180, 180, 8, 8) });
  const base = createWorldNavigation(source), temporary = withWorldNavigationObstacle(base, footprint);
  assert.equal(isWalkable(temporary, point(184, 184)), false);
  assert.equal(isWalkable(temporary, point(223, 210)), false);
  assert.equal(isWalkable(base, point(223, 210)), true);
  for (const invalid of [[], [point(0, 0)], [point(1, 1), point(2, 2), point(3, 3)],
    [point(0, 0), point(NaN, 1), point(2, 2)]]) assert.equal(withWorldNavigationObstacle(base, invalid), null);
});

test("session hydration rejects an old saved position inside the parked basket", async () => {
  const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
  const { forestMemoryKey } = await vite.ssrLoadModule("/features/world/state/memory/forest-memory.ts");
  const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
  const map = withPlacedBushArtwork(TILED_WORLD), records = new Map();
  const environment = { now: () => 1000, storage: {
    getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value),
    removeItem: key => records.delete(key),
  } };
  const account = "basket-position-hydration";
  const connect = () => connectForestSession(account, map, "circle", 1000, 0, () => {}, { environment, sync: false });
  const first = connect(), position = { ...first.state.life.garden.basket.position };
  assert.equal(isWalkable(first.state.clearing.navigation, position), false);
  first.release();
  const key = forestMemoryKey(account), old = JSON.parse(records.get(key));
  old.hero.position = position; records.set(key, JSON.stringify(old));
  const next = connect();
  try {
    assert.equal(next.state.memory.restored, true);
    assert.notDeepEqual(next.state.clearing.position, position);
    assert.ok(isWalkable(next.state.clearing.navigation, next.state.clearing.position));
  } finally { next.release(); }
});

test("a parked prop cannot be bypassed by a scripted doorway or bush jump", async () => {
  const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
  const map = withPlacedBushArtwork(TILED_WORLD);
  for (const kind of ["home", "bush"]) {
    const state = createClearingActivity(map, 1);
    const interaction = kind === "home" ? state.interactions.home : state.interactions.bushes[0];
    assert.ok(interaction);
    const destination = kind === "home" ? interaction.doorway : interaction.hide;
    const middle = point((interaction.entry.x + destination.x) / 2, (interaction.entry.y + destination.y) / 2);
    setClearingNavigationObstacle(state, rect(middle.x - 2, middle.y - 2, 4, 4));
    const before = { ...state.position };
    assert.equal(kind === "home" ? requestClearingSleep(state) : requestClearingBush(state), false);
    assert.deepEqual(state.position, before);
    assert.equal(state.activeInteraction, null);
    assert.equal(state.behavior.reason, `${kind}-blocked-by-prop`);
  }
});
