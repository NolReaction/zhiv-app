import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createMapPanSurface } = await vite.ssrLoadModule("/features/world/scene/map-pan-surface.ts");

const canvas = () => ({ width: 1, height: 1, style: { width: "", height: "", left: "", top: "", transform: "", willChange: "" } });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

test("pan surface adds physical overscan without reducing either DPR axis", () => {
  const target = canvas(), surface = createMapPanSurface(target);
  surface.configure({ width: 390, height: 844 }, 780, 1688);
  assert.equal(surface.activate(), true);
  const frame = surface.geometry;
  assert.equal(frame.ratioX, 2); assert.equal(frame.ratioY, 2);
  assert.equal(frame.normalWidth, 780); assert.equal(frame.normalHeight, 1688);
  assert.equal(frame.padX, 64); assert.equal(frame.padY, 64);
  assert.equal(target.width, 908); assert.equal(target.height, 1816);
  close(parseFloat(target.style.width), target.width / 2);
  close(parseFloat(target.style.height), target.height / 2);
  assert.equal(surface.present(31.75, -31.5), true);
  assert.equal(surface.present(32.25, 0), false, "an exposed edge requires a fresh raster");
  assert.equal(surface.present(0, -32.25), false);
  assert.equal(surface.present(NaN, 0), false);
  surface.reset();
  assert.equal(surface.active, false);
  assert.equal(target.width, 780); assert.equal(target.height, 1688);
});

test("fractional backing ratios retain the original density and integer padding", () => {
  const target = canvas(), surface = createMapPanSurface(target);
  surface.configure({ width: 393, height: 665 }, 589, 998);
  assert.equal(surface.activate(), true);
  const frame = surface.geometry;
  close(frame.ratioX, 589 / 393); close(frame.ratioY, 998 / 665);
  assert.ok(Number.isInteger(frame.padX) && Number.isInteger(frame.padY));
  close(parseFloat(target.style.width), target.width / frame.ratioX);
  close(parseFloat(target.style.height), target.height / frame.ratioY);
  assert.equal(surface.present(frame.padX / frame.ratioX, frame.padY / frame.ratioY), true);
  assert.equal(surface.present(frame.padX / frame.ratioX + .001, 0), false);
});

test("large surfaces fall back at the pixel cap without changing their existing resolution", () => {
  const target = canvas(), surface = createMapPanSurface(target);
  surface.configure({ width: 1100, height: 1100 }, 2200, 2200);
  assert.equal(surface.activate(), false);
  assert.equal(surface.active, false);
  assert.equal(target.width, 2200); assert.equal(target.height, 2200);
});

test("resize and disposal remove CSS offsets and restore only the normal backing surface", () => {
  const target = canvas(), surface = createMapPanSurface(target);
  surface.configure({ width: 390, height: 844 }, 780, 1688);
  surface.activate(); surface.present(12.5, -8.25);
  surface.configure({ width: 844, height: 390 }, 1688, 780);
  assert.equal(surface.active, false);
  assert.equal(target.width, 1688); assert.equal(target.height, 780);
  surface.activate(); surface.present(-4.5, 7.25); surface.dispose();
  assert.equal(surface.active, false);
  assert.equal(target.width, 1688); assert.equal(target.height, 780);
  assert.ok(!target.style.transform || target.style.transform === "none");
  assert.ok(!target.style.willChange || target.style.willChange === "auto");
});
