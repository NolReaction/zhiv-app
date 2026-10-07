import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { economyGardenGrowth } = await vite.ssrLoadModule("/features/world/economy-garden-state.ts");
const { syncForestGardenProduction, advanceForestGarden, gardenActionAvailable } = await vite.ssrLoadModule("/features/world/forest-garden.ts");
const { requestForestGardenHarvest, advanceForestDirector, noticeForestDirector } = await vite.ssrLoadModule("/features/world/forest-director.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { forestGardenBerries } = await vite.ssrLoadModule("/features/world/forest-garden-painter.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const calm = { autoLife: false, blocked: false, dusk: 0, rain: 0, homeAvailable: true };
const start = Date.parse("2026-10-04T10:00:00Z"), finish = start + 600_000;
const crop = { jobId: "berries-1", startedAt: new Date(start).toISOString(), finishesAt: new Date(finish).toISOString() };
function setup() {
  const scene = withPlacedBushArtwork(previewWorldScene(TILED_WORLD, { home: 1 }));
  const session = connectForestSession(undefined, scene, "world", finish, 0, () => {});
  session.release(); return { state: session.state, scene };
}
function until(state, predicate, settings = calm) {
  for (let frame = 0; frame < 4800 && !predicate(); frame++) advanceForestDirector(state, .025, settings);
  assert.ok(predicate(), `not reached: ${state.director.reason}, ${state.clearing.stage}`);
}

test("crop growth follows server dates across absence and clock correction, never reaches ready early", () => {
  assert.equal(economyGardenGrowth(crop, start - 1000), 0);
  assert.equal(economyGardenGrowth(crop, start + 300_000), .49);
  assert.ok(economyGardenGrowth(crop, finish - 1) < .98);
  assert.equal(economyGardenGrowth(crop, finish + 86400_000), 1);
  assert.equal(economyGardenGrowth(crop, start + 60_000), .098);
  for (const sample of [null, { ...crop, startedAt: "bad" }, { ...crop, finishesAt: crop.startedAt }])
    assert.equal(economyGardenGrowth(sample, finish), 0);
  assert.equal(economyGardenGrowth(crop, NaN), 0);
});

test("managed empty and growing bushes ignore legacy fruit, rain bonuses and autonomous harvest", () => {
  const { state, scene } = setup(), garden = state.life.garden;
  garden.bushes[0].growth = 1;
  syncForestGardenProduction(garden, null, finish);
  for (let frame = 0; frame < 100; frame++) advanceForestGarden(garden, .1, { rain: 1 });
  assert.equal(garden.bushes[0].growth, 0);
  assert.deepEqual(forestGardenBerries(scene, garden), []);
  syncForestGardenProduction(garden, crop, start + 300_000);
  for (let frame = 0; frame < 100; frame++) advanceForestGarden(garden, .1, { rain: 1 });
  assert.equal(garden.bushes[0].growth, .49);
  syncForestGardenProduction(garden, crop, finish);
  assert.equal(gardenActionAvailable(garden, "harvest-berries"), false, "a ripe server crop still needs a player request");
});

test("explicit harvest physically delivers even in rain, emits completion and never awards local berries", () => {
  const { state, scene } = setup(), garden = state.life.garden;
  garden.basket.berries = garden.basket.capacity;
  syncForestGardenProduction(garden, crop, finish);
  const request = { requestId: 1, jobId: crop.jobId }, rainy = { ...calm, rain: .9 };
  requestForestGardenHarvest(state, request, rainy);
  assert.deepEqual(garden.harvestEvent, { ...request, status: "started" }, "a loaded scene acknowledges the request before walking");
  const phases = new Set();
  for (let frame = 0; frame < 4800 && garden.harvestEvent?.status === "started"; frame++) {
    advanceForestDirector(state, .025, rainy);
    if (garden.routine) phases.add(garden.routine.phase);
  }
  assert.deepEqual(garden.harvestEvent, { ...request, status: "completed" });
  for (const phase of ["take-basket", "approach-bush", "collect", "return-basket", "deposit"])
    assert.ok(phases.has(phase), `visited ${phase}`);
  assert.equal(garden.basket.berries, garden.basket.capacity, "old decorative stock neither blocks nor gains economic goods");
  assert.equal(garden.bushes[0].growth, 1, "server crop is kept until authoritative claim response");
  assert.ok(forestGardenBerries(scene, garden).every(berry => berry.picked === 3 || berry.opacity === 0));
});

test("interruption restores ripe artwork without awarding anything and a later request may retry", () => {
  const { state, scene } = setup(), garden = state.life.garden;
  syncForestGardenProduction(garden, crop, finish);
  requestForestGardenHarvest(state, { requestId: 1, jobId: crop.jobId }, calm);
  until(state, () => garden.routine?.phase === "collect");
  noticeForestDirector(state);
  assert.equal(garden.harvestEvent.status, "interrupted");
  assert.equal(garden.basket.berries, 0);
  assert.equal(garden.bushes[0].growth, 1);
  assert.ok(forestGardenBerries(scene, garden).every(berry => berry.picked === 0 && berry.opacity === 1));
  requestForestGardenHarvest(state, { requestId: 2, jobId: crop.jobId }, calm);
  until(state, () => garden.harvestEvent?.status === "completed");
  assert.equal(garden.harvestEvent.requestId, 2);
  assert.equal(garden.basket.berries, 0);
});

test("reduced motion and stale requests report unavailable without inventing a physical delivery", () => {
  const { state } = setup(), garden = state.life.garden;
  syncForestGardenProduction(garden, crop, finish);
  requestForestGardenHarvest(state, { requestId: 1, jobId: crop.jobId }, { ...calm, reducedMotion: true });
  assert.equal(garden.harvestEvent.status, "unavailable");
  assert.equal(garden.routine, null); assert.equal(garden.basket.berries, 0);
  requestForestGardenHarvest(state, { requestId: 2, jobId: "old-job" }, calm);
  assert.equal(garden.harvestEvent.status, "unavailable");
  syncForestGardenProduction(garden, crop, start + 1000);
  requestForestGardenHarvest(state, { requestId: 3, jobId: crop.jobId }, calm);
  assert.equal(garden.harvestEvent.status, "unavailable");
});
