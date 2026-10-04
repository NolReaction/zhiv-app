import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingActionFrame, fishingWaterTarget, FOREST_FISHING_CYCLE_SECONDS, FOREST_FISHING_FIRST_CATCH_SECONDS, forestFishingCatchState, FISHING_WATER_LIMITS } = await vite.ssrLoadModule("/features/world/forest-fishing.ts");
const { isForestWater } = await vite.ssrLoadModule("/features/world/forest-water.ts");
const polygon = (x, y, width, height) => ({ points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] });
const scene = () => ({ width: 300, height: 300, water: { surfaces: [polygon(120, 0, 180, 300)], exclusions: [] } });

test("four deterministic casts vary waiting, line checks, failed bites and large catches without owning inventory", () => {
  const outcomes = new Set(), variations = new Set(), sizes = new Set(), actions = new Set();
  const first = fishingActionFrame(0);
  let previousCaught = 0, previousPacked = 0, missedReels = 0, largeReels = 0;
  for (let elapsed = 0; elapsed < FOREST_FISHING_CYCLE_SECONDS; elapsed += .025) {
    const frame = fishingActionFrame(elapsed), stock = forestFishingCatchState(elapsed);
    outcomes.add(frame.outcome); variations.add(frame.variation); sizes.add(frame.catchScale); actions.add(frame.action);
    assert.ok(frame.phase >= 0 && frame.phase <= 1);
    assert.ok(frame.frame >= 0 && frame.frame <= 3);
    assert.equal(frame.carryingFish, stock.caught > 0);
    assert.equal(frame.basketFilled, stock.packed > 0);
    assert.ok(stock.caught >= previousCaught && stock.packed >= previousPacked);
    assert.ok(stock.packed <= stock.caught);
    if (frame.outcome === "miss") {
      assert.ok(!["catch", "pack"].includes(frame.action), "a failed cast cannot display or store a new fish");
      assert.equal(stock.caught, previousCaught); assert.equal(stock.packed, previousPacked);
      if (frame.action === "reel") { missedReels++; assert.equal(frame.variation, "escape"); }
    }
    if (frame.outcome === "large" && frame.action === "reel") {
      largeReels++; assert.equal(frame.variation, "struggle"); assert.ok(frame.catchScale > 1);
    }
    previousCaught = stock.caught; previousPacked = stock.packed;
  }
  assert.deepEqual([...outcomes], ["small", "miss", "large"]);
  for (const variation of ["calm", "check", "nibble", "struggle", "escape"]) assert.ok(variations.has(variation));
  for (const action of ["idle", "cast", "fish", "bite", "reel", "catch", "pack", "rest"]) assert.ok(actions.has(action));
  assert.ok(sizes.size >= 3 && missedReels > 0 && largeReels > 0);
  assert.equal(previousCaught, 3); assert.equal(previousPacked, 3);
  assert.deepEqual(fishingActionFrame(FOREST_FISHING_CYCLE_SECONDS), { ...first, carryingFish: true, basketFilled: true });
  assert.deepEqual(forestFishingCatchState(FOREST_FISHING_CYCLE_SECONDS), { caught: 3, packed: 3 });
});

test("a catch enters the hand before the basket, and interrupted or missed attempts cannot invent fish", () => {
  assert.ok(Math.abs(FOREST_FISHING_FIRST_CATCH_SECONDS - 17.8) < 1e-8);
  assert.deepEqual(forestFishingCatchState(FOREST_FISHING_FIRST_CATCH_SECONDS - .01), { caught: 0, packed: 0 });
  assert.deepEqual(forestFishingCatchState(FOREST_FISHING_FIRST_CATCH_SECONDS + .01), { caught: 1, packed: 0 });
  for (const age of [18, 19, 20.3]) {
    assert.equal(fishingActionFrame(age).carryingFish, true);
    assert.equal(fishingActionFrame(age).basketFilled, false);
  }
  assert.deepEqual(forestFishingCatchState(23), { caught: 1, packed: 1 });
  for (const age of [26, 32, 39, 42]) assert.deepEqual(forestFishingCatchState(age), { caught: 1, packed: 1 });
  assert.deepEqual(forestFishingCatchState(FOREST_FISHING_CYCLE_SECONDS * 10000 + 18), { caught: 30001, packed: 30000 });
});

test("reduced motion has a stable cast rod and paused simulation cannot advance the cycle", () => {
  assert.deepEqual(fishingActionFrame(0, true), fishingActionFrame(100000, true));
  assert.equal(fishingActionFrame(0, true).action, "fish");
  const paused = fishingActionFrame(15.5);
  for (let n = 0; n < 10; n++) assert.deepEqual(fishingActionFrame(15.5), paused);
  assert.deepEqual(fishingActionFrame(NaN), fishingActionFrame(0));
});

test("water target contains the complete ripple and rejects small authored exclusions", () => {
  const world = scene(), base = { x: 105, y: 150 }, size = 36;
  const target = fishingWaterTarget(world, base, size);
  assert.ok(target); assert.equal(isForestWater(world, target), true);
  for (let index = 0; index < 48; index++) {
    const angle = Math.PI * 2 * index / 48;
    assert.equal(isForestWater(world, { x: target.x + Math.cos(angle) * size * .249,
      y: target.y + Math.sin(angle) * size * .249 }), true);
  }
  const excluded = { ...world, water: { ...world.water, exclusions: [polygon(target.x - .1, target.y - .1, .2, .2)] } };
  const replacement = fishingWaterTarget(excluded, base, size);
  assert.ok(replacement); assert.ok(Math.hypot(replacement.x - target.x, replacement.y - target.y) > size * .25);
});

test("missing, malformed, distant or over-budget water never invents a fishing point", () => {
  const base = { x: 50, y: 150 };
  assert.equal(fishingWaterTarget({ ...scene(), water: undefined }, base, 36), undefined);
  assert.equal(fishingWaterTarget(scene(), { x: 10, y: 10 }, 36), undefined);
  assert.equal(fishingWaterTarget(scene(), base, NaN), undefined);
  assert.equal(fishingWaterTarget({ ...scene(), water: { surfaces: [{ points: [{ x: NaN, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] }], exclusions: [] } }, base, 36), undefined);
  assert.equal(fishingWaterTarget({ ...scene(), water: { surfaces: Array(FISHING_WATER_LIMITS.polygons + 1).fill(polygon(0, 0, 300, 300)), exclusions: [] } }, base, 36), undefined);
});
