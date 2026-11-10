import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { advanceForestDirector } = await vite.ssrLoadModule("/features/world/simulation/forest-director.ts");
const { canTraverse, isWalkable, createWorldNavigation } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { captureForestMemory } = await vite.ssrLoadModule("/features/world/state/memory/forest-memory.ts");
const { forestOutsideEdge } = await vite.ssrLoadModule("/features/world/activities/journeys/forest-outside-edge.ts");
const { isForestWater } = await vite.ssrLoadModule("/features/world/environment/water/forest-water.ts");
const { isForestOutsideRoute, forestOutsideJourneyBackpack: backpack, syncForestOutsideJourney: sync, forestOutsideJourneyFrame: frame } =
  await vite.ssrLoadModule("/features/world/activities/journeys/forest-outside-journey.ts");
const scene = previewWorldScene(TILED_WORLD, initialPreviewLevels(TILED_WORLD)), start = 1_000_000;
const journey = (routeId = "ancient_ruins") => ({ id: `outside-${routeId}`, routeId,
  startedAt: new Date(start).toISOString(), finishesAt: new Date(start + 3_600_000).toISOString(), rewards: { stone: 1 } });
const create = () => connectForestSession(undefined, scene, "world", start, 0, () => {}, { persistence: false, sync: false });
function advance(state, job, now, until, cancelled = []) {
  for (let step = 0; step < 6000 && !until(); step++) {
    sync(state, scene, job, now, false, cancelled);
    if (until()) break;
    const before = { ...state.clearing.position }, outside = state.journeyTravel?.outside;
    advanceForestDirector(state, .1, { autoLife: false, blocked: true, explicitTravel: state.journeyTravel?.phase !== "away",
      actorAway: state.journeyTravel?.phase === "away", homeAvailable: true, dusk: 0, rain: 0, butterflies: "off", fireflies: "off" });
    assert(Math.hypot(state.clearing.position.x - before.x, state.clearing.position.y - before.y) <= state.clearing.size * .36 * .1 + .01,
      "every physical footstep belongs to the bounded walker");
    if (!state.clearing.activeInteraction) assert(canTraverse(state.clearing.navigation, before, state.clearing.position));
    if (outside?.crossing) assert.deepEqual(state.clearing.position, outside.entry, "the portal never moves navigation feet beyond the map");
  }
  sync(state, scene, job, now, false, cancelled);
  assert(until(), "the bounded visual walk must reach its target");
}

test("outside classification uses authored routes, keeps local work local and preserves old distant jobs", () => {
  for (const route of ["uplands", "far_bank_path", "far_bank_grove", "ancient_ruins", "forest_camp", "cave", "deep_cave", "abandoned_quarry"])
    assert.equal(isForestOutsideRoute(route), true, route);
  for (const route of [undefined, "unknown", "forest", "old_woodland", "coastal_deposits", "shore", "shore_camp", "quarry_work", "quarry_stone_hour", "quarry_shift"])
    assert.equal(isForestOutsideRoute(route), false, String(route));
});

test("fresh distant work walks to a real edge, crosses the map and returns through the same entry", () => {
  const session = create(), state = session.state, job = journey(), original = structuredClone(job);
  try {
    state.explorationId = null;
    assert.equal(backpack(state, scene), false, "no confirmed controller means no worn expedition gear");
    const feet = { ...state.clearing.position };
    assert.equal(sync(state, scene, job, start, false, []), true);
    assert.deepEqual(state.clearing.position, feet); assert.equal(state.journeyTravel.phase, "leaving");
    assert.equal(backpack(state, scene), true);
    assert.equal(backpack(state, { ...scene }), false, "a different scene cannot borrow the prop");
    const outside = state.journeyTravel.outside;
    assert.equal(outside.unavailable, undefined);
    assert(isWalkable(state.clearing.navigation, outside.entry));
    assert(Math.min(outside.entry.x, outside.entry.y, scene.width - outside.entry.x, scene.height - outside.entry.y) <= 36);
    const memory = captureForestMemory(state, scene);
    assert(!JSON.stringify(memory).includes(job.id));
    advance(state, job, start, () => state.journeyTravel.outside.crossing === "out");
    assert.deepEqual({ x: frame(state, scene).x, y: frame(state, scene).y }, outside.entry);
    state.director.elapsed += outside.duration * .5;
    const middle = frame(state, scene);
    assert.equal(middle.opacity, 1); assert.equal(middle.pose, "walk");
    assert.notDeepEqual({ x: middle.x, y: middle.y }, outside.entry);
    state.director.elapsed += outside.duration * .5;
    const last = frame(state, scene);
    assert(last.x < 0 || last.y < 0 || last.x > scene.width || last.y > scene.height);
    sync(state, scene, job, start, false, []);
    assert.equal(state.journeyTravel.phase, "away"); assert.equal(frame(state, scene), null);
    assert.equal(backpack(state, scene), false, "no detached backpack is left on the map");
    const entry = { ...outside.entry };
    sync(state, scene, job, start + 3_600_000, false, []);
    assert.equal(state.journeyTravel.phase, "returning"); assert.equal(outside.crossing, "in");
    assert.equal(backpack(state, scene), true, "the same worn pack returns with the body");
    assert.deepEqual({ x: frame(state, scene).x, y: frame(state, scene).y }, outside.offscreen);
    advance(state, job, start + 3_600_000, () => !state.journeyTravel);
    assert.deepEqual(state.clearing.position, state.clearing.home);
    assert.equal(backpack(state, scene), false, "gear is removed only after reaching home");
    assert.deepEqual(outside.entry, entry); assert.equal(state.clearing.requestedPoint, null);
    assert(state.director.nextDecisionAt > state.director.elapsed);
    assert.deepEqual(job, original, "cosmetic travel cannot edit paid results or deadlines");
  } finally { session.release(); }
});

test("cancellation reverses an unfinished crossing without a position jump or a new departure", () => {
  const session = create(), state = session.state, job = journey("uplands");
  try {
    state.explorationId = null; sync(state, scene, job, start, false, []);
    advance(state, job, start, () => state.journeyTravel.outside.crossing === "out");
    const outside = state.journeyTravel.outside;
    state.director.elapsed += outside.duration * .4;
    const before = frame(state, scene);
    sync(state, scene, job, start + 1000, false, [job.id]);
    const after = frame(state, scene), phaseAt = outside.phaseAt;
    assert.equal(outside.crossing, "in");
    assert.equal(backpack(state, scene), true, "cancellation keeps the pack on the visible return");
    assert(Math.hypot(after.x - before.x, after.y - before.y) < 1e-7);
    for (let i = 0; i < 5; i++) sync(state, scene, job, start + 1000, false, [job.id]);
    assert.equal(outside.phaseAt, phaseAt);
    advance(state, job, start + 1000, () => Boolean(state.journeyTravel?.outside.completed), [job.id]);
    assert.deepEqual(state.clearing.position, state.clearing.home);
    sync(state, scene, job, start + 2000, false, []);
    assert.equal(state.journeyTravel.outside.completed, true, "a stale cancelled snapshot cannot send the same actor away again");
    assert.equal(backpack(state, scene), false, "a completed cancellation receipt cannot redress the hero");
    sync(state, scene, null, start + 2000, false, []); assert.equal(state.journeyTravel, undefined);
  } finally { session.release(); }
});

test("wall-clock updates and reduced motion cannot advance a visible edge crossing", () => {
  const session = create(), state = session.state, job = journey();
  try {
    state.explorationId = null; sync(state, scene, job, start, false, []);
    advance(state, job, start, () => state.journeyTravel.outside.crossing === "out");
    state.director.elapsed += .5;
    const before = frame(state, scene, true);
    for (const now of [start + 60_000, start + 600_000, start + 600_000]) sync(state, scene, job, now, true, []);
    assert.deepEqual(frame(state, scene, true), before);
    assert.equal(frame(state, scene, true).frame, 0);
    assert.equal(backpack(state, scene), true, "reduced motion freezes the journey but keeps its worn gear");
    const feet = { ...state.clearing.position };
    sync(state, scene, null, start + 700_000, true, []);
    const returning = frame(state, scene, true);
    assert(Math.hypot(returning.x - before.x, returning.y - before.y) < 1e-7);
    assert.deepEqual(state.clearing.position, feet);
  } finally { session.release(); }
});

test("only initial restoration may place an old job at its safe hidden entry", () => {
  for (const observed of [false, true]) {
    const session = create(), state = session.state, job = journey();
    try {
      if (observed) state.explorationId = null;
      const feet = { ...state.clearing.position };
      sync(state, scene, job, start + 60_000, false, []);
      assert.equal(state.journeyTravel.phase, observed ? "leaving" : "away");
      assert.equal(backpack(state, scene), observed);
      if (!observed) {
        sync(state, scene, job, start + 3_600_000, false, []);
        assert.equal(backpack(state, scene), true, "a restored off-map job returns wearing its pack");
      }
      assert.deepEqual(state.clearing.position, observed ? feet : state.journeyTravel.outside.entry);
      const travel = state.journeyTravel;
      for (let i = 0; i < 5; i++) sync(state, scene, job, observed ? start + 60_000 : start + 3_600_000, false, []);
      assert.strictEqual(state.journeyTravel, travel);
    } finally { session.release(); }
  }
});

test("outside assignments defer another basket, tackle cleanup and mining portal", () => {
  const session = create(), state = session.state, job = journey();
  try {
    for (const previous of [{ gathering: { tool: "basket" }, phase: "packing" }, { ending: {}, phase: "fishing" }, { mining: {}, phase: "exiting" }]) {
      state.journeyTravel = { jobId: "previous", ...previous };
      const saved = state.journeyTravel;
      assert.equal(sync(state, scene, job, start, false, []), false);
      assert.strictEqual(state.journeyTravel, saved);
      assert.equal(backpack(state, scene), false, "local props finish before the distant pack can be worn");
    }
  } finally { session.release(); }
});

test("disconnected or missing edge land never creates a new navigation corridor", () => {
  const enclosed = { ...scene, width: 400, height: 400, actor: { spawn: { x: 200, y: 200 }, size: 50 },
    sites: [], paths: [], lights: [], campfires: [], navigation: { ...scene.navigation,
      areas: [{ id: "island", points: [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }] }], obstacles: [] } };
  const nav = createWorldNavigation(enclosed, 5);
  assert(nav);
  assert.equal(forestOutsideEdge(enclosed, nav, { x: 200, y: 200 }, 50), null);
});

test("the actual map exits on a land road even when departure begins beside the eastern pier", () => {
  const session = create(), state = session.state;
  try {
    const pier = { x: 1227.5, y: 747.5 };
    assert(isWalkable(state.clearing.navigation, pier), "the old wrong exit was navigable, so walkability alone is insufficient");
    for (const from of [state.clearing.home, pier]) {
      const edge = forestOutsideEdge(scene, state.clearing.navigation, from, state.clearing.size);
      assert(edge, "an authored land road must remain reachable");
      assert(!(edge.entry.x > 1200 && edge.entry.y > 600), "the pier and its shoreline cannot be an off-map land route");
      assert(!(edge.offscreen.x > scene.width && edge.entry.y > 600), "the visual crossing cannot leave across eastern water");
      for (let step = 0; step <= 100; step++) {
        const p = step / 100, point = { x: edge.entry.x + (edge.offscreen.x - edge.entry.x) * p,
          y: edge.entry.y + (edge.offscreen.y - edge.entry.y) * p };
        if (point.x >= 0 && point.y >= 0 && point.x <= scene.width && point.y <= scene.height)
          assert.equal(isForestWater(scene, point), false, "the entire visible edge strip stays over land");
      }
    }
  } finally { session.release(); }
});

test("circle and map cameras share the same crossing without resetting feet, clock or route", () => {
  const key = "outside-handoff", circle = connectForestSession(key, scene, "circle", start, 0, () => {}, { persistence: false, sync: false });
  circle.configure("circle", true);
  const state = circle.state, job = journey("far_bank_grove");
  state.explorationId = null; sync(state, scene, job, start, false, []);
  advance(state, job, start, () => state.journeyTravel.outside.crossing === "out");
  state.director.elapsed += .4;
  const before = frame(state, scene), travel = state.journeyTravel, feet = { ...state.clearing.position };
  const map = connectForestSession(key, scene, "world", start + 500, 0, () => {}, { persistence: false, sync: false });
  try {
    map.configure("world", true); assert.equal(circle.isOwner(), false); assert.equal(map.isOwner(), true);
    assert.strictEqual(map.state, state);
    sync(map.state, scene, job, start + 500, false, []);
    assert.strictEqual(state.journeyTravel, travel); assert.deepEqual(frame(state, scene), before);
    assert.deepEqual(state.clearing.position, feet);
  } finally { map.release(); circle.release(); }
});

test("a scene without reachable edge land keeps the visible actor and consumes no job", () => {
  const session = create(), state = session.state, job = journey();
  try {
    state.explorationId = null; state.clearing.navigation = null;
    const before = { ...state.clearing.position };
    sync(state, scene, job, start, false, []);
    assert.equal(state.journeyTravel.outside.unavailable, true); assert.equal(state.journeyTravel.phase, "leaving");
    assert.equal(frame(state, scene), null); assert.deepEqual(state.clearing.position, before);
    sync(state, scene, job, start + 3_600_000, false, []);
    assert.equal(state.journeyTravel, undefined); assert.deepEqual(state.clearing.position, before);
  } finally { session.release(); }
});
