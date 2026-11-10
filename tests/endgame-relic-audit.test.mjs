import assert from "node:assert/strict";
import test from "node:test";
import { expectedUniformQuotaDraws, simulateConditionalAcquisition } from "../scripts/audit-endgame-relics.mjs";

test("three-type acquisition counts surplus cores and repeated rare types", () => {
  assert.equal(expectedUniformQuotaDraws([0, 0, 0]), 0);
  assert.equal(expectedUniformQuotaDraws([5, 0, 0]), 15);
  assert.equal(expectedUniformQuotaDraws([1, 1, 1]), 5.5);
  assert.ok(Math.abs(expectedUniformQuotaDraws([37, 12, 12]) - 111.0011485495297) < 1e-9);
  assert.ok(Math.abs(expectedUniformQuotaDraws([5, 3, 3]) - 16.921889288980335) < 1e-9);
  assert.throws(() => expectedUniformQuotaDraws([1, -1, 0]));
});

test("conditional sensitivity is reproducible and the declared shop budget pays for units", () => {
  const options = { needs: [1, 1, 1], hoursPerActor: 8, minSeconds: 100000000, maxSeconds: 100000000,
    budget: 450, weeklyPearls: 0, relicPrice: 150, samples: 20, seed: 726022 };
  const first = simulateConditionalAcquisition(options);
  assert.deepEqual(first, simulateConditionalAcquisition(options));
  assert.equal(first.meanDays, 3);
  assert.equal(first.p90Days, 3);
  const delayed = simulateConditionalAcquisition({ ...options, budget: 300, weeklyPearls: 150 });
  assert.equal(delayed.meanDays, 9);
});
