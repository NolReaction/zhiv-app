import assert from "node:assert/strict";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { requestForestDirective, requestForestGardenHarvest, advanceForestDirector } = await vite.ssrLoadModule("/features/world/simulation/forest-director.ts");
const { syncForestGardenProduction } = await vite.ssrLoadModule("/features/world/activities/garden/forest-garden.ts");
const { clearingActivityFrame } = await vite.ssrLoadModule("/features/world/simulation/clearing-activity.ts");
const { forestGardenVisualFrame } = await vite.ssrLoadModule("/features/world/activities/garden/forest-garden-painter.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const calm = { autoLife: false, blocked: false, dusk: 0, rain: 0, homeAvailable: true };

test("a real harvest preserves basket position through pickup, walking, collecting and parking", () => {
  for (const [level, size] of [[1, 50], [5, 56]]) {
    const scene = withPlacedBushArtwork(previewWorldScene(TILED_WORLD, { home: level }));
    scene.actor.size = size;
    const session = connectForestSession(undefined, scene, "circle", 0, 0, () => {}), state = session.state;
    session.release();
    const garden = state.life.garden;
    garden.bushes.forEach(bush => { bush.growth = 1; });
    requestForestDirective(state, "harvest-berries", calm);
    const phases = new Set();
    let previous = null, delivered = false;
    for (let tick = 0; tick < 3600; tick++) {
      advanceForestDirector(state, .025, calm);
      const motion = clearingActivityFrame(state.clearing);
      const frame = forestGardenVisualFrame(garden, { x: motion.x, y: motion.y, size }, motion);
      const phase = garden.routine?.phase ?? "done";
      // A parked basket stores its coordinates in position; held baskets use x/y.
      const position = frame?.basket ?? garden.basket?.position;
      assert.ok(position, `level ${level} has a basket position`);
      if (previous && previous.phase !== phase) {
        const jump = Math.hypot(position.x - previous.x, position.y - previous.y);
        assert.ok(jump < size * .03,
          `level ${level}: ${previous.phase} -> ${phase} jumps ${jump} world units`);
      }
      previous = { phase, x: position.x, y: position.y };
      phases.add(phase);
      if (phase === "done" && garden.basket.berries === 3) { delivered = true; break; }
    }
    assert.ok(delivered, `level ${level} completes an actual harvest`);
    for (const phase of ["take-basket", "approach-bush", "collect", "return-basket", "deposit", "settle"])
      assert.ok(phases.has(phase), `level ${level} exercises ${phase}`);
  }
});

test("a long active lesson keeps the real hero awake for the first authorized berry collection", () => {
  const scene = withPlacedBushArtwork(previewWorldScene(TILED_WORLD, { home: 1 }));
  const session = connectForestSession(undefined, scene, "world", 0, 0, () => {}), state = session.state;
  session.release();
  const options = { ...calm, autoLife: true, tutorialActive: true }, garden = state.life.garden;
  const crop = { jobId: "intro-raspberries", itemId: "berries", startedAt: new Date(0).toISOString(),
    finishesAt: new Date(600_000).toISOString() };
  syncForestGardenProduction(garden, crop, 0);
  for (let tick = 0; tick < 2400; tick++) {
    advanceForestDirector(state, .1, options);
    const motion = clearingActivityFrame(state.clearing);
    assert.equal(motion.homeSleeping, false);
    assert.equal(["sleep", "drowsy", "yawn"].includes(motion.pose), false);
  }
  assert.ok(state.clearing.idleSeconds >= 180, "reading a lesson does not simulate user movement or refresh inactivity");
  syncForestGardenProduction(garden, { ...crop, collection: { batchId: "intro-batch",
    startedAt: new Date(600_000).toISOString(), finishesAt: new Date(608_000).toISOString() } }, 600_000);
  const request = { requestId: 1, jobId: crop.jobId };
  requestForestGardenHarvest(state, request, options);
  assert.equal(garden.harvestEvent?.status, "started", "the real collection does not fall back because the hero slept");
  const phases = new Set();
  for (let tick = 0; tick < 4800 && garden.harvestEvent?.status !== "completed"; tick++) {
    advanceForestDirector(state, .025, options);
    if (garden.routine) phases.add(garden.routine.phase);
  }
  assert.deepEqual(garden.harvestEvent, { ...request, status: "completed" });
  for (const phase of ["take-basket", "approach-bush", "collect", "return-basket", "deposit"])
    assert.ok(phases.has(phase), `the first tutorial crop visibly performs ${phase}`);
});

test("one authorized mixed harvest makes one basket trip and emits one completion for the exact batch", () => {
  const scene = withPlacedBushArtwork(previewWorldScene(TILED_WORLD, { home: 5 }));
  const session = connectForestSession(undefined, scene, "world", 60_000, 0, () => {}), state = session.state;
  session.release();
  const garden = state.life.garden;
  const orders = ['berries', 'blackberries', 'cranberries'].map((itemId, index) => ({
    jobId: `batch-${index}`, itemId, startedAt: new Date(0).toISOString(), finishesAt: new Date(60_000).toISOString(),
    collection: { batchId: 'batch', startedAt: new Date(60_000).toISOString(), finishesAt: new Date(68_000).toISOString() },
  }));
  syncForestGardenProduction(garden, { ...orders[0], orders }, 60_000);
  const request = { requestId: 9, jobId: orders[0].jobId, jobIds: orders.map(order => order.jobId) };
  requestForestGardenHarvest(state, request, calm);
  const transitions = [], observedSpecies = new Set();
  let previous = null;
  for (let tick = 0; tick < 4800 && garden.harvestEvent?.status !== 'completed'; tick++) {
    advanceForestDirector(state, .025, calm);
    const phase = garden.routine?.phase;
    if (phase && phase !== previous) transitions.push(phase);
    previous = phase;
    const motion = clearingActivityFrame(state.clearing);
    const frame = forestGardenVisualFrame(garden, { x: motion.x, y: motion.y, size: scene.actor.size }, motion);
    if (frame?.pickedBerry) observedSpecies.add(frame.pickedBerry.itemId);
  }
  assert.deepEqual(garden.harvestEvent, { ...request, status: 'completed' });
  for (const phase of ['approach-basket', 'take-basket', 'approach-bush', 'collect', 'return-basket', 'deposit'])
    assert.equal(transitions.filter(value => value === phase).length, 1, `${phase} occurs once for all ready slots`);
  assert.deepEqual([...observedSpecies], orders.map(order => order.itemId));
  assert.equal(garden.basket.berries, 0, 'the visual batch does not invent three inventory rewards');
  assert.deepEqual(garden.basket.position, garden.basket.homePosition);
});

test("mixed harvest rejects missing, unripe and differently accepted batch members", () => {
  for (const invalid of ['missing', 'unripe', 'other-batch']) {
    const scene = withPlacedBushArtwork(previewWorldScene(TILED_WORLD, { home: 5 }));
    const session = connectForestSession(undefined, scene, "world", 60_000, 0, () => {}), state = session.state;
    session.release();
    const first = { jobId: 'first', itemId: 'berries', startedAt: new Date(0).toISOString(), finishesAt: new Date(60_000).toISOString(),
      collection: { batchId: 'batch', startedAt: null, finishesAt: null } };
    const second = { ...first, jobId: 'second', itemId: 'blueberries',
      finishesAt: new Date(invalid === 'unripe' ? 120_000 : 60_000).toISOString(),
      collection: { ...first.collection, batchId: invalid === 'other-batch' ? 'another' : 'batch' } };
    const garden = state.life.garden;
    syncForestGardenProduction(garden, { ...first, orders: invalid === 'missing' ? [first] : [first, second] }, 60_000);
    requestForestGardenHarvest(state, { requestId: 1, jobId: first.jobId, jobIds: [first.jobId, second.jobId] }, calm);
    assert.equal(garden.harvestEvent.status, 'unavailable');
    assert.equal(garden.harvest, null); assert.equal(garden.routine, null);
    assert.equal(garden.basket.berries, 0);
  }
});
