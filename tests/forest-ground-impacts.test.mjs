import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { TILED_WORLD: scene } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { forestGroundImpactFrame, isForestRainGround, drawForestGroundImpact, drawForestGroundImpacts }
  = await vite.ssrLoadModule("/features/world/forest-ground-impacts.ts");
const { previewPointInPolygon } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const options = { elapsed: 12, rain: 1, dusk: 0, reducedMotion: false };
const rectangle = bounds => [
  { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
  { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height },
];

test("ground rain visits reviewed grass and paths across all quadrants, never foliage or water exclusions", () => {
  const quadrants = new Set();
  for (let elapsed = 0; elapsed < 8; elapsed += .25) {
    const frame = forestGroundImpactFrame(scene, { ...options, elapsed });
    assert.ok(frame.length > 25 && frame.length < 500);
    for (const hit of frame) {
      assert.ok(isForestRainGround(scene, hit));
      assert.ok(Object.values(hit).every(Number.isFinite));
      quadrants.add(`${hit.x > scene.width / 2}:${hit.y > scene.height / 2}`);
      for (const polygon of [...scene.water.surfaces, ...scene.water.exclusions]) {
        assert.equal(previewPointInPolygon(hit, polygon.points), false);
      }
      for (const site of scene.sites) assert.equal(previewPointInPolygon(hit, rectangle(site.bounds)), false);
    }
  }
  assert.equal(quadrants.size, 4);
  assert.equal(isForestRainGround(scene, { x: 450, y: 240 }), false, "painted canopy");
  assert.equal(isForestRainGround(scene, { x: 1194, y: 746 }), false, "wooden pier");
  assert.equal(isForestRainGround(scene, { x: 950, y: 1130 }), false, "river");
});

test("Tiled water edits and building bounds override ground artwork, including objects excluded from water", () => {
  const reference = forestGroundImpactFrame(scene, options), point = reference[0];
  const bounds = { x: point.x - 8, y: point.y - 8, width: 16, height: 16 };
  const polygon = { id: "new-water", points: rectangle(bounds) };
  const flooded = { ...scene, water: { surfaces: [polygon], exclusions: [polygon] } };
  assert.equal(isForestRainGround(flooded, point), false, "an excluded water object is not ground");
  const built = { ...scene, sites: [{ ...scene.sites[0], bounds }] };
  assert.equal(isForestRainGround(built, point), false);
  const hidden = forestGroundImpactFrame(scene, { ...options,
    groundExclusions: [{ x: point.x, y: point.y, radius: 12 }] });
  assert.ok(hidden.every(hit => Math.hypot(hit.x - point.x, hit.y - point.y) > 15));
  assert.ok(hidden.length < reference.length);
});

test("impacts relocate after their lifetime and shared elapsed keeps consumers deterministic", () => {
  const first = forestGroundImpactFrame(scene, options);
  const later = forestGroundImpactFrame(scene, { ...options, elapsed: 20 });
  const places = new Set(first.map(hit => `${hit.x}:${hit.y}`));
  assert.ok(later.every(hit => !places.has(`${hit.x}:${hit.y}`)));
  assert.deepEqual(forestGroundImpactFrame(scene, options), first);
  const view = { x: scene.focus.x, y: scene.focus.y, width: scene.focus.width, height: scene.focus.height };
  const visible = forestGroundImpactFrame(scene, options, view);
  assert.ok(visible.length > 0 && visible.length < first.length);
  for (const hit of visible) assert.ok(first.some(other => other.seed === hit.seed && other.x === hit.x && other.y === hit.y));
  const light = forestGroundImpactFrame(scene, { ...options, rain: .15 });
  assert.ok(light.length < first.length / 2);
});

test("rain stops immediately, reduced motion removes impacts, changed terrain cannot reuse coordinates", () => {
  for (const rain of [0, -1, Infinity, NaN]) assert.deepEqual(forestGroundImpactFrame(scene, { ...options, rain }), []);
  assert.deepEqual(forestGroundImpactFrame(scene, { ...options, reducedMotion: true }), []);
  assert.deepEqual(forestGroundImpactFrame({ ...scene, terrain: [] }, options), []);
  const changed = { ...scene, terrain: scene.terrain.map(item => ({ ...item, image: `${item.image}new` })) };
  assert.deepEqual(forestGroundImpactFrame(changed, options), []);
  assert.deepEqual(forestGroundImpactFrame(scene, { ...options, elapsed: Infinity }),
    forestGroundImpactFrame(scene, { ...options, elapsed: 0 }));
});

function context() {
  const calls = [], stack = [];
  const ctx = { globalAlpha: .6, fillStyle: "before", strokeStyle: "before", lineWidth: 1, lineCap: "butt",
    canvas: { width: 320, height: 320 }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  const state = () => ({ globalAlpha: ctx.globalAlpha, fillStyle: ctx.fillStyle,
    strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, lineCap: ctx.lineCap });
  ctx.save = () => stack.push(state()); ctx.restore = () => Object.assign(ctx, stack.pop());
  for (const name of ["beginPath", "ellipse", "fill", "moveTo", "lineTo", "stroke"]) ctx[name] = (...args) => calls.push([name, ...args]);
  return { ctx, calls, state, stack };
}

test("ground hit has a short splash and filled fleck, restores context, and culls out-of-view patches", () => {
  const initial = context(), late = context(), before = initial.state();
  const hit = { x: 30, y: 40, size: 1, phase: .1, opacity: .6, variant: 2, seed: 501 };
  drawForestGroundImpact(initial.ctx, hit);
  drawForestGroundImpact(late.ctx, { ...hit, phase: .9 });
  assert.deepEqual(initial.state(), before);
  assert.equal(initial.stack.length, 0);
  assert.ok(initial.calls.some(call => call[0] === "stroke"), "first instant has a splash crown");
  assert.equal(late.calls.filter(call => call[0] === "ellipse").length, 1, "late hit is just one fading damp fleck");
  assert.equal(late.calls.filter(call => call[0] === "stroke").length, 0, "no concentric rings on earth");
  const offscreen = context();
  offscreen.ctx.getTransform = () => ({ a: 2, b: 0, c: 0, d: 2, e: 10000, f: 10000 });
  drawForestGroundImpacts(offscreen.ctx, scene, options);
  assert.equal(offscreen.calls.length, 0);
});
