import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingActionFrame, fishingWaterTarget, FOREST_FISHING_CYCLE_SECONDS, FISHING_WATER_LIMITS } = await vite.ssrLoadModule("/features/world/forest-fishing.ts");
const { isForestWater } = await vite.ssrLoadModule("/features/world/forest-water.ts");
const polygon = (x, y, width, height) => ({ points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] });
const scene = () => ({ width: 300, height: 300, water: { surfaces: [polygon(120, 0, 180, 300)], exclusions: [] } });

test("fishing completes a visible cast, wait, bite, reel, catch and pack without inventory ownership", () => {
  const actions = [], first = fishingActionFrame(0);
  for (let elapsed = 0; elapsed < FOREST_FISHING_CYCLE_SECONDS; elapsed += .025) {
    const frame = fishingActionFrame(elapsed);
    if (actions.at(-1) !== frame.action) actions.push(frame.action);
    assert.ok(frame.phase >= 0 && frame.phase <= 1);
    assert.ok(frame.frame >= 0 && frame.frame <= 3);
    assert.equal(frame.carryingFish, ["catch", "pack", "rest"].includes(frame.action));
    if (frame.action === "catch" || frame.action === "pack" && frame.phase < .6) {
      assert.equal(frame.basketFilled, false, "the first fish remains in the paw until it reaches the basket");
    }
    if (frame.action === "pack" && frame.phase > .7 || frame.action === "rest") assert.equal(frame.basketFilled, true);
    assert.equal(fishingActionFrame(elapsed + FOREST_FISHING_CYCLE_SECONDS).basketFilled, true,
      "the previous catch stays in the basket throughout the next cycle");
  }
  assert.deepEqual(actions, ["idle", "cast", "fish", "bite", "reel", "catch", "pack", "rest"]);
  assert.deepEqual(fishingActionFrame(FOREST_FISHING_CYCLE_SECONDS), { ...first, carryingFish: true, basketFilled: true });
  assert.deepEqual(Object.keys(first).sort(), ["action", "basketFilled", "carryingFish", "frame", "phase"]);
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
