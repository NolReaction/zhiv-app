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
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { advanceForestDirector } = await vite.ssrLoadModule("/features/world/forest-director.ts");
const { requestClearingSleep, advanceClearingActivity } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { forestJourneyWalking, forestJourneyEnding, forestJourneyActorAway, forestJourneyFishingFrame, syncForestJourneyTravel } = await vite.ssrLoadModule("/features/world/forest-journey-travel.ts");
const { FOREST_FISHING_FIRST_CATCH_SECONDS, FOREST_FISHING_CYCLE_SECONDS } = await vite.ssrLoadModule("/features/world/forest-fishing.ts");
const { captureForestMemory } = await vite.ssrLoadModule("/features/world/forest-memory.ts");
const { canTraverse } = await vite.ssrLoadModule("/features/world/navigation.ts");
const scene = previewWorldScene(TILED_WORLD, initialPreviewLevels(TILED_WORLD));
const start = 1_000_000;
const journey = (routeId = "shore") => ({ id: `test-${routeId}`, startedAt: new Date(start).toISOString(),
  finishesAt: new Date(start + 600_000).toISOString(), routeId, label: "Прибрежная вылазка" });
const create = () => connectForestSession(undefined, scene, "world", start, 0, () => {}, { persistence: false, sync: false });
function advance(state, job, now, seconds, until = () => false) {
  for (let elapsed = 0; elapsed < seconds && !until(); elapsed += .05) {
    const before = { ...state.clearing.position };
    syncForestJourneyTravel(state, scene, job, now + elapsed * 1000, false);
    const walking = forestJourneyWalking(state), away = forestJourneyActorAway(state, job, now + elapsed * 1000);
    advanceForestDirector(state, .05, { autoLife: false, blocked: walking || away || forestJourneyEnding(state), actorAway: away,
      explicitTravel: walking, homeAvailable: true, dusk: 0, rain: 0, butterflies: "off", fireflies: "off" });
    assert.ok(Math.hypot(state.clearing.position.x - before.x, state.clearing.position.y - before.y) <= state.clearing.size * .36 * .05 + .01,
      "the existing motion controller never teleports between route points");
    if (!state.clearing.activeInteraction) assert.ok(canTraverse(state.clearing.navigation, before, state.clearing.position));
  }
  syncForestJourneyTravel(state, scene, job, now + seconds * 1000, false);
}
function finishVisual(state, job, now, cancelled = []) {
  assert.equal(forestJourneyEnding(state), true);
  state.director.elapsed = state.journeyTravel.ending.endsAt;
  syncForestJourneyTravel(state, scene, job, now, false, cancelled);
  assert.equal(forestJourneyEnding(state), false);
}

test("new confirmed shore jobs walk, fish visibly, then return without owning server rewards", () => {
  for (const route of ["shore", "shore_camp"]) {
    const session = create(), state = session.state, job = journey(route), home = { ...state.clearing.position };
    syncForestJourneyTravel(state, scene, null, start, false);
    syncForestJourneyTravel(state, scene, job, start, false);
    assert.equal(state.journeyTravel.phase, "leaving"); assert.equal(forestJourneyActorAway(state, job, start), false);
    advance(state, job, start, 110, () => state.journeyTravel.phase === "fishing");
    assert.equal(state.journeyTravel.phase, "fishing");
    assert.deepEqual(state.clearing.position, state.journeyTravel.shore);
    assert.equal(forestJourneyActorAway(state, job, start + 110_000), false);
    assert.ok(forestJourneyFishingFrame(state, scene).waterTarget);
    assert.ok(!JSON.stringify(captureForestMemory(state, scene)).includes(job.id), "cosmetic memory does not persist job/travel ownership");
    syncForestJourneyTravel(state, scene, job, start + 600_000, false);
    finishVisual(state, job, start + 600_000);
    assert.equal(state.journeyTravel.phase, "returning"); assert.equal(forestJourneyActorAway(state, job, start + 600_000), false);
    advance(state, job, start + 600_000, 110, () => !state.journeyTravel);
    assert.equal(state.journeyTravel, undefined); assert.deepEqual(state.clearing.position, home);
    session.release();
  }
});

test("a restored active coastal job reconstructs one visible shore position without replaying departure", () => {
  const session = create(), state = session.state, job = journey();
  syncForestJourneyTravel(state, scene, job, start + 60_000, false);
  assert.equal(state.journeyTravel.phase, "fishing"); assert.equal(forestJourneyWalking(state), false);
  const before = { ...state.clearing.position };
  assert.deepEqual(before, state.journeyTravel.shore);
  assert.equal(forestJourneyActorAway(state, job, start + 60_000), false);
  for (let n = 0; n < 5; n++) syncForestJourneyTravel(state, scene, job, start + 60_000, false);
  assert.deepEqual(state.clearing.position, before);
  assert.ok(forestJourneyFishingFrame(state, scene));
  syncForestJourneyTravel(state, scene, job, start + 600_000, false);
  finishVisual(state, job, start + 600_000);
  assert.equal(state.journeyTravel.phase, "returning"); assert.deepEqual(state.clearing.position, before);
  session.release();
});

test("an active trip removed by the server returns from its actual feet with all caught fish forfeited", () => {
  const session = create(), state = session.state, job = journey();
  try {
    syncForestJourneyTravel(state, scene, job, start + 60_000, false);
    state.director.elapsed += FOREST_FISHING_FIRST_CATCH_SECONDS + 1;
    assert.equal(forestJourneyFishingFrame(state, scene).carryingFish, true, "there is visible caught fish before cancellation");
    const feet = { ...state.clearing.position };
    syncForestJourneyTravel(state, scene, null, start + 90_000, false);
    assert.equal(forestJourneyEnding(state), true, "the visible catch is put away before leaving");
    assert.equal(state.journeyTravel.cancelled, true, "server removal before the deadline also covers cancellation on another device");
    assert.deepEqual(state.clearing.position, feet);
    finishVisual(state, null, start + 90_000);
    assert.equal(state.journeyTravel.phase, "returning");
    assert.equal(forestJourneyFishingFrame(state, scene).carryingFish, false);
    const request = state.clearing.requestedPoint, beganAt = state.journeyTravel.beganAt;
    for (const timestamp of [start + 90_000, start + 95_000, start + 600_000]) {
      syncForestJourneyTravel(state, scene, null, timestamp, false, [job.id]);
      assert.deepEqual(state.clearing.position, feet);
      assert.strictEqual(state.clearing.requestedPoint, request);
      assert.equal(state.journeyTravel.beganAt, beganAt, "retry snapshots do not restart the return");
      assert.equal(forestJourneyFishingFrame(state, scene).carryingFish, false);
    }
    advance(state, null, start + 600_000, 110, () => !state.journeyTravel);
    assert.equal(state.journeyTravel, undefined);
    assert.deepEqual(state.clearing.position, state.clearing.home);
  } finally { session.release(); }
});

test("natural completion keeps caught fish but cancellation of a ready returning trip clears it without restarting motion", () => {
  for (const cancel of [false, true]) {
    const session = create(), state = session.state, job = journey();
    try {
      syncForestJourneyTravel(state, scene, job, start + 60_000, false);
      state.director.elapsed += FOREST_FISHING_FIRST_CATCH_SECONDS + 1;
      syncForestJourneyTravel(state, scene, job, start + 600_000, false);
      finishVisual(state, job, start + 600_000);
      assert.equal(state.journeyTravel.phase, "returning");
      assert.equal(forestJourneyFishingFrame(state, scene).carryingFish, true);
      advance(state, job, start + 600_000, 2);
      const feet = { ...state.clearing.position }, request = state.clearing.requestedPoint, beganAt = state.journeyTravel.beganAt;
      for (const timestamp of [start + 602_000, start + 620_000, start + 620_000]) {
        syncForestJourneyTravel(state, scene, null, timestamp, false, cancel ? [job.id] : ["other-trip"]);
        assert.deepEqual(state.clearing.position, feet);
        assert.strictEqual(state.clearing.requestedPoint, request);
        assert.equal(state.journeyTravel.beganAt, beganAt);
        assert.equal(forestJourneyFishingFrame(state, scene).carryingFish, !cancel);
        assert.equal(Boolean(state.journeyTravel.cancelled), cancel);
      }
      advance(state, null, start + 620_000, 110, () => !state.journeyTravel);
      assert.deepEqual(state.clearing.position, state.clearing.home);
    } finally { session.release(); }
  }
});

test("circle to map handoff preserves the exact feet, route and transient departure owner", () => {
  const key = "journey-camera-handoff";
  const circle = connectForestSession(key, scene, "circle", start, 0, () => {}, { persistence: false, sync: false });
  circle.configure("circle", true);
  const job = journey(), state = circle.state;
  syncForestJourneyTravel(state, scene, null, start, false); advance(state, job, start, 3);
  const before = { ...state.clearing.position }, travel = state.journeyTravel, route = state.clearing.freeRoute;
  const map = connectForestSession(key, scene, "world", start + 3_000, 0, () => {}, { persistence: false, sync: false });
  map.configure("world", true);
  assert.strictEqual(map.state, state); assert.equal(circle.isOwner(), false); assert.equal(map.isOwner(), true);
  syncForestJourneyTravel(map.state, scene, job, start + 3_000, false);
  assert.deepEqual(state.clearing.position, before); assert.strictEqual(state.journeyTravel, travel); assert.strictEqual(state.clearing.freeRoute, route);
  map.release(); assert.equal(circle.isOwner(), true); assert.deepEqual(state.clearing.position, before);
  circle.release();
});

test("finishing while walking turns back from current feet; claims do not wait for the return animation", () => {
  const session = create(), state = session.state, job = journey();
  syncForestJourneyTravel(state, scene, null, start, false);
  advance(state, job, start, 8);
  const before = { ...state.clearing.position }; assert.notDeepEqual(before, scene.actor.spawn);
  syncForestJourneyTravel(state, scene, null, start + 8_000, false);
  assert.equal(state.journeyTravel.phase, "returning"); assert.deepEqual(state.clearing.position, before);
  advance(state, null, start + 8_000, 30, () => !state.journeyTravel);
  assert.equal(state.journeyTravel, undefined); assert.deepEqual(state.clearing.position, scene.actor.spawn);
  session.release();
});

test("reduced motion shows a static fisherman and freezes a walk without jumping", () => {
  const session = create(), state = session.state, job = journey();
  syncForestJourneyTravel(state, scene, null, start, true);
  syncForestJourneyTravel(state, scene, job, start, true);
  assert.equal(state.journeyTravel.phase, "fishing");
  const frame = forestJourneyFishingFrame(state, scene, true), position = { ...state.clearing.position };
  assert.equal(frame.action, "fish"); assert.equal(frame.frame, 0);
  state.director.elapsed += 5;
  assert.deepEqual(forestJourneyFishingFrame(state, scene, true), frame);
  syncForestJourneyTravel(state, scene, null, start + 1, true);
  assert.equal(state.journeyTravel, undefined); assert.deepEqual(state.clearing.position, position);
  session.release();
  const moving = create(), other = moving.state;
  syncForestJourneyTravel(other, scene, null, start, false); advance(other, job, start, 5);
  const before = { ...other.clearing.position };
  syncForestJourneyTravel(other, scene, job, start + 5_000, true);
  assert.equal(other.journeyTravel.phase, "leaving"); assert.deepEqual(other.clearing.position, before);
  assert.equal(forestJourneyActorAway(other, job, start + 5_000), false);
  moving.release();
});

test("a sleeping hero exits the existing doorway before joining the shore road", () => {
  const session = create(), state = session.state, job = journey();
  assert.equal(requestClearingSleep(state.clearing), true);
  for (let n = 0; n < 2000 && state.clearing.stage !== "home-sleep"; n++) {
    advanceClearingActivity(state.clearing, .05, { enabled: true, blocked: false, homeAvailable: true, dusk: 1, rain: 0 });
  }
  assert.equal(state.clearing.stage, "home-sleep");
  syncForestJourneyTravel(state, scene, null, start, false);
  const doorway = { ...state.clearing.position };
  syncForestJourneyTravel(state, scene, job, start, false);
  assert.deepEqual(state.clearing.position, doorway); assert.equal(state.journeyTravel.phase, "leaving");
  advance(state, job, start, 115, () => state.journeyTravel.phase === "fishing");
  assert.equal(state.journeyTravel.phase, "fishing"); assert.deepEqual(state.clearing.position, state.journeyTravel.shore);
  session.release();
});

test("return yields to a newly authorized berry collection without cancelling its request", () => {
  const session = create(), state = session.state, job = journey();
  syncForestJourneyTravel(state, scene, null, start, false); advance(state, job, start, 8);
  syncForestJourneyTravel(state, scene, null, start + 8_000, false);
  assert.equal(state.journeyTravel.phase, "returning");
  state.life.garden.harvest = { request: { requestId: 7, jobId: "berries-1" }, phase: "pending" };
  state.pendingLife = "harvest-berries";
  syncForestJourneyTravel(state, scene, null, start + 8_050, false);
  assert.equal(state.journeyTravel, undefined); assert.equal(state.pendingLife, "harvest-berries");
  assert.equal(state.life.garden.harvest.request.jobId, "berries-1"); session.release();
});

test("a fishing hero uses session time, remains on safe feet and exposes all fishing actions", () => {
  const session = create(), state = session.state, job = journey();
  syncForestJourneyTravel(state, scene, job, start + 50_000, false);
  const position = { ...state.clearing.position }, actions = new Set();
  for (let index = 0; index < 600; index++) {
    const frame = forestJourneyFishingFrame(state, scene);
    actions.add(frame.action);
    advanceForestDirector(state, .05, { autoLife: true, blocked: true, actorAway: false,
      explicitTravel: false, homeAvailable: true, dusk: 0, rain: 0, butterflies: "off", fireflies: "off" });
    assert.deepEqual(state.clearing.position, position);
  }
  for (const action of ["cast", "fish", "bite", "reel", "catch", "pack", "rest"]) assert.ok(actions.has(action), action);
  const paused = forestJourneyFishingFrame(state, scene);
  for (let index = 0; index < 10; index++) assert.deepEqual(forestJourneyFishingFrame(state, scene), paused);
  syncForestJourneyTravel(state, scene, job, start + 600_000, false);
  assert.equal(forestJourneyFishingFrame(state, scene).carryingFish, true);
  session.release();
});

test("without nearby water the coastal hero stays visibly at rest instead of casting onto land", () => {
  const world = { ...scene, water: { ...scene.water, surfaces: [], exclusions: [] } };
  const session = connectForestSession(undefined, world, "world", start, 0, () => {}, { persistence: false, sync: false });
  const state = session.state, job = journey();
  syncForestJourneyTravel(state, world, job, start + 60_000, false);
  const frame = forestJourneyFishingFrame(state, world);
  assert.equal(state.journeyTravel.phase, "fishing");
  assert.equal(forestJourneyActorAway(state, job, start + 60_000), false);
  assert.equal(frame.action, "rest"); assert.equal(frame.waterTarget, undefined);
  session.release();
});

test("non-coastal jobs remain away and a replacement job cannot inherit the old fishing owner", () => {
  const session = create(), state = session.state, shore = journey(), cave = journey("cave");
  syncForestJourneyTravel(state, scene, shore, start, false);
  assert.ok(forestJourneyFishingFrame(state, scene));
  const position = { ...state.clearing.position };
  syncForestJourneyTravel(state, scene, cave, start + 1000, false);
  assert.equal(forestJourneyEnding(state), true);
  assert.equal(forestJourneyActorAway(state, cave, start + 1000), false, "old tackle is put away before the next job hides its actor");
  finishVisual(state, cave, start + 1000);
  assert.equal(state.journeyTravel, undefined); assert.equal(forestJourneyFishingFrame(state, scene), null);
  assert.equal(forestJourneyActorAway(state, cave, start + 1000), true);
  assert.deepEqual(state.clearing.position, position);
  session.release();
});

test("confirmed tackle remains locked to its trip and the selected species survives the return and cancellation", () => {
  const session = create(), state = session.state;
  const job = { ...journey(), fishing: { rodId: "river_rod", fishId: "fish_mooncarp" } };
  try {
    syncForestJourneyTravel(state, scene, job, start + 60_000, false);
    assert.equal(state.journeyTravel.rodId, "river_rod"); assert.equal(state.journeyTravel.catchSpecies, "fish_mooncarp");
    assert.equal(forestJourneyFishingFrame(state, scene).rodId, "river_rod");
    const beforeReading = structuredClone(state.journeyTravel);
    forestJourneyFishingFrame(state, scene); forestJourneyFishingFrame(state, scene, true);
    assert.deepEqual(state.journeyTravel, beforeReading, "sampling props does not mutate the selected result");
    state.director.elapsed = state.journeyTravel.fishingAt + FOREST_FISHING_FIRST_CATCH_SECONDS + .01;
    const firstCatch = forestJourneyFishingFrame(state, scene);
    assert.equal(firstCatch.action, "catch"); assert.equal(firstCatch.species, "fish_mooncarp");
    assert.equal(firstCatch.basketFilled, false); assert.equal(firstCatch.basketSpecies, undefined);
    state.director.elapsed = state.journeyTravel.fishingAt + 22;
    const firstPacked = forestJourneyFishingFrame(state, scene);
    assert.equal(firstPacked.action, "pack"); assert.equal(firstPacked.basketSpecies, "fish_mooncarp");
    const still = forestJourneyFishingFrame(state, scene, true);
    assert.equal(still.species, "fish_mooncarp"); assert.equal(still.carryingFish, false); assert.equal(still.basketFilled, false);
    // A later profile refresh can alter current equipment; only a new job ID
    // may acquire different tackle for this ongoing physical scene.
    syncForestJourneyTravel(state, scene, { ...job, fishing: { rodId: "willow_rod", fishId: "fish_silverfin" } }, start + 61_000, false);
    assert.equal(state.journeyTravel.rodId, "river_rod"); assert.equal(state.journeyTravel.catchSpecies, "fish_mooncarp");
    state.director.elapsed += FOREST_FISHING_FIRST_CATCH_SECONDS + 1;
    syncForestJourneyTravel(state, scene, job, start + 600_000, false);
    finishVisual(state, job, start + 600_000);
    assert.equal(state.journeyTravel.phase, "returning");
    const returning = forestJourneyFishingFrame(state, scene);
    assert.equal(returning.carryingFish, true); assert.equal(returning.basketSpecies, "fish_mooncarp");
    assert.equal(returning.rodId, "river_rod");
    const feet = { ...state.clearing.position };
    syncForestJourneyTravel(state, scene, null, start + 600_001, false, [job.id]);
    assert.equal(forestJourneyFishingFrame(state, scene).carryingFish, false);
    assert.deepEqual(state.clearing.position, feet);
    assert.ok(!JSON.stringify(captureForestMemory(state, scene)).includes("fish_mooncarp"), "economic catch ownership never enters visual memory");
  } finally { session.release(); }
});

test("new trip identities replace old gear while pre-fishing jobs retain the original visual fallback", () => {
  const session = create(), state = session.state;
  try {
    const first = { ...journey(), fishing: { rodId: "river_rod", fishId: "fish_reedperch" } };
    syncForestJourneyTravel(state, scene, first, start + 60_000, false);
    const next = { ...journey(), id: "next-shore", fishing: { rodId: "willow_rod", fishId: "fish_silverfin" } };
    syncForestJourneyTravel(state, scene, next, start + 61_000, true);
    assert.equal(state.journeyTravel.jobId, next.id); assert.equal(forestJourneyFishingFrame(state, scene).rodId, "willow_rod");
    assert.equal(state.journeyTravel.catchSpecies, "fish_silverfin");
    syncForestJourneyTravel(state, scene, { ...journey(), id: "legacy-shore" }, start + 62_000, true);
    assert.equal(state.journeyTravel.rodId, undefined); assert.equal(state.journeyTravel.catchSpecies, undefined);
    assert.equal(forestJourneyFishingFrame(state, scene).rodId, undefined);
  } finally { session.release(); }
});

test("deadlines finish a visible reel, catch and pack before settling without restarting from account refreshes", () => {
  for (const age of [FOREST_FISHING_FIRST_CATCH_SECONDS - 1, FOREST_FISHING_FIRST_CATCH_SECONDS + 1, 22,
    FOREST_FISHING_CYCLE_SECONDS + FOREST_FISHING_FIRST_CATCH_SECONDS + 1]) {
    const session = create(), state = session.state, job = journey();
    try {
      syncForestJourneyTravel(state, scene, job, start + 60_000, false);
      state.director.elapsed = state.journeyTravel.fishingAt + age;
      const before = forestJourneyFishingFrame(state, scene), feet = { ...state.clearing.position };
      syncForestJourneyTravel(state, scene, job, start + 600_000, false);
      assert.equal(forestJourneyEnding(state), true); assert.equal(state.journeyTravel.phase, "fishing");
      const ending = state.journeyTravel.ending;
      assert.deepEqual(forestJourneyFishingFrame(state, scene), before, "ending starts with the same held/hooked catch");
      assert.ok(ending.settleAt > state.director.elapsed, "this cast must reach its pack end first");
      assert.equal(ending.source.basketFilled, true); assert.equal(ending.source.action, "rest");
      for (const timestamp of [start + 600_000, start + 610_000, start + 620_000]) {
        syncForestJourneyTravel(state, scene, null, timestamp, false);
        assert.strictEqual(state.journeyTravel.ending, ending);
        assert.deepEqual(state.clearing.position, feet, "server time cannot advance the visual clock");
        assert.deepEqual(forestJourneyFishingFrame(state, scene), before);
      }
      state.director.elapsed = ending.settleAt;
      syncForestJourneyTravel(state, scene, job, start + 600_000, false);
      const folded = forestJourneyFishingFrame(state, scene);
      assert.equal(folded.action, "rest"); assert.equal(folded.settling.phase, 0);
      assert.strictEqual(folded.settling.from, ending.source);
      assert.equal(folded.waterTarget, undefined, "the destination pose carries its basket instead of aiming a new cast");
      assert.deepEqual(folded.settling.from.waterTarget, ending.source.waterTarget);
      finishVisual(state, job, start + 600_000);
      const returning = forestJourneyFishingFrame(state, scene);
      assert.equal(state.journeyTravel.phase, "returning"); assert.equal(returning.carryingFish, true);
      assert.equal(returning.basketSpecies, ending.source.basketSpecies, "the last packed species replaces any older displayed fish");
      assert.equal(returning.carryingBasket, true); assert.deepEqual(state.clearing.position, feet);
    } finally { session.release(); }
  }
});

test("claim or cancellation during waiting folds the exact visible tackle and cannot invent a later catch", () => {
  for (const cancel of [false, true]) for (const age of [.4, 2, 6, FOREST_FISHING_FIRST_CATCH_SECONDS - 3.4, 15.1]) {
    const session = create(), state = session.state, job = journey();
    try {
      syncForestJourneyTravel(state, scene, job, start + 60_000, false);
      state.director.elapsed = state.journeyTravel.fishingAt + age;
      const before = forestJourneyFishingFrame(state, scene), feet = { ...state.clearing.position };
      assert.ok(["idle", "cast", "fish", "bite", "reel"].includes(before.action));
      const timestamp = start + (cancel ? 90_000 : 600_000);
      syncForestJourneyTravel(state, scene, null, timestamp, false, cancel ? [job.id] : []);
      const ending = state.journeyTravel.ending, folded = forestJourneyFishingFrame(state, scene);
      assert.equal(ending.settleAt, state.director.elapsed);
      assert.deepEqual(folded.settling.from, before); assert.equal(folded.settling.phase, 0);
      assert.equal(folded.carryingFish, false); assert.equal(folded.basketFilled, false);
      state.director.elapsed += .3;
      syncForestJourneyTravel(state, scene, null, timestamp, false);
      assert.equal(forestJourneyEnding(state), true);
      assert.ok(Math.abs(forestJourneyFishingFrame(state, scene).settling.phase - .5) < 1e-8);
      assert.deepEqual(state.clearing.position, feet);
      finishVisual(state, null, timestamp, cancel ? [job.id] : []);
      const returning = forestJourneyFishingFrame(state, scene);
      assert.equal(returning.carryingFish, false); assert.equal(returning.basketSpecies, undefined);
      assert.equal(returning.carryingBasket, true, "empty fishing basket is still held on the return path");
    } finally { session.release(); }
  }
});

test("a cancellation receipt cleans an already visible catch but carries no old fish even before the account snapshot changes", () => {
  const session = create(), state = session.state, job = journey();
  try {
    syncForestJourneyTravel(state, scene, job, start + 60_000, false);
    state.director.elapsed = state.journeyTravel.fishingAt + FOREST_FISHING_FIRST_CATCH_SECONDS + .8;
    const original = structuredClone(job), before = forestJourneyFishingFrame(state, scene);
    syncForestJourneyTravel(state, scene, job, start + 90_000, false, [job.id]);
    assert.deepEqual(forestJourneyFishingFrame(state, scene), before, "the existing caught fish is put away visibly");
    finishVisual(state, job, start + 90_000, [job.id]);
    assert.equal(state.journeyTravel.cancelled, true); assert.equal(state.journeyTravel.phase, "returning");
    assert.equal(forestJourneyActorAway(state, job, start + 90_000), false);
    const returning = forestJourneyFishingFrame(state, scene);
    assert.equal(returning.carryingFish, false); assert.equal(returning.basketSpecies, undefined);
    assert.equal(returning.carryingBasket, true); assert.deepEqual(job, original);
    assert.ok(!JSON.stringify(captureForestMemory(state, scene)).includes(job.id));
  } finally { session.release(); }
});

test("camera handoff and pause preserve a pending pack; a berry request starts only after its visual cleanup", () => {
  const key = "finishing-camera-handoff";
  const circle = connectForestSession(key, scene, "circle", start, 0, () => {}, { persistence: false, sync: false });
  circle.configure("circle", true);
  const state = circle.state, job = journey();
  let map;
  try {
    syncForestJourneyTravel(state, scene, job, start + 60_000, false);
    state.director.elapsed = state.journeyTravel.fishingAt + FOREST_FISHING_FIRST_CATCH_SECONDS + 1;
    syncForestJourneyTravel(state, scene, job, start + 600_000, false);
    const ending = state.journeyTravel.ending, before = forestJourneyFishingFrame(state, scene), feet = { ...state.clearing.position };
    state.life.garden.harvest = { request: { requestId: 7, jobId: "berries-after-shore" }, phase: "pending" };
    state.pendingLife = "harvest-berries";
    map = connectForestSession(key, scene, "world", start + 601_000, 0, () => {}, { persistence: false, sync: false });
    map.configure("world", true);
    syncForestJourneyTravel(map.state, scene, null, start + 601_000, false);
    assert.strictEqual(map.state, state); assert.strictEqual(state.journeyTravel.ending, ending);
    assert.deepEqual(forestJourneyFishingFrame(state, scene), before); assert.deepEqual(state.clearing.position, feet);
    finishVisual(state, null, start + 601_000);
    assert.equal(state.journeyTravel, undefined); assert.equal(state.pendingLife, "harvest-berries");
    assert.equal(state.life.garden.harvest.request.jobId, "berries-after-shore");
    assert.deepEqual(state.clearing.position, feet);
  } finally { map?.release(); circle.release(); }
});

test("reduced motion finishes a pending cleanup immediately at the same physical feet", () => {
  const session = create(), state = session.state, job = journey();
  try {
    syncForestJourneyTravel(state, scene, job, start + 60_000, false);
    state.director.elapsed = state.journeyTravel.fishingAt + FOREST_FISHING_FIRST_CATCH_SECONDS + 1;
    syncForestJourneyTravel(state, scene, job, start + 600_000, false);
    const feet = { ...state.clearing.position };
    assert.equal(forestJourneyEnding(state), true);
    syncForestJourneyTravel(state, scene, job, start + 600_000, true);
    assert.equal(forestJourneyEnding(state), false); assert.equal(state.journeyTravel, undefined);
    assert.deepEqual(state.clearing.position, feet);
  } finally { session.release(); }
});
