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
const { forestJourneyWalking, forestJourneyActorAway, syncForestJourneyTravel } = await vite.ssrLoadModule("/features/world/forest-journey-travel.ts");
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

test("new confirmed shore jobs walk to the real shore, disappear there, then return without owning server rewards", () => {
  for (const route of ["shore", "shore_camp"]) {
    const session = create(), state = session.state, job = journey(route), home = { ...state.clearing.position };
    syncForestJourneyTravel(state, scene, null, start, false);
    syncForestJourneyTravel(state, scene, job, start, false);
    assert.equal(state.journeyTravel.phase, "leaving"); assert.equal(forestJourneyActorAway(state, job, start), false);
    advance(state, job, start, 110, () => state.journeyTravel.phase === "away");
    assert.equal(state.journeyTravel.phase, "away");
    assert.deepEqual(state.clearing.position, state.journeyTravel.shore);
    assert.equal(forestJourneyActorAway(state, job, start + 110_000), true);
    assert.ok(!JSON.stringify(captureForestMemory(state, scene)).includes(job.id), "cosmetic memory does not persist job/travel ownership");
    syncForestJourneyTravel(state, scene, job, start + 600_000, false);
    assert.equal(state.journeyTravel.phase, "returning"); assert.equal(forestJourneyActorAway(state, job, start + 600_000), false);
    advance(state, job, start + 600_000, 110, () => !state.journeyTravel);
    assert.equal(state.journeyTravel, undefined); assert.deepEqual(state.clearing.position, home);
    session.release();
  }
});

test("a restored active job stays away and does not replay departure when a camera opens", () => {
  const session = create(), state = session.state, job = journey(), before = { ...state.clearing.position };
  syncForestJourneyTravel(state, scene, job, start + 60_000, false);
  assert.equal(state.journeyTravel.phase, "away"); assert.equal(forestJourneyWalking(state), false);
  for (let n = 0; n < 5; n++) syncForestJourneyTravel(state, scene, job, start + 60_000, false);
  assert.deepEqual(state.clearing.position, before);
  syncForestJourneyTravel(state, scene, job, start + 600_000, false);
  assert.equal(state.journeyTravel, undefined); assert.deepEqual(state.clearing.position, before);
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

test("reduced motion and delayed existing jobs keep the previous static away behaviour without position writes", () => {
  for (const [still, age] of [[true, 0], [false, 30_000]]) {
    const session = create(), state = session.state, job = journey(), before = { ...state.clearing.position };
    syncForestJourneyTravel(state, scene, null, start, still);
    syncForestJourneyTravel(state, scene, job, start + age, still);
    assert.equal(state.journeyTravel.phase, "away"); assert.deepEqual(state.clearing.position, before);
    syncForestJourneyTravel(state, scene, null, start + age + 1, still);
    assert.equal(state.journeyTravel, undefined); assert.deepEqual(state.clearing.position, before);
    session.release();
  }
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
  advance(state, job, start, 115, () => state.journeyTravel.phase === "away");
  assert.equal(state.journeyTravel.phase, "away"); assert.deepEqual(state.clearing.position, state.journeyTravel.shore);
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
