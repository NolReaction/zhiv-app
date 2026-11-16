import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { tradeShipOpaquePoints, tradeShipPointsVisible } = await vite.ssrLoadModule("/features/world/scene/trade-ship-visibility.ts");
const { sampleTradeShipMotion } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");
const { tradeShipCamera } = await vite.ssrLoadModule("/features/world/scene/trade-ship-camera.ts");
const { TRADE_SHIP_SPRITE: sprite } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
const { TILED_WORLD: bounds } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { data, info } = await sharp(root + "/public" + sprite.src.split("?")[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const points = tradeShipOpaquePoints(data, info.width, info.height);

test("horn visibility uses actual opaque PNG points intersecting both world and camera, not its transparent placement box", () => {
  assert.ok(points.length > 300);
  for (const point of points) assert.ok(data[(point.y * info.width + point.x) * 4 + 3] > 64);
  for (const view of [{ width: 390, height: 844 }, { width: 960, height: 720 }]) {
    const camera = { ...tradeShipCamera(view, bounds, { top: 80, bottom: 70 }), viewportWidth: view.width, viewportHeight: view.height };
    assert.equal(tradeShipPointsVisible(points, { ...sampleTradeShipMotion("arriving", 8), time: 8 }, camera, bounds), false);
    assert.equal(tradeShipPointsVisible(points, { ...sampleTradeShipMotion("arriving", 10.5), time: 10.5 }, camera, bounds), true);
    assert.equal(tradeShipPointsVisible(points, { ...sampleTradeShipMotion("arriving", 10.5), time: 10.5 },
      { ...camera, x: 100, y: 100, zoom: 3 }, bounds), false, "panning elsewhere cannot count an offscreen contact as visible");
  }
});

test("missing or unusable visibility geometry cannot manufacture an audible ship", () => {
  const frame = sampleTradeShipMotion("docked", 0), camera = { x: 850, y: 1170, zoom: 1, viewportWidth: 400, viewportHeight: 400 };
  assert.equal(tradeShipPointsVisible([], frame, camera, bounds), false);
  assert.equal(tradeShipPointsVisible(points, frame, null, bounds), false);
  assert.equal(tradeShipPointsVisible(points, frame, { ...camera, zoom: 0 }, bounds), false);
});
