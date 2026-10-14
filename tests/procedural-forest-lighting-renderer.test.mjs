import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createLightingRenderer, sunShadowProjection, pointShadowProjection } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/lighting/lighting-renderer.ts");
const { initialLighting } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/lighting/lighting-data.ts");
const sourceBounds = { x: -40, y: -100, width: 80, height: 100 };
const object = (patch = {}) => ({ id: "planted:caster", kind: "image", x: 500, y: 500, scale: 1, rotation: 0, variant: 0, imageWidth: 80, imageHeight: 100, shadowHeight: 100, ...patch });
const state = (patch = {}) => ({ ...initialLighting(), enabled: true, ...patch });
const apply = (matrix, x, y) => ({ x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const view = { x: 0, y: 0, width: 1600, height: 800 };
function context(calls = []) {
  return new Proxy({}, { get: (_, key) => key === "getImageData" || key === "createImageData" ? (...args) => {
    const [width, height] = key === "getImageData" ? args.slice(2) : args;
    calls.push([key, ...args]); return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  } : key === "createRadialGradient" ? (...args) => {
    calls.push([key, ...args]); return { addColorStop: (...stop) => calls.push(["stop", ...stop]) };
  } : (...args) => calls.push([key, ...args]), set: (_, key, value) => { calls.push(["set", key, value]); return true; } });
}
const factory = (calls = []) => (width, height) => ({ width, height, getContext: () => context(calls) });

test("sun projection follows source angle, height, elevation and scale while retaining its ground anchor", () => {
  const item = object();
  const east = sunShadowProjection(item, sourceBounds, state({ sunAngle: 0, sunElevation: 45 }));
  const tip = apply(east.matrix, 0, -100), anchor = apply(east.matrix, 0, 0);
  close(tip.x, 400); close(tip.y, 492); assert.deepEqual(anchor, { x: 500, y: 500 });
  const north = apply(sunShadowProjection(item, sourceBounds, state({ sunAngle: 90, sunElevation: 45 })).matrix, 0, -100);
  close(north.x, 500); close(north.y, 592);
  const low = apply(sunShadowProjection(item, sourceBounds, state({ sunAngle: 0, sunElevation: 20 })).matrix, 0, -100);
  const high = apply(sunShadowProjection(item, sourceBounds, state({ sunAngle: 0, sunElevation: 70 })).matrix, 0, -100);
  assert.ok(500 - low.x > 500 - high.x);
  const doubled = apply(sunShadowProjection(object({ scale: 2 }), sourceBounds, state({ sunAngle: 0, sunElevation: 45 })).matrix, 0, -100);
  close(doubled.x, 300); close(doubled.y, 484);
});

test("point blocker projection points away from the lamp and ignores sources within its own ground anchor", () => {
  const light = { id: "lamp", name: "Lamp", x: 300, y: 500, radius: 500, intensity: 1, color: "#ffaa66", enabled: true };
  const cast = pointShadowProjection(object(), sourceBounds, light);
  assert.ok(apply(cast.matrix, 0, -100).x > 500);
  assert.equal(pointShadowProjection(object({ x: 300, y: 500 }), sourceBounds, light), null);
  assert.equal(pointShadowProjection(object({ x: 1500 }), sourceBounds, light), null);
});

test("disabled lighting performs no source queries, canvas allocation or drawing", () => {
  let sources = 0, canvases = 0; const calls = [];
  const renderer = createLightingRenderer(() => { canvases++; throw new Error("disabled allocation"); }, () => { sources++; return { bounds: sourceBounds }; });
  renderer.sync(1600, initialLighting(), [object()], undefined, 0, () => true);
  renderer.paintGroundShadows(context(calls), view); renderer.paintIllumination(context(calls), view);
  assert.equal(sources, 0); assert.equal(canvases, 0); assert.deepEqual(calls, []);
  renderer.dispose();
});

test("warm light masks reuse chunks and original alpha sources without baking new actor pixels", () => {
  const calls = [], native = { original: true }; let queries = 0;
  const renderer = createLightingRenderer(factory(calls), () => { queries++; return { image: native, bounds: sourceBounds }; });
  const objects = [object()], light = state({ sunAngle: 0 });
  renderer.sync(1600, light, objects, undefined, 0, () => true);
  renderer.paintGroundShadows(context(), view); renderer.paintIllumination(context(), view);
  const warm = renderer.diagnostics();
  assert.equal(queries, 1); assert.ok(warm.sunBuilds > 0 && warm.fieldBuilds > 0); assert.ok(warm.pixels < 8_000_000);
  assert.ok(calls.some(call => call[0] === "drawImage" && call[1] === native), "the projection uses the source's real alpha");
  assert.ok(calls.some(call => call[0] === "set" && call[1] === "globalCompositeOperation" && call[2] === "source-in"), "mask RGB is tinted after drawing its alpha once");
  renderer.sync(1600, light, objects, undefined, 0, () => true);
  renderer.paintGroundShadows(context(), { ...view, x: 10, width: 1500 }); renderer.paintIllumination(context(), { ...view, x: 10, width: 1500 });
  assert.deepEqual(renderer.diagnostics(), warm); assert.equal(queries, 1);
  renderer.dispose();
});

test("preview movement invalidates old and new cast extents without re-querying unrelated casters or the uniform field", () => {
  let queries = 0;
  const renderer = createLightingRenderer(factory(), () => { queries++; return { image: {}, bounds: sourceBounds }; });
  const objects = [object(), object({ id: "planted:other", x: 1300 })], previews = new Map(), light = state({ sunAngle: 0 });
  renderer.sync(1600, light, objects, previews, 0, () => true); renderer.paintGroundShadows(context(), view); renderer.paintIllumination(context(), view);
  const warm = renderer.diagnostics();
  previews.set(objects[0].id, object({ x: 1100 })); renderer.sync(1600, light, objects, previews, 1, () => true);
  renderer.paintGroundShadows(context(), view); renderer.paintIllumination(context(), view);
  assert.equal(queries, 3); assert.ok(renderer.diagnostics().sunBuilds > warm.sunBuilds);
  assert.equal(renderer.diagnostics().fieldBuilds, warm.fieldBuilds);
  previews.clear(); renderer.sync(1600, light, objects, previews, 2, () => true); renderer.paintGroundShadows(context(), view);
  assert.equal(queries, 3, "cancel restores the cached original caster");
  renderer.dispose();
});

test("caster removal and shadowHeight zero clear shadows, while ambient changes update only illumination", () => {
  const renderer = createLightingRenderer(factory(), () => ({ image: {}, bounds: sourceBounds })), light = state(), objects = [object()];
  renderer.sync(1600, light, objects, undefined, 0, () => true); renderer.paintGroundShadows(context(), view); renderer.paintIllumination(context(), view);
  const warm = renderer.diagnostics();
  renderer.sync(1600, { ...light, ambient: .2 }, objects, undefined, 0, () => true); renderer.paintGroundShadows(context(), view); renderer.paintIllumination(context(), view);
  assert.equal(renderer.diagnostics().sunBuilds, warm.sunBuilds); assert.ok(renderer.diagnostics().fieldBuilds > warm.fieldBuilds);
  renderer.sync(1600, light, [object({ shadowHeight: 0 })], undefined, 0, () => true); renderer.paintGroundShadows(context(), view);
  assert.ok(renderer.diagnostics().sunBuilds > warm.sunBuilds, "a disabled caster erases its old floor shadow");
  renderer.dispose();
});

test("night illumination uses colored radial falloff and planar alpha occlusion before the final multiply pass", () => {
  const calls = [], native = {}, renderer = createLightingRenderer(factory(calls), () => ({ image: native, bounds: sourceBounds }));
  const point = { id: "lamp", name: "Lamp", x: 300, y: 500, radius: 500, intensity: 1, color: "#ffbb77", enabled: true };
  renderer.sync(1600, state({ ambient: .15, sunIntensity: 0, points: [point] }), [object()], undefined, 0, () => true);
  const output = []; renderer.paintIllumination(context(output), view);
  assert.ok(calls.some(call => call[0] === "createRadialGradient" && call[1] === 300 && call[2] === 500 && call[6] === 500));
  assert.ok(calls.some(call => call[0] === "set" && call[1] === "globalCompositeOperation" && call[2] === "destination-out"));
  assert.ok(calls.some(call => call[0] === "drawImage" && call[1] === native));
  assert.ok(output.some(call => call[0] === "set" && call[1] === "globalCompositeOperation" && call[2] === "multiply"));
  assert.equal(renderer.diagnostics().sunBuilds, 0, "night does not allocate or render the unused sun mask");
  renderer.dispose();
});

test("asset readiness and re-enabling lighting refresh pending alpha sources, and dispose releases every mask", () => {
  let native; const calls = [], renderer = createLightingRenderer(factory(calls), () => ({ image: native, bounds: sourceBounds }));
  const objects = [object({ assetId: "png:ready" })], light = state();
  renderer.sync(1600, light, objects, undefined, 0, () => true); renderer.paintGroundShadows(context(), view); const pending = renderer.diagnostics().sunBuilds;
  native = {}; renderer.invalidateAsset("png:ready"); renderer.paintGroundShadows(context(), view);
  assert.ok(renderer.diagnostics().sunBuilds > pending); assert.ok(calls.some(call => call[0] === "drawImage" && call[1] === native));
  renderer.sync(1600, initialLighting(), objects, undefined, 0, () => true);
  renderer.sync(1600, light, objects, undefined, 0, () => true); renderer.paintGroundShadows(context(), view);
  const before = renderer.diagnostics(); renderer.dispose(); const output = [];
  renderer.paintGroundShadows(context(output), view); renderer.paintIllumination(context(output), view); renderer.invalidateAsset("png:ready");
  assert.deepEqual(output, []); assert.equal(renderer.diagnostics().pixels, 0); assert.equal(renderer.diagnostics().sunBuilds, before.sunBuilds);
});

test("moving a local light preserves the sun cache and illumination outside its old and new radius", () => {
  const renderer = createLightingRenderer(factory(), () => ({ image: {}, bounds: sourceBounds }));
  const objects = [object()], point = { id: "lamp", name: "Lamp", x: 80, y: 80, radius: 32, intensity: 1, color: "#ffaa66", enabled: true };
  const light = state({ points: [point] });
  renderer.sync(1600, light, objects, undefined, 0, () => true); renderer.paintGroundShadows(context(), view); renderer.paintIllumination(context(), view);
  const warm = renderer.diagnostics();
  renderer.sync(1600, { ...light, points: [{ ...point, x: 100 }] }, objects, undefined, 0, () => true);
  renderer.paintGroundShadows(context(), view); renderer.paintIllumination(context(), view);
  assert.equal(renderer.diagnostics().sunBuilds, warm.sunBuilds);
  assert.equal(renderer.diagnostics().fieldBuilds, warm.fieldBuilds + 1, "only the lamp's corner chunk is rebuilt");
  renderer.dispose();
});

test("sun drag reuses stationary raw alpha, unions the moving caster before blur and shares the patch with actor repair", () => {
  const calls = [], fixed = { fixed: true }, moving = { moving: true };
  const renderer = createLightingRenderer(factory(calls), item => ({ image: item.id === "fixed" ? fixed : moving, bounds: sourceBounds }));
  const objects = [object(), object({ id: "fixed", x: 520 })], previews = new Map(), light = state({ sunAngle: 0 });
  renderer.sync(1600, light, objects, previews, 0, () => true); renderer.paintGroundShadows(context(), view);
  previews.set(objects[0].id, object({ x: 530 })); renderer.sync(1600, light, objects, previews, 1, () => true);
  renderer.paintGroundShadows(context(), view); const first = renderer.diagnostics();
  calls.length = 0; previews.set(objects[0].id, object({ x: 545 })); renderer.sync(1600, light, objects, previews, 2, () => true);
  const output = []; renderer.paintGroundShadows(context(output), view); const second = renderer.diagnostics();
  assert.equal(second.sunBuilds, first.sunBuilds, "stationary 512px masks are untouched on the second pointer step");
  assert.equal(calls.filter(call => call[0] === "drawImage" && call[1] === fixed).length, 0);
  const raw = calls.findIndex(call => call[0] === "putImageData"), native = calls.findIndex(call => call[0] === "drawImage" && call[1] === moving);
  const tint = calls.findIndex((call, index) => index > native && call[0] === "set" && call[1] === "globalCompositeOperation" && call[2] === "source-in");
  const blur = calls.findIndex((call, index) => index > tint && call[0] === "set" && call[1] === "filter");
  assert.ok(raw >= 0 && native > raw && tint > native && blur > tint, "raw stationary and moving alpha are combined before tint and blur");
  assert.equal(output.filter(call => call[0] === "set" && call[1] === "globalAlpha").length, 1, "opacity is applied once to the combined shadow");
  renderer.paintGroundShadows(context(), { x: 480, y: 480, width: 100, height: 80 });
  assert.equal(renderer.diagnostics().sunPatchBuilds, second.sunPatchBuilds, "actor repair reuses the same filtered local patch");
  previews.clear(); renderer.sync(1600, light, objects, previews, 3, () => true); renderer.paintGroundShadows(context(), view);
  assert.ok(renderer.diagnostics().sunBuilds > second.sunBuilds, "cancel restores the original stationary shadow once");
  renderer.dispose(); assert.equal(renderer.diagnostics().rawBytes, 0);
});

test("one radius240 lamp caches stationary blockers across drag and aligns every field patch with the world half-resolution grid", () => {
  const calls = [], fixed = {}, moving = {}, allocations = [];
  const renderer = createLightingRenderer((width, height) => { const canvas = factory(calls)(width, height); allocations.push(canvas); return canvas; },
    item => ({ image: item.id === "fixed" ? fixed : moving, bounds: sourceBounds }));
  const point = { id: "lamp", name: "Lamp", x: 400.25, y: 520.75, radius: 240, intensity: 1, color: "#ffbb77", enabled: true };
  const objects = [object(), object({ id: "fixed", x: 520 })], previews = new Map(), light = state({ sunIntensity: 0, points: [point] });
  renderer.sync(1600, light, objects, previews, 0, () => true); renderer.paintIllumination(context(), view);
  previews.set(objects[0].id, object({ x: 530, y: 501 })); renderer.sync(1600, light, objects, previews, 1, () => true); renderer.paintIllumination(context(), view);
  const first = renderer.diagnostics(); calls.length = 0;
  previews.set(objects[0].id, object({ x: 545, y: 503 })); renderer.sync(1600, light, objects, previews, 2, () => true);
  const output = []; renderer.paintIllumination(context(output), view);
  const second = renderer.diagnostics(); assert.equal(second.fieldBuilds, first.fieldBuilds); assert.equal(second.pointStampBuilds, first.pointStampBuilds);
  assert.equal(calls.filter(call => call[0] === "drawImage" && call[1] === fixed).length, 0);
  assert.equal(calls.filter(call => call[0] === "createRadialGradient").length, 0, "the lamp falloff is cached during movement");
  const patch = output.find(call => call[0] === "drawImage" && call.length === 10);
  assert.ok(patch, "illumination draws a bounded repaired core");
  assert.equal(patch[6] % 2, 0); assert.equal(patch[7] % 2, 0); assert.equal(patch[8] % 2, 0); assert.equal(patch[9] % 2, 0);
  assert.ok(allocations.every(canvas => canvas.width <= 1600 && canvas.height <= 800));
  assert.ok(second.stampBytes <= 8 * 1024 * 1024);
  previews.clear(); renderer.sync(1600, light, objects, previews, 3, () => true); renderer.paintIllumination(context(), view);
  assert.ok(renderer.diagnostics().pointStampBuilds > second.pointStampBuilds);
  renderer.dispose(); assert.equal(renderer.diagnostics().stampBytes, 0);
});

test("oversized projections stream through bounded patches and cap raw alpha and point stamp storage", () => {
  const allocations = [], calls = [];
  const renderer = createLightingRenderer((width, height) => { allocations.push([width, height]); return factory(calls)(width, height); },
    () => ({ image: {}, bounds: { x: -160, y: -319, width: 320, height: 319 } }));
  const item = object({ x: 3000, y: 1500, scale: 8, shadowHeight: 480 }), previews = new Map(), light = state({ sunAngle: 0, sunElevation: 10, shadowSoftness: 24 });
  renderer.sync(3200, light, [item], previews, 0, () => true); renderer.paintGroundShadows(context(), { ...view, width: 3200, height: 1600 });
  const before = allocations.length;
  previews.set(item.id, { ...item, x: 2990 }); renderer.sync(3200, light, [item], previews, 1, () => true);
  renderer.paintGroundShadows(context(), { ...view, width: 3200, height: 1600 });
  assert.ok(allocations.slice(before).every(([w, h]) => w <= 608 && h <= 608), "no bitmap follows the 21,778px projection outside the map");
  assert.ok(renderer.diagnostics().rawBytes <= 12 * 1024 * 1024);
  assert.ok(renderer.diagnostics().pixels < 8_000_000, "streaming adds only two bounded sun patch canvases");
  renderer.dispose(); assert.equal(renderer.diagnostics().pixels, 0);
});
