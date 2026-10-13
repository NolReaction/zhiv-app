import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestWaterDynamics, disturbForestWater } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-dynamics.ts");
const { withForestWaterBuoyancy } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-buoyancy.ts");
const { fishingTackleFrame, fishingLineFrame } = await vite.ssrLoadModule("/features/world/activities/fishing/fishing-props.ts");
const scene = { width: 1254, height: 1254, water: { surfaces: [{ points: [
  { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 },
] }], exclusions: [] } };
const frame = { x: 100, y: 100, size: 50, direction: "front", action: "fish", phase: .3, frame: 0,
  waterTarget: { x: 100, y: 150 }, carryingFish: false };

test("surface buoyancy moves the tethered float without changing the rod stance target or simulation", () => {
  const water = createForestWaterDynamics(scene);
  assert.ok(disturbForestWater(water, frame.waterTarget));
  const before = structuredClone(water), target = structuredClone(frame);
  const floating = withForestWaterBuoyancy(frame, water, false);
  const originalTackle = fishingTackleFrame(frame, false), tackle = fishingTackleFrame(floating, false);
  assert.notDeepEqual(tackle.bobber, originalTackle.bobber);
  assert.deepEqual(tackle.grip, originalTackle.grip);
  assert.deepEqual(tackle.tip, originalTackle.tip);
  assert.strictEqual(floating.waterTarget, frame.waterTarget);
  assert.deepEqual(frame, target);
  assert.deepEqual(water, before);
  assert.deepEqual(fishingLineFrame(floating, false).float, tackle.bobber, "line ends at the displaced float");
});

test("surface displacement cannot move an airborne or retracted float and reduced motion stays still", () => {
  const water = createForestWaterDynamics(scene); disturbForestWater(water, frame.waterTarget);
  assert.strictEqual(withForestWaterBuoyancy(frame, water, true), frame);
  assert.strictEqual(withForestWaterBuoyancy(frame, undefined, false), frame);
  for (const action of ["cast", "reel", "catch", "idle"]) {
    const pose = { ...frame, action, phase: .3 };
    assert.deepEqual(fishingTackleFrame(withForestWaterBuoyancy(pose, water, false), false), fishingTackleFrame(pose, false));
  }
  const unsafe = { ...frame, waterDisplacement: { x: Infinity, y: NaN } };
  assert.deepEqual(fishingTackleFrame(unsafe, false), fishingTackleFrame(frame, false));
});
