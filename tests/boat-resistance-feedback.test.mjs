import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { boatReelFeedback } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-feedback.ts");
const { boatResistanceFeedback } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-resistance-feedback.ts");

test("phase advice explains real preparations and recovery while immediate direction keeps priority", () => {
  for (const phase of ["preparing", "surging", "recovering"]) {
    const stable = boatResistanceFeedback(phase, boatReelFeedback({ bar: 5000, fish: 5000, progress: 3000 }, 3200));
    assert.ok(stable.phaseLabel); assert.notEqual(stable.title, "Рыба в зоне");
    for (const fish of [1000, 9000]) for (const progress of [1000, 8000]) {
      const correction = boatReelFeedback({ bar: 5000, fish, progress }, 3200);
      const described = boatResistanceFeedback(phase, correction);
      assert.equal(described.title, correction.title); assert.equal(described.instruction, correction.instruction);
      assert.equal(described.urgent, correction.urgent); assert.equal(described.direction, correction.direction);
    }
  }
});

test("legacy cruising keeps the original feedback with no invented surge cue", () => {
  const feedback = boatReelFeedback({ bar: 5000, fish: 5000, progress: 2500 }, 3200);
  for (const phase of [undefined, "cruising"]) assert.deepEqual(boatResistanceFeedback(phase, feedback), { ...feedback, phaseLabel: null });
});
