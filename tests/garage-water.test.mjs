import assert from "node:assert/strict";
import test from "node:test";
import { advanceGarageWaterMotion, garageWaterHeight, garageWaterRigTransform, initialGarageWaterMotion } from "../features/world/dev/boat-garage/garage-water-motion.mjs";
const close = (a, b, epsilon = 1e-8) => assert(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test("buoyancy trajectory is independent of ordinary render-frame partitions", () => {
  const run = frames => { let state = initialGarageWaterMotion(); for (let index = 0; index < frames * 8; index++) state = advanceGarageWaterMotion(state, 1 / frames, { beam: 900, centerX: 820 }); return state; };
  const slow = run(30), regular = run(60), quick = run(120);
  for (const state of [regular, quick]) {
    assert.equal(state.tick, slow.tick); close(state.heave, slow.heave); close(state.roll, slow.roll); close(state.velocity, slow.velocity);
  }
  assert(Math.abs(slow.heave) > .1, "surface force must move the boat");
});

test("the two sampled floats create a bounded roll and heave without accumulating drift", () => {
  let state = initialGarageWaterMotion(), minimum = 0, maximum = 0;
  for (let index = 0; index < 120 * 90; index++) {
    state = advanceGarageWaterMotion(state, 1 / 120, { beam: 240, amplitude: 30, centerX: 100 });
    assert(Number.isFinite(state.heave) && Number.isFinite(state.roll));
    assert(Math.abs(state.heave) <= 32 && Math.abs(state.roll) <= 3.2);
    minimum = Math.min(minimum, state.roll); maximum = Math.max(maximum, state.roll);
  }
  assert(minimum < -.05 && maximum > .05, "opposite wave slopes must rock both ways");
});

test("a flat surface stays at rest and zero elapsed time leaves pose unchanged", () => {
  let state = initialGarageWaterMotion();
  for (let index = 0; index < 600; index++) state = advanceGarageWaterMotion(state, 1 / 60, { amplitude: 0 });
  close(state.heave, 0); close(state.roll, 0); close(state.velocity, 0); close(state.angularVelocity, 0);
  assert.deepEqual(advanceGarageWaterMotion(state, 0), state);
  assert.equal(garageWaterRigTransform(state, { x: 300, y: 600 }), "translate(0 0.0000) rotate(0.0000 300 600)");
});

test("long/background frame gaps are bounded and waves are repeatable", () => {
  const fresh = initialGarageWaterMotion(), initial = structuredClone(fresh);
  const long = advanceGarageWaterMotion(fresh, 600, { beam: 700 });
  const bounded = advanceGarageWaterMotion(fresh, .25, { beam: 700 });
  assert.deepEqual(long, bounded); assert.deepEqual(fresh, initial);
  assert.equal(garageWaterHeight(123, 456, 12), garageWaterHeight(123, 456, 12));
  for (let index = 0; index < 100; index++) assert(Math.abs(garageWaterHeight(index * 37, index * .5, 30)) <= 30);
});
