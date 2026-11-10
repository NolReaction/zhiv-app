import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingBiteMotion } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-bite.ts");
const { paintFishingCatchEffects } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-catch-effects.ts");

test("a quiet pre-bite nibble precedes one definite dip without changing the server stage", () => {
  const waiting = fishingBiteMotion("soaking", 2, 1.5, false);
  const nibble = fishingBiteMotion("soaking", 2, .4, false);
  const bite = fishingBiteMotion("bite", .24, 0, false);
  assert.equal(waiting.dip, 0); assert.ok(nibble.dip > 1 && nibble.dip < 3);
  assert.ok(bite.dip > nibble.dip * 3 && bite.notice > .5);
  assert.equal(fishingBiteMotion("soaking", 2, undefined, false).dip, 0, "old challenges cannot invent a pre-bite time");
  assert.equal(fishingBiteMotion("waiting", 2, .3, false).dip, 0);
});

test("bite attention settles and reduced motion leaves a stable readable sunk float", () => {
  const settled = fishingBiteMotion("bite", 1.4, 0, false);
  assert.equal(settled.notice, 0); assert.equal(settled.dip, 6);
  assert.ok(fishingBiteMotion("bite", 1.81, 0, false).dip > 10, "the float tugs again while the player can still hook");
  const samples = Array.from({ length: 240 }, (_, index) => fishingBiteMotion("bite", index / 20, 0, false));
  assert.ok(samples.every(sample => sample.dip >= 0 && sample.dip <= 12));
  assert.deepEqual(fishingBiteMotion("bite", .1, 0, true), fishingBiteMotion("bite", 300, 0, true));
});

test("catch glow and droplets require a confirmed species and finish completely", () => {
  const calls = [], gradient = { addColorStop() {} };
  const ctx = new Proxy({}, { get(object, key) { if (key in object) return object[key];
    if (key === "createRadialGradient") return () => gradient;
    return (...args) => calls.push([key, args]); } });
  const frame = { stage: "caught", fishId: "fish_mooncarp", fishRarity: "rare", fishSizeScale: 1.2 };
  paintFishingCatchEffects(ctx, { x: 100, y: 100 }, frame, .5, false); assert.equal(calls.length, 0);
  paintFishingCatchEffects(ctx, { x: 100, y: 100 }, { ...frame, stage: "landed", fishId: undefined }, .5, false); assert.equal(calls.length, 0);
  paintFishingCatchEffects(ctx, { x: 100, y: 100 }, { ...frame, stage: "landed" }, .5, false); assert.ok(calls.length > 0);
  calls.length = 0;
  paintFishingCatchEffects(ctx, { x: 100, y: 100 }, { ...frame, stage: "landed" }, 1.35, false);
  paintFishingCatchEffects(ctx, { x: 100, y: 100 }, { ...frame, stage: "landed" }, .5, true);
  assert.equal(calls.length, 0);
});
