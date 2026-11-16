import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { builderWorkDuration, fedConstructionDuration } = await vite.ssrLoadModule("/features/economy/domain/construction-meal.ts");

test("one cheap serving saves a fixed amount on long construction instead of scaling forever", () => {
  assert.equal(builderWorkDuration(14400, 1000, 0, 1800), 14237);
  assert.equal(builderWorkDuration(28800, 1000, 0, 1800), 28637);
  assert.equal(builderWorkDuration(600, 1000, 0, 1800), 546);
  assert.equal(builderWorkDuration(14400, 5000, 0, 9000), 11400);
});

test("legacy servings retain a whole-job bonus and zero budget never creates a meal benefit", () => {
  assert.equal(builderWorkDuration(14400, 1000, 0), 13091);
  assert.equal(fedConstructionDuration(14400000, 1000, 0), 13090910);
  assert.equal(builderWorkDuration(14400, 1000, 0, 0), 14400);
  assert.equal(fedConstructionDuration(14400000, 1000, 0, 0), 14400000);
});

test("feeding before a job and immediately after agree to display precision with frozen professional bonuses", () => {
  for (const seconds of [1, 601, 3600, 14400, 31536000]) for (const food of [0, 1000, 6500, 10000]) {
    for (const trade of [0, 500, 1000]) for (const skill of [0, 150, 300]) for (const budget of [60, 1800, 21600, undefined]) {
      const unfed = builderWorkDuration(seconds * 1000, 0, trade, 0, skill);
      const feedAfter = fedConstructionDuration(unfed, food, trade, budget == null ? undefined : budget * 1000, skill);
      const feedBefore = builderWorkDuration(seconds * 1000, food, trade, budget == null ? undefined : budget * 1000, skill);
      assert.ok(Math.abs(feedAfter - feedBefore) <= 1, "both entry points round the same promised finish conservatively");
      assert.ok(feedAfter <= unfed && feedAfter >= 0);
    }
  }
});

test("work already performed cannot be accelerated again and fractional milliseconds round safely", () => {
  assert.equal(fedConstructionDuration(1001, 10000, 0, 100000), 501);
  assert.equal(fedConstructionDuration(600000, 1000, 0, 1800000), 545455);
  assert.equal(fedConstructionDuration(0, 1000, 1000, 1800000, 300), 0);
});

test("invalid work and bonus inputs are rejected before doing arithmetic", () => {
  for (const args of [[-1, 1000, 0], [1.5, 1000, 0], [100, 10001, 0], [100, 1000, 1001], [100, 1000, 0, -1], [100, 1000, 0, 30, 501]]) {
    assert.throws(() => builderWorkDuration(...args), RangeError);
    assert.throws(() => fedConstructionDuration(...args), RangeError);
  }
});
