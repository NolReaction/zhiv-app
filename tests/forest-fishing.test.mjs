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
const { FISHING_PACK_RELEASE } = await vite.ssrLoadModule("/features/world/fishing-props.ts");
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
  assert.deepEqual(fishingActionFrame(FOREST_FISHING_CYCLE_SECONDS), { ...first, carryingFish: true, basketFilled: true,
    species: "fish_reedperch", basketSpecies: "fish_silverfin" });
  assert.deepEqual(forestFishingCatchState(FOREST_FISHING_CYCLE_SECONDS), { caught: 3, packed: 3 });
});

test("four decorative species stay consistent through each catch and only enter the basket after packing", () => {
  const species = new Set(); let lastPacked;
  for (let elapsed = 0; elapsed < FOREST_FISHING_CYCLE_SECONDS * 2; elapsed += .025) {
    const frame = fishingActionFrame(elapsed);
    if (frame.action === "catch") species.add(frame.species);
    if (frame.basketSpecies !== lastPacked) {
      assert.equal(frame.action, "pack", "a new cast cannot repaint fish already in the basket");
      assert.ok(frame.phase >= .68 - 1e-8);
      assert.equal(frame.basketSpecies, frame.species); lastPacked = frame.basketSpecies;
    }
  }
  assert.deepEqual([...species].sort(), ["fish", "fish_mooncarp", "fish_reedperch", "fish_silverfin"]);
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

test("the saved first catch species appears in the hand and enters the basket only at the pack release", () => {
  const selected = "fish_mooncarp";
  const firstCatch = FOREST_FISHING_FIRST_CATCH_SECONDS;
  const firstPack = firstCatch + 2.4, release = firstPack + 2.2 * FISHING_PACK_RELEASE;
  const before = fishingActionFrame(firstCatch - .001, false, selected);
  assert.equal(before.carryingFish, false); assert.equal(before.basketFilled, false);
  const caught = fishingActionFrame(firstCatch + .001, false, selected);
  assert.equal(caught.action, "catch"); assert.equal(caught.species, selected);
  assert.equal(caught.carryingFish, true); assert.equal(caught.basketFilled, false);
  assert.equal(caught.basketSpecies, undefined, "a lifted catch is not already lying in the basket");
  for (const age of [firstPack + .001, release - .001]) {
    const frame = fishingActionFrame(age, false, selected);
    assert.equal(frame.action, "pack"); assert.equal(frame.species, selected);
    assert.equal(frame.basketFilled, false); assert.equal(frame.basketSpecies, undefined);
  }
  const packed = fishingActionFrame(release + .001, false, selected);
  assert.equal(packed.action, "pack"); assert.equal(packed.basketFilled, true); assert.equal(packed.basketSpecies, selected);
  for (const age of [firstCatch + .1, firstPack + .1, release + .1, 25]) {
    const normal = fishingActionFrame(age), confirmed = fishingActionFrame(age, false, selected);
    const visual = frame => ({ ...frame, species: undefined, basketSpecies: undefined });
    assert.deepEqual(visual(confirmed), visual(normal), "server identity cannot change timing or invent extra caught fish");
  }
});

test("the first packed species survives a missed cast, then later catches keep their ordinary variety", () => {
  const selected = "fish_mooncarp", caughtSpecies = new Set();
  let missedWithFirstBasket = false, laterPacked = false;
  for (let age = 23; age < FOREST_FISHING_CYCLE_SECONDS * 3; age += .05) {
    const normal = fishingActionFrame(age), frame = fishingActionFrame(age, false, selected);
    const stock = forestFishingCatchState(age);
    if (stock.packed === 1) {
      assert.equal(frame.basketSpecies, selected, "the next cast cannot repaint the already packed first catch");
      if (frame.outcome === "miss") missedWithFirstBasket = true;
    } else if (stock.packed > 1) {
      laterPacked = true;
      assert.equal(frame.basketSpecies, normal.basketSpecies, "later successful packing updates the displayed basket normally");
    }
    if (age >= 26) assert.equal(frame.species, normal.species, "the override belongs to the first cast, not every repeated cycle");
    if (frame.action === "catch") caughtSpecies.add(frame.species);
    assert.equal(frame.carryingFish, normal.carryingFish); assert.equal(frame.basketFilled, normal.basketFilled);
  }
  assert.ok(missedWithFirstBasket && laterPacked);
  assert.deepEqual([...caughtSpecies].sort(), ["fish", "fish_mooncarp", "fish_reedperch", "fish_silverfin"]);
  const still = fishingActionFrame(0, true, selected);
  assert.equal(still.species, selected); assert.equal(still.carryingFish, false); assert.equal(still.basketFilled, false);
  assert.equal(still.basketSpecies, undefined);
  assert.deepEqual(fishingActionFrame(100000, true, selected), still, "static accessibility never fabricates a catch from elapsed time");
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
