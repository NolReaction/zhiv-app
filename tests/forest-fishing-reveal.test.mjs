import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-fish-reveal-vite-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { syncForestJourneyTravel, forestJourneyFishingFrame } = await vite.ssrLoadModule("/features/world/activities/journeys/forest-journey-travel.ts");
const { economySceneJourney } = await vite.ssrLoadModule("/features/economy/integration/world-adapter.ts");
const scene = previewWorldScene(TILED_WORLD, initialPreviewLevels(TILED_WORLD));
const start = 1_000_000;
const finish = start + 600_000;
const masked = () => ({ id: "fish-reveal", routeId: "shore", startedAt: new Date(start).toISOString(),
  finishesAt: new Date(finish).toISOString(), rewards: { fish: 4 }, fishing: { rodId: "river_rod", fishId: "fish" } });
const reveal = job => ({ ...job, rewards: { fish: 1, fish_mooncarp: 1, fish_silverfin: 2 },
  fishing: { ...job.fishing, fishId: "fish_mooncarp", catchRevealed: true } });
const create = (job, still = false) => {
  const session = connectForestSession(undefined, scene, "world", start, 0, () => {}, { persistence: false, sync: false });
  syncForestJourneyTravel(session.state, scene, job, start + 60_000, still);
  assert.equal(session.state.journeyTravel.phase, "fishing");
  return session;
};
function firstCatch(state, job, phase = "catch") {
  const plan = state.journeyTravel.jobFishing;
  syncForestJourneyTravel(state, scene, job, start + (plan.catches[0].at - (phase === "pack" ? 1 : 3.4) * plan.unit) * 1000, false);
  assert.equal(forestJourneyFishingFrame(state, scene).action, phase);
}
const withoutArt = frame => ({ ...frame, species: undefined, basketSpecies: undefined });
const timing = plan => ({ duration: plan.duration, unit: plan.unit, catches: plan.catches.map(slot => slot.at) });
function completeCleanup(state, job, cancelled = []) {
  state.director.elapsed = state.journeyTravel.ending.endsAt;
  syncForestJourneyTravel(state, scene, job, finish, false, cancelled);
  assert.equal(state.journeyTravel.phase, "returning");
}

test("the economy adapter forwards the authoritative reveal marker and exact saved species without changing the job", () => {
  const projected = reveal(masked());
  const job = { ...projected, kind: "exploration", targetId: "shore" };
  const before = structuredClone(job);
  const result = economySceneJourney({ jobs: [job], catalog: { explorations: [] } });
  assert.deepEqual(result.rewards, before.rewards);
  assert.equal(result.fishing.catchRevealed, true);
  assert.equal(result.fishing.fishId, "fish_mooncarp");
  assert.notStrictEqual(result.rewards, job.rewards);
  assert.deepEqual(job, before);
});

test("an unrevealed same-job refresh cannot replace generic catch art with future species", () => {
  const job = masked(), session = create(job), state = session.state;
  try {
    firstCatch(state, job);
    const plan = state.journeyTravel.jobFishing;
    const hidden = reveal(job); hidden.fishing.catchRevealed = false;
    syncForestJourneyTravel(state, scene, hidden, start + state.journeyTravel.jobAge * 1000, false);
    assert.strictEqual(state.journeyTravel.jobFishing, plan);
    assert.equal(forestJourneyFishingFrame(state, scene).species, "fish");
    assert.equal(state.journeyTravel.catchSpecies, "fish");
    assert.ok(plan.catches.every(slot => slot.species === "fish"));
  } finally { session.release(); }
});

test("a revealed completed catch repaints the held fish and finite plan without replaying missed catch windows", () => {
  const job = masked(), session = create(job), state = session.state;
  try {
    firstCatch(state, job);
    const travel = state.journeyTravel, before = forestJourneyFishingFrame(state, scene);
    const beforeTiming = timing(travel.jobFishing), age = travel.jobAge, beganAge = travel.fishBeganAge;
    const feet = { ...state.clearing.position }, revealed = reveal(job), snapshot = structuredClone(revealed);
    syncForestJourneyTravel(state, scene, revealed, finish, false);
    assert.strictEqual(state.journeyTravel, travel);
    assert.deepEqual(state.clearing.position, feet);
    assert.equal(travel.jobAge, age); assert.equal(travel.fishBeganAge, beganAge);
    assert.deepEqual(timing(travel.jobFishing), beforeTiming);
    assert.equal(travel.catchSpecies, "fish_mooncarp");
    assert.deepEqual(withoutArt(forestJourneyFishingFrame(state, scene)), withoutArt(before));
    assert.equal(forestJourneyFishingFrame(state, scene).species, "fish_mooncarp");
    assert.equal(travel.ending.source.species, "fish_mooncarp", "tackle cleanup belongs to the packed fish, not the next species");
    assert.equal(travel.ending.source.basketSpecies, "fish_mooncarp");
    completeCleanup(state, revealed);
    assert.equal(forestJourneyFishingFrame(state, scene).basketSpecies, "fish_mooncarp");
    assert.equal(travel.basketCatchIndex, 0, "only the fish whose visible packing completed is carried");
    assert.deepEqual(revealed, snapshot, "cosmetic repainting cannot modify the server's rewards");
  } finally { session.release(); }
});

test("a reveal during cleanup updates art once without restarting its gesture or extending its earliest finish", () => {
  for (const phase of ["catch", "pack"]) {
    const job = masked(), session = create(job), state = session.state;
    try {
      firstCatch(state, job, phase);
      syncForestJourneyTravel(state, scene, job, finish, false);
      const ending = state.journeyTravel.ending, before = forestJourneyFishingFrame(state, scene);
      const deadlines = { settleAt: ending.settleAt, endsAt: ending.endsAt, finishAge: ending.finishAge };
      const revealed = reveal(job), feet = { ...state.clearing.position };
      syncForestJourneyTravel(state, scene, revealed, finish + 1, false);
      assert.strictEqual(state.journeyTravel.ending, ending);
      assert.deepEqual({ settleAt: ending.settleAt, endsAt: ending.endsAt, finishAge: ending.finishAge }, deadlines);
      assert.deepEqual(withoutArt(forestJourneyFishingFrame(state, scene)), withoutArt(before));
      assert.equal(ending.source.species, "fish_mooncarp", "adjacent ordinary fish cannot repaint the current catch/pack");
      assert.equal(ending.source.basketSpecies, "fish_mooncarp");
      const plan = state.journeyTravel.jobFishing, source = ending.source;
      for (let index = 0; index < 5; index++) syncForestJourneyTravel(state, scene, structuredClone(revealed), finish + 1, false);
      assert.strictEqual(state.journeyTravel.jobFishing, plan); assert.strictEqual(ending.source, source);
      assert.deepEqual(state.clearing.position, feet);
      completeCleanup(state, revealed);
      assert.equal(forestJourneyFishingFrame(state, scene).basketSpecies, "fish_mooncarp");
    } finally { session.release(); }
  }
});

test("a late revealed return repaints the already packed species while preserving its physical route", () => {
  const job = masked(), session = create(job), state = session.state;
  try {
    firstCatch(state, job);
    syncForestJourneyTravel(state, scene, job, finish, false); completeCleanup(state, job);
    const travel = state.journeyTravel, before = forestJourneyFishingFrame(state, scene);
    const feet = { ...state.clearing.position }, request = state.clearing.requestedPoint, route = state.clearing.freeRoute;
    const beganAt = travel.beganAt, revealed = reveal(job);
    syncForestJourneyTravel(state, scene, revealed, finish + 10_000, false);
    assert.strictEqual(state.journeyTravel, travel); assert.equal(travel.phase, "returning");
    assert.equal(travel.beganAt, beganAt); assert.strictEqual(state.clearing.requestedPoint, request);
    assert.strictEqual(state.clearing.freeRoute, route); assert.deepEqual(state.clearing.position, feet);
    assert.deepEqual(withoutArt(forestJourneyFishingFrame(state, scene)), withoutArt(before));
    assert.equal(forestJourneyFishingFrame(state, scene).basketSpecies, "fish_mooncarp");
  } finally { session.release(); }
});

test("cancelled fishing never adopts revealed species or carries its forfeited packed catch", () => {
  const job = masked(), session = create(job), state = session.state;
  try {
    firstCatch(state, job);
    const plan = state.journeyTravel.jobFishing, revealed = reveal(job);
    syncForestJourneyTravel(state, scene, revealed, finish, false, [job.id]);
    assert.strictEqual(state.journeyTravel.jobFishing, plan);
    completeCleanup(state, revealed, [job.id]);
    assert.equal(state.journeyTravel.cancelled, true);
    assert.equal(state.journeyTravel.basketCatchIndex, undefined);
    assert.equal(forestJourneyFishingFrame(state, scene).carryingFish, false);
    assert.equal(forestJourneyFishingFrame(state, scene).basketSpecies, undefined);
  } finally { session.release(); }
});

test("reduced motion accepts the revealed plan without adding casts, cleanup or a jump", () => {
  const job = masked(), session = create(job, true), state = session.state;
  try {
    const travel = state.journeyTravel, beforeTiming = timing(travel.jobFishing), feet = { ...state.clearing.position };
    syncForestJourneyTravel(state, scene, reveal(job), finish, true);
    assert.deepEqual(timing(travel.jobFishing), beforeTiming);
    assert.equal(travel.catchSpecies, "fish_mooncarp");
    assert.equal(travel.ending, undefined);
    assert.deepEqual(state.clearing.position, feet);
    assert.equal(state.journeyTravel, undefined);
  } finally { session.release(); }
});
