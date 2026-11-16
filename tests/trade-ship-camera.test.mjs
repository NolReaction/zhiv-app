import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { tradeShipCamera } = await vite.ssrLoadModule("/features/world/scene/trade-ship-camera.ts");
const { worldToScreen, clampCamera } = await vite.ssrLoadModule("/features/world/scene/camera.ts");
const { createTradeShipMotion } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");
const { TRADE_SHIP_SPRITE: sprite } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
const { TILED_WORLD: bounds } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { data, info } = await sharp(root + "/public" + sprite.src.split("?")[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const outline = [];
// Both opaque extremes of every source column cover the complete hull, cabin,
// bow and chimney under an affine sprite transform, not a guessed art box.
for (let x = 0; x < info.width; x++) {
  let first = -1, last = -1;
  for (let y = 0; y < info.height; y++) if (data[(y * info.width + x) * 4 + 3] >= 64) {
    if (first < 0) first = y;
    last = y;
  }
  if (first >= 0) outline.push({ x, y: first }, { x, y: last });
}
const docked = createTradeShipMotion();
function placed(point, bob) {
  const scale = docked.width / sprite.width, angle = sprite.baseHeading + docked.heading;
  const x = sprite.width - sprite.image.x - point.x * sprite.image.width / info.width - sprite.pivot.x;
  const y = sprite.image.y + point.y * sprite.image.height / info.height + bob - sprite.pivot.y;
  return { x: docked.x + (sprite.pivot.x + x * Math.cos(angle) - y * Math.sin(angle)) * scale,
    y: docked.y + (sprite.pivot.y + x * Math.sin(angle) + y * Math.cos(angle)) * scale };
}

test("ship focus keeps the complete opaque PNG clear of portrait and desktop HUDs", () => {
  assert.ok(outline.length > 3000, "the actual PNG footprint is available");
  const hud = { top: 80, bottom: 70 };
  for (const view of [{ width: 390, height: 844 }, { width: 320, height: 568 },
    { width: 960, height: 720 }, { width: 1280, height: 900 }]) {
    const camera = tradeShipCamera(view, bounds, hud);
    for (const point of outline) for (const bob of [-.8, .8]) {
      const screen = worldToScreen(placed(point, bob), camera, view);
      assert.ok(screen.x >= 0 && screen.x <= view.width, `${view.width}px: hull cannot be cropped horizontally`);
      assert.ok(screen.y >= hud.top && screen.y <= view.height - hud.bottom,
        `${view.width}px: opaque ship at ${screen.y} must stay between HUDs`);
    }
  }
});

test("merely filling portrait height is insufficient to reveal the ship above the bottom HUD", () => {
  const view = { width: 390, height: 844 }, hud = { top: 80, bottom: 70 };
  const focus = tradeShipCamera(view, bounds, hud);
  const covered = clampCamera({ ...focus, zoom: view.height / bounds.height }, view, bounds, hud);
  assert.ok(outline.some(point => worldToScreen(placed(point, 0), covered, view).y > view.height - hud.bottom),
    "the invariant catches a camera whose bottom pan allowance never activates");
});
