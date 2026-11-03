import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
after(() => vite.close());
const { fishingBoatMotion, transformFishingBoatPoint, FISHING_BOAT_PIVOT } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-buoyancy.ts");
const { paintFishingLandscape, paintFishingWake, paintFishingRipples, paintFishingHullContact } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-background.ts");

test("the entire boat rig shares a bounded smooth buoyancy transform, with a stable reduced-motion pivot", () => {
  for (let time = 0; time < 100; time += .05) {
    const pose = fishingBoatMotion(time, false), next = fishingBoatMotion(time + .05, false);
    assert.ok(Math.abs(pose.bob) <= 3.1 && Math.abs(pose.roll) <= .009);
    assert.ok(Math.abs(next.bob - pose.bob) <= .18 && Math.abs(next.roll - pose.roll) <= .0004);
  }
  assert.deepEqual(fishingBoatMotion(0, true), fishingBoatMotion(999, true));
  assert.deepEqual(fishingBoatMotion(NaN, false), { bob: 0, roll: 0 });
  const boat = { x: 20, y: 40, scale: .5, roll: .009 }, pivot = transformFishingBoatPoint(FISHING_BOAT_PIVOT, boat);
  assert.deepEqual(pivot, { x: 270, y: 307.5 });
  const hand = transformFishingBoatPoint({ x: 515, y: 382 }, boat), grip = transformFishingBoatPoint({ x: 515, y: 382 }, boat);
  assert.deepEqual(hand, grip);
  const other = transformFishingBoatPoint({ x: 615, y: 382 }, boat);
  assert.ok(Math.abs(Math.hypot(other.x - hand.x, other.y - hand.y) - 50) < 1e-8, "rolling preserves all local distances");
});

test("painted map waves actually move while cached texture creation and strip work stay bounded", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), creation = [], draws = [];
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    if (key === "createRadialGradient" || key === "createLinearGradient") return () => gradient;
    if (key === "drawImage") return (...args) => draws.push(args);
    return () => {};
  } });
  const texture = {};
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement() { const canvas = { getContext: () => context }; creation.push(canvas); return canvas; } } });
  try {
    paintFishingLandscape(context, 1600, 900, 0, texture);
    const first = draws.filter(args => args.length === 9).map(args => args.slice(1));
    draws.length = 0;
    paintFishingLandscape(context, 1600, 900, 1, texture);
    const moving = draws.filter(args => args.length === 9).map(args => args.slice(1));
    assert.equal(creation.length, 1, "one mirrored source per loaded image, never one per frame");
    assert.ok(first.length > 0 && moving.length < 300, "strip count stays bounded at the largest supported scene size");
    assert.notDeepEqual(moving, first, "the supplied raster water is refracted and advected, not left static below particles");
    draws.length = 0; paintFishingLandscape(context, 1600, 900, 0, texture);
    assert.deepEqual(draws.filter(args => args.length === 9).map(args => args.slice(1)), first, "frozen clocks retain an identical texture pose");
    for (const args of moving) { assert.ok(args[0] >= 0 && args[1] >= 0 && args[2] > 0 && args[3] > 0); }
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; }
});

test("water contact uses attached contours and open ripples without the detached filled hover shadow", () => {
  const calls = [], context = new Proxy({}, { get(target, key) { if (key in target) return target[key]; return (...args) => calls.push({ key, args }); } });
  paintFishingWake(context, { x: 500, y: 535 }, 970, 2);
  paintFishingHullContact(context, 2);
  assert.ok(calls.some(call => call.key === "bezierCurveTo"), "the water lip follows the authored hull rather than an ellipse below it");
  assert.equal(calls.some(call => call.key === "fill"), false);
  assert.ok(calls.filter(call => call.key === "stroke").length >= 5);
});

test("surface wavelets fade on both sides of their cycle instead of flashing a new full-opacity ring", () => {
  const opacity = (paint, time) => {
    const styles = [], context = new Proxy({}, { get(target, key) {
      if (key in target) return target[key];
      if (key === "stroke") return () => styles.push(context.strokeStyle);
      return () => {};
    } });
    paint(context, time);
    return styles.map(style => Number(style.match(/,([^,]+)\)$/)[1]));
  };
  for (const [paint, speed] of [
    [(context, time) => paintFishingRipples(context, { x: 20, y: 30 }, time), .7],
    [(context, time) => paintFishingWake(context, { x: 500, y: 535 }, 970, time), .19],
  ]) {
    assert.equal(opacity(paint, 0)[0], 0);
    assert.ok(opacity(paint, .5 / speed)[0] > .1, "the middle of the cycle stays visible");
    assert.ok(opacity(paint, (1 - 1e-5) / speed)[0] < .001, "a ring disappears continuously before wrapping");
    assert.ok(opacity(paint, .3 / speed).every(alpha => Number.isFinite(alpha) && alpha >= 0 && alpha <= .3));
  }
});
