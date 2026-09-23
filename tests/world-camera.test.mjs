import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { clampCamera, overviewCamera, screenToWorld, worldToScreen, zoomAt, zoomLimits } = await vite.ssrLoadModule("/features/world/camera.ts");
const bounds = { width: 1254, height: 1254 };
const view = { width: 393, height: 852 };
const insets = { top: 140, bottom: 100 };
const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);
const extremeCamera = (zoom, side, dimensions = view, world = bounds, padding = insets) => clampCamera({ x: side * 1e8, y: side * 1e8, zoom }, dimensions, world, padding);

test("zoomed map edges clear top and bottom HUD in screen pixels without extending horizontal pan", () => {
  for (const dimensions of [view, { width: 852, height: 393 }, { width: 1440, height: 900 }]) {
    for (const zoom of [1.5, 2, 4]) {
      const top = extremeCamera(zoom, -1, dimensions), bottom = extremeCamera(zoom, 1, dimensions);
      close(worldToScreen({ x: 0, y: 0 }, top, dimensions).y, insets.top);
      close(worldToScreen({ x: bounds.width, y: bounds.height }, bottom, dimensions).y, dimensions.height - insets.bottom);
      const oldTop = clampCamera({ x: -1e8, y: -1e8, zoom }, dimensions, bounds);
      const oldBottom = clampCamera({ x: 1e8, y: 1e8, zoom }, dimensions, bounds);
      // Explicitly compare with the old zero-inset clamp, including its zoom limit.
      assert.equal(top.x, oldTop.x);
      assert.equal(bottom.x, oldBottom.x);
      assert.equal(top.zoom, oldTop.zoom);
    }
  }
});

test("fit-height and smaller scales keep the existing centered map and never add blank bands", () => {
  for (const dimensions of [view, { width: 852, height: 393 }, { width: 1440, height: 900 }]) {
    const fit = dimensions.height / bounds.height;
    for (const zoom of [.0001, zoomLimits(dimensions, bounds).minimum, fit * .999, fit]) {
      for (const side of [-1, 1]) {
        const request = { zoom, x: side * 1e8, y: side * 1e8 };
        assert.deepEqual(clampCamera(request, dimensions, bounds, insets), clampCamera(request, dimensions, bounds));
      }
    }
    const overview = overviewCamera(dimensions, bounds);
    assert.deepEqual(clampCamera(overview, dimensions, bounds, insets), overview);
  }
});

test("vertical room disappears continuously during zoom-out and never exceeds the HUD clearance", () => {
  const fit = view.height / bounds.height;
  const full = (view.height + insets.top + insets.bottom) / bounds.height;
  let previousTop = Infinity, previousBottom = Infinity;
  for (let step = 100; step >= 0; step--) {
    const zoom = fit + (full - fit) * step / 100;
    const top = extremeCamera(zoom, -1), bottom = extremeCamera(zoom, 1);
    const topSpace = worldToScreen({ x: 0, y: 0 }, top, view).y;
    const bottomSpace = view.height - worldToScreen({ x: bounds.width, y: bounds.height }, bottom, view).y;
    assert.ok(topSpace >= -1e-7 && topSpace <= insets.top + 1e-7);
    assert.ok(bottomSpace >= -1e-7 && bottomSpace <= insets.bottom + 1e-7);
    assert.ok(topSpace <= previousTop + 1e-7 && bottomSpace <= previousBottom + 1e-7);
    previousTop = topSpace; previousBottom = bottomSpace;
  }
  close(previousTop, 0); close(previousBottom, 0);
  for (const side of [-1, 1]) {
    const atFit = extremeCamera(fit, side), immediatelyAbove = extremeCamera(fit + 1e-8, side);
    close(atFit.y, immediatelyAbove.y, .00002);
    const atFull = extremeCamera(full, side), immediatelyBelow = extremeCamera(full - 1e-8, side);
    close(atFull.y, immediatelyBelow.y, .00002);
  }
});

test("pinch and wheel zoom preserve the touched terrain until a real camera boundary is reached", () => {
  const initial = extremeCamera(1.25, -1);
  const anchor = { x: 180, y: 210 };
  const before = screenToWorld(anchor, initial, view);
  const zoomed = zoomAt(initial, view, anchor, 1.3, bounds, insets);
  const afterZoom = screenToWorld(anchor, zoomed, view);
  close(afterZoom.x, before.x); close(afterZoom.y, before.y);

  // A far zoom-out from an overscrolled edge must end at the ordinary overview.
  assert.deepEqual(zoomAt(initial, view, anchor, .0001, bounds, insets), overviewCamera(view, bounds));
});

test("invalid insets cannot corrupt the camera or allow unbounded vertical travel", () => {
  const request = { x: -1e8, y: -1e8, zoom: 4 };
  for (const padding of [{ top: -100, bottom: -20 }, { top: NaN, bottom: Infinity }, { top: undefined, bottom: -Infinity }]) {
    assert.deepEqual(clampCamera(request, view, bounds, padding), clampCamera(request, view, bounds));
  }
  const excessive = { top: 1e10, bottom: 1e10 };
  close(worldToScreen({ x: 0, y: 0 }, extremeCamera(4, -1, view, bounds, excessive), view).y, view.height * .45);
  close(worldToScreen({ x: bounds.width, y: bounds.height }, extremeCamera(4, 1, view, bounds, excessive), view).y, view.height * .55);
});

test("asymmetric insets and resized non-square worlds keep their own bounds", () => {
  const world = { width: 1800, height: 2400 }, padding = { top: 175, bottom: 0 };
  const top = extremeCamera(2, -1, view, world, padding), bottom = extremeCamera(2, 1, view, world, padding);
  close(worldToScreen({ x: 0, y: 0 }, top, view).y, padding.top);
  close(worldToScreen({ x: world.width, y: world.height }, bottom, view).y, view.height);
  assert.equal(top.x, clampCamera(top, view, world).x);
  assert.equal(bottom.x, clampCamera(bottom, view, world).x);
  assert.deepEqual(clampCamera(overviewCamera(view, world), view, world, padding), overviewCamera(view, world));
});
