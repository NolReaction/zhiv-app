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
const { forestJourneyWalking, forestJourneyActorAway, forestJourneyFishingFrame, syncForestJourneyTravel } = await vite.ssrLoadModule("/features/world/forest-journey-travel.ts");
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
    advanceForestDirector(state, .05, { autoLife: false, blocked: walking || away, actorAway: away,
      explicitTravel: walking, homeAvailable: true, dusk: 0, rain: 0, butterflies: "off", fireflies: "off" });
    assert.ok(Math.hypot(state.clearing.position.x - before.x, state.clearing.position.y - before.y) <= state.clearing.size * .36 * .05 + .01,
      "the existing motion controller never teleports between route points");
    if (!state.clearing.activeInteraction) assert.ok(canTraverse(state.clearing.navigation, before, state.clearing.position));
  }
  syncForestJourneyTravel(state, scene, job, now + seconds * 1000, false);
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
  assert.equal(state.journeyTravel.phase, "returning"); assert.deepEqual(state.clearing.position, before);
  session.release();
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
  assert.equal(state.journeyTravel, undefined); assert.equal(forestJourneyFishingFrame(state, scene), null);
  assert.equal(forestJourneyActorAway(state, cave, start + 1000), true);
  assert.deepEqual(state.clearing.position, position);
  session.release();
});
