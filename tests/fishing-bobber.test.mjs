import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingBobberMotion } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-bobber.ts");
const frame = { stage: "reeling", held: true, resistancePhase: "surging", reel: { bar: 2000, fish: 9000, progress: 5000, zoneWidth: 3200 } };

test("surface float movement stays bounded in CSS pixels and follows public strain without changing a replay", () => {
  const original = structuredClone(frame), points = [];
  for (let index = 0; index < 600; index++) {
    const motion = fishingBobberMotion(frame, index / 30, false); points.push(motion);
    assert.ok(Object.values(motion).every(Number.isFinite));
    assert.ok(Math.abs(motion.x) <= 6.01); assert.ok(Math.abs(motion.y) <= 2.01);
    assert.ok(motion.dip >= 0 && motion.dip <= 4.41); assert.ok(Math.abs(motion.tilt) <= .281);
  }
  assert.notDeepEqual(points[0], points[30]);
  assert.deepEqual(frame, original);
  assert.ok(fishingBobberMotion(frame, 0, false).tension > fishingBobberMotion({ ...frame, stage: "soaking" }, 0, false).tension);
});

test("reduced motion freezes the same held state while actual input may retain static tension feedback", () => {
  assert.deepEqual(fishingBobberMotion(frame, 0, true), fishingBobberMotion(frame, 900, true));
  assert.notEqual(fishingBobberMotion(frame, 0, true).dip, fishingBobberMotion({ ...frame, held: false }, 0, true).dip);
  assert.ok(Object.values(fishingBobberMotion(frame, NaN, false)).every(Number.isFinite));
});
