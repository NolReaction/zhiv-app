import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { economyGardenGrowth } = await vite.ssrLoadModule("/features/world/state/economy/economy-garden-state.ts");
const { syncForestGardenProduction, advanceForestGarden, gardenActionAvailable } = await vite.ssrLoadModule("/features/world/activities/garden/forest-garden.ts");
const { requestForestGardenHarvest, advanceForestDirector, noticeForestDirector } = await vite.ssrLoadModule("/features/world/simulation/forest-director.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { forestGardenBerries } = await vite.ssrLoadModule("/features/world/activities/garden/forest-garden-painter.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { createGardenCollectionController, economyGardenCrop } = await vite.ssrLoadModule("/features/economy/integration/garden-collection.ts");
const { captureForestMemory } = await vite.ssrLoadModule("/features/world/state/memory/forest-memory.ts");
const { isWithinHomeClearing } = await vite.ssrLoadModule("/features/world/simulation/clearing-activity.ts");
const calm = { autoLife: false, blocked: false, dusk: 0, rain: 0, homeAvailable: true };
const start = Date.parse("2026-10-04T10:00:00Z"), finish = start + 600_000;
const crop = { jobId: "berries-1", startedAt: new Date(start).toISOString(), finishesAt: new Date(finish).toISOString() };
function setup(view = "world") {
  const scene = withPlacedBushArtwork(previewWorldScene(TILED_WORLD, { home: 1 }));
  const session = connectForestSession(undefined, scene, view, finish, 0, () => {});
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

test("parallel species keep their wall-clock growth and visual places when selecting, claiming and replacing crops", () => {
  const { state, scene } = setup(), garden = state.life.garden;
  const jobs = ["berries", "blueberries", "cranberries"].map((itemId, index) => ({ id: `mixed-${index}`, kind: "production", targetId: "garden",
    startedAt: new Date(start + index * 1000).toISOString(), finishesAt: new Date(start + (index + 1) * 600_000).toISOString(), rewards: { [itemId]: 1 } }));
  const saved = { jobs }, before = structuredClone(saved), wallTime = start + 900_000;
  syncForestGardenProduction(garden, economyGardenCrop(saved), wallTime);
  assert.equal(garden.productionNow, wallTime);
  assert.equal(garden.bushes[0].growth, 1);
  const places = { ...garden.productionSlots };
  assert.equal(new Set(Object.values(places)).size, 3);
  assert.equal(economyGardenGrowth(garden.production.orders[0], wallTime), 1);
  assert.ok(economyGardenGrowth(garden.production.orders[1], wallTime) > .7);
  assert.ok(economyGardenGrowth(garden.production.orders[1], wallTime) < .98);
  assert.ok(economyGardenGrowth(garden.production.orders[2], wallTime) < .5);
  syncForestGardenProduction(garden, economyGardenCrop(saved, "mixed-2"), wallTime);
  assert.deepEqual({ ...garden.productionSlots }, places, "changing the picked crop cannot move surviving species");
  assert.equal(garden.bushes[0].growth, economyGardenGrowth(garden.production, wallTime));

  const replacement = { ...jobs[0], id: "replacement", startedAt: new Date(wallTime).toISOString(),
    finishesAt: new Date(wallTime + 60_000).toISOString(), rewards: { strawberries: 1 } };
  syncForestGardenProduction(garden, economyGardenCrop({ jobs: [...jobs.slice(1), replacement] }), wallTime);
  assert.equal(garden.productionSlots["mixed-1"], places["mixed-1"]);
  assert.equal(garden.productionSlots["mixed-2"], places["mixed-2"]);
  assert.equal(garden.productionSlots.replacement, places["mixed-0"], "a new crop reuses only the released visual place");
  assert.equal(Object.hasOwn(garden.productionSlots, "mixed-0"), false);
  const memory = captureForestMemory(state, scene);
  assert.deepEqual(Object.keys(memory.garden).sort(), ["basketBerries", "bushes"]);
  assert.equal(JSON.stringify(memory).includes("productionSlots"), false);
  assert.equal(JSON.stringify(memory).includes("cranberries"), false);
  assert.deepEqual(saved, before, "scene synchronization cannot award or change goods");
  syncForestGardenProduction(garden, null, wallTime + 60_000);
  assert.equal(Object.keys(garden.productionSlots).length, 0);
});

test("legacy scene DTOs retain their single crop and a selected extra paid crop remains visible", () => {
  const { state } = setup(), garden = state.life.garden;
  syncForestGardenProduction(garden, crop, finish);
  assert.deepEqual({ ...garden.productionSlots }, { [crop.jobId]: 0 });
  assert.equal(garden.bushes[0].growth, 1);
  const orders = Array.from({ length: 6 }, (_, index) => ({ ...crop, jobId: `old-${index}`, itemId: "strawberries",
    startedAt: new Date(start + index * 1000).toISOString() }));
  syncForestGardenProduction(garden, { ...orders.at(-1), orders }, finish);
  assert.equal(Object.keys(garden.productionSlots).length, 3);
  assert.equal(garden.productionSlots["old-5"], 2);
  assert.ok(Object.values(garden.productionSlots).every(slot => slot >= 0 && slot <= 2));
  syncForestGardenProduction(garden, { ...crop, orders: [] }, finish);
  assert.equal(garden.productionSlots[crop.jobId], 0, "an empty optional list keeps the primary legacy crop");
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

test("a hero outside the authored home clearing gathers at the server deadline without returning or waiting for a watchdog", () => {
  for (const view of ["circle", "world"]) for (const destination of ["workshop", "quarry", "fishing", "woodlot"]) {
    const { state, scene } = setup(view), garden = state.life.garden;
    state.clearing.position = { ...scene.destinations.find(item => item.id === destination).position };
    state.clearing.stage = "clearing";
    const before = structuredClone(state.clearing), basketBefore = structuredClone(garden.basket);
    assert.equal(isWithinHomeClearing(state.clearing), false, `${view}: ${destination} is outside the main clearing`);

    const job = { id: crop.jobId, kind: "production", targetId: "garden", ...crop, rewards: { berries: 6 },
      collection: { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null } };
    const snapshot = { ownerPublicId: "garden-owner", jobs: [job], storage: { available: 200 }, inventory: {} };
    const controller = createGardenCollectionController(snapshot.ownerPublicId), sent = [];
    const input = { snapshot, now: finish, busy: false, uncertain: false, retryAt: 0, sceneAvailable: true };
    const update = patch => controller.update({ ...input, ...patch }, (action, targetId) => sent.push({ action, targetId }));
    update({}); assert.equal(controller.start(job.id), true);
    const batchId = "780be3c1-d920-491c-8ffc-11b66757b224";
    job.collection.startedAt = new Date(finish).toISOString(); job.collection.finishesAt = new Date(finish + 8000).toISOString(); job.collection.batchId = batchId;
    update({});
    syncForestGardenProduction(garden, job, finish);
    requestForestGardenHarvest(state, controller.getSnapshot().request, calm);
    assert.equal(garden.harvestEvent.status, "unavailable");
    assert.match(garden.harvestEvent.reason, /вне поляны/);
    assert.equal(garden.harvest, null); assert.equal(garden.routine, null); assert.equal(state.pendingLife, null);
    assert.deepEqual(state.clearing, before, "presentation must preserve the distant actor's route and position");
    assert.deepEqual(garden.basket, basketBefore);

    controller.sceneEvent(garden.harvestEvent);
    assert.equal(controller.getSnapshot().phase, "waiting"); assert.equal(controller.getSnapshot().request, null);
    update({ now: finish + 7999 }); assert.equal(sent.length, 1, "no early reward before the authoritative eight seconds");
    update({ now: finish + 8000 });
    assert.deepEqual(sent, [{ action: "start_garden_collection", targetId: job.id }, { action: "claim_garden_collection", targetId: batchId }]);
    assert.deepEqual(snapshot.inventory, {}, "only the later server receipt may change stock");
    controller.sceneEvent(garden.harvestEvent); update({ now: finish + 9000 });
    assert.equal(sent.length, 2, "fallback does not send duplicate claims");
  }
});

test("the home-clearing polygon controls harvest eligibility even where the camera focus overlaps another trail", () => {
  const { state, scene } = setup();
  assert.equal(isWithinHomeClearing(state.clearing), true);
  state.clearing.position = { ...scene.navigation.areas.find(area => area.id === "home-clearing").points[0] };
  assert.equal(isWithinHomeClearing(state.clearing), true, "the authored boundary is part of the clearing");
  state.clearing.position = { x: scene.focus.x + scene.focus.width / 2, y: scene.focus.y + 1 };
  assert.equal(isWithinHomeClearing(state.clearing), false, "camera visibility alone cannot reserve the garden actor");
});
