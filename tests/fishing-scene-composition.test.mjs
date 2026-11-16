import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
after(() => vite.close());
const { fishingSceneComposition, fishingCompositionVariant } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-composition.ts");
const { fishingSceneGeometry } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-painter.ts");
const frame = { stage: "reeling", sceneKey: "voyage-demo", castKey: "cast-one", held: false,
  reel: { bar: 5000, fish: 5500, progress: 2500, zoneWidth: 3200 }, boat: { repaired: true, upgrades: [] } };
const visual = { elapsed: 2, castElapsed: 2, stageElapsed: 2, still: true };

test("voyage framing is deterministic and changes restrained composition rather than casting outcomes", () => {
  const ids = new Set();
  for (let index = 0; index < 30; index++) {
    const key = `voyage-${index}`, variant = fishingCompositionVariant(key); ids.add(variant.id);
    assert.deepEqual(fishingCompositionVariant(key), variant);
    assert.ok(Math.abs(variant.roll) < .015);
  }
  assert.equal(ids.size, 3);
  assert.deepEqual(fishingCompositionVariant(), fishingCompositionVariant(""));
  const before = structuredClone(frame), first = fishingSceneGeometry(1280, 720, frame, visual);
  const nextCast = fishingSceneGeometry(1280, 720, { ...frame, castKey: "cast-two" }, visual);
  assert.deepEqual(first.boat, nextCast.boat); assert.deepEqual(first.float, nextCast.float);
  assert.deepEqual(frame, before);
});

test("boat and float form one close legible group within the viewport and fixed dock clearance", () => {
  for (const [width, height] of [[320,568],[390,844],[820,375],[820,390],[960,540],[1280,720],[1600,900]]) {
    for (let variant = 0; variant < 12; variant++) {
      const composition = fishingSceneComposition(width, height, `voyage-${variant}`);
      assert.ok(composition.boatX >= 0);
      assert.ok(composition.boatX + composition.boatWidth <= width);
      assert.ok(composition.boatWidth >= Math.min(width * .5, 230), "boat gets a meaningful part of the usable view");
      const bow = composition.boatX + composition.boatWidth * .96;
      assert.ok(composition.floatX > bow && composition.floatX - bow < Math.max(95, width * .12), "float starts close to the bow rather than a disconnected screen anchor");
      assert.ok(composition.floatX <= width - 30);
      assert.ok(composition.waterTop >= 68);
      assert.ok(composition.waterBottom <= height - composition.hud - 24 + 1e-8);
      assert.ok(composition.waterBottom - composition.waterTop >= 40, "short screens retain a useful control interval beside the hull");
    }
  }
});

test("all voyage variants keep meter movement separate from the river and preserve safe cast framing", () => {
  for (const [width, height] of [[320,568],[390,844],[820,375],[960,540],[1280,720],[1600,900]]) for (let variant = 0; variant < 6; variant++) {
    for (const bar of [0, 5000, 10000]) for (const fish of [0, 1000, 5000, 9000, 10000]) {
      const value = { ...frame, sceneKey: `voyage-${variant}`, reel: { ...frame.reel, bar, fish } };
      const geometry = fishingSceneGeometry(width, height, value, visual);
      const stable = fishingSceneGeometry(width, height, { ...frame, sceneKey: `voyage-${variant}` }, visual);
      assert.deepEqual(geometry.float, stable.float, "meter input must not teleport the river float");
    }
    for (let tick = 0; tick <= 60; tick++) {
      const age = tick / 50;
      const geometry = fishingSceneGeometry(width, height, { ...frame, sceneKey: `voyage-${variant}`, stage: "casting" },
        { elapsed: age, castElapsed: age, stageElapsed: age, still: false });
      assert.ok(geometry.float.y * geometry.scale >= 20, "float glyph is framed throughout the backswing and flight");
    }
  }
});
