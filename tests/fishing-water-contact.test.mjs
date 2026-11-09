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
    assert.ok(Math.abs(pose.bob) <= 12 && Math.abs(pose.roll) <= .032 && Math.abs(pose.surge) <= 3.6);
    assert.ok(Math.abs(next.bob - pose.bob) <= .4 && Math.abs(next.roll - pose.roll) <= .0015);
  }
  assert.deepEqual(fishingBoatMotion(0, true), fishingBoatMotion(999, true));
  assert.deepEqual(fishingBoatMotion(NaN, false), { bob: 0, roll: 0, surge: 0 });
  const boat = { x: 20, y: 40, scale: .5, roll: .009 }, pivot = transformFishingBoatPoint(FISHING_BOAT_PIVOT, boat);
  assert.deepEqual(pivot, { x: 270, y: 307.5 });
  const hand = transformFishingBoatPoint({ x: 515, y: 382 }, boat), grip = transformFishingBoatPoint({ x: 515, y: 382 }, boat);
  assert.deepEqual(hand, grip);
  const other = transformFishingBoatPoint({ x: 615, y: 382 }, boat);
  assert.ok(Math.abs(Math.hypot(other.x - hand.x, other.y - hand.y) - 50) < 1e-8, "rolling preserves all local distances");
});

test("one decoded lake surface moves without allocating per-frame canvases or repeating a tile", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), draws = [];
  const gradient = { addColorStop() {} };
  let allocations = 0;
  const context = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    if (key === "createRadialGradient" || key === "createLinearGradient") return () => gradient;
    if (key === "drawImage") return (...args) => draws.push(args);
    return () => {};
  } });
  const texture = { naturalWidth: 1024, naturalHeight: 1024 };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement() { allocations++; throw Error("unexpected source canvas"); } } });
  try {
    paintFishingLandscape(context, 1600, 900, 0, texture);
    assert.equal(draws.length, 1, "the whole viewport is a single source crop, so it has no tile/strip seams");
    const first = draws[0].slice(1);
    draws.length = 0;
    paintFishingLandscape(context, 1600, 900, 1, texture);
    assert.equal(draws.length, 1);
    assert.notDeepEqual(draws[0].slice(1), first, "the supplied artwork itself drifts rather than staying static below particles");
    assert.deepEqual(draws[0].slice(5), [0, 0, 1600, 900]);
    assert.equal(allocations, 0, "the runtime's cached decoded image is reused directly in every frame");
    draws.length = 0; paintFishingLandscape(context, 1600, 900, 0, texture);
    assert.deepEqual(draws[0].slice(1), first, "frozen clocks retain an identical texture pose");
    draws.length = 0; paintFishingLandscape(context, 1600, 900, 600, texture, undefined, .8, true);
    assert.deepEqual(draws[0].slice(1), first, "reduced motion fixes the texture even if a caller supplies an advancing clock");
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; }
});

test("one bounded light map is reused while the original water texture keeps moving", () => {
  const gradient = { addColorStop() {} };
  const layers = [], textureDraws = [], refreshes = [];
  const context = overrides => new Proxy(overrides, { get(target, name) {
    if (name in target) return target[name];
    if (name === "createRadialGradient" || name === "createLinearGradient") return () => gradient;
    return () => {};
  } });
  const light = context({ clearRect: () => refreshes.push(true) });
  const ownerDocument = { createElement() {
    const canvas = { getContext: () => light }; layers.push(canvas); return canvas;
  } };
  const image = { naturalWidth: 1024, naturalHeight: 1024 };
  const output = context({ canvas: { ownerDocument }, drawImage: (source, ...rects) => {
    if (source === image) textureDraws.push(rects);
  } });
  for (const time of [0, .1, .4, 1.9, 2, 2.1]) paintFishingLandscape(output, 1440, 900, time, image);
  assert.equal(layers.length, 1);
  assert.deepEqual([layers[0].width, layers[0].height], [256, 160]);
  assert.equal(refreshes.length, 2, "lighting is sampled independently of the scene frames");
  assert.equal(new Set(textureDraws.map(draw => draw[0])).size, 6, "the single original crop still moves every frame");
  paintFishingLandscape(output, 390, 844, 2.1, image);
  assert.deepEqual([layers[0].width, layers[0].height], [118, 256], "resize reuses the raster and preserves aspect");
  assert.equal(refreshes.length, 3);
});

test("water contact uses attached contours and open ripples without the detached filled hover shadow", () => {
  const calls = [], context = new Proxy({}, { get(target, key) { if (key in target) return target[key]; return (...args) => calls.push({ key, args }); } });
  paintFishingWake(context, { x: 500, y: 535 }, 970, 2);
  paintFishingHullContact(context, 2);
  assert.ok(calls.some(call => call.key === "quadraticCurveTo") && calls.some(call => call.key === "lineTo" && call.args[0] === 762.5 && call.args[1] === 535), "the water lip follows the new side hull keel rather than an ellipse below it");
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
