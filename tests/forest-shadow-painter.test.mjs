import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { drawForestDirectionalShadows, drawForestOccludedLighting, drawForestShadowDebug }
  = await vite.ssrLoadModule("/features/world/environment/lighting/forest-shadow-painter.ts");
const { createForestActorShadow, projectForestShadow } = await vite.ssrLoadModule("/features/world/environment/lighting/forest-shadow-geometry.ts");
const { createForestShadowFrame } = await vite.ssrLoadModule("/features/world/environment/lighting/forest-shadow-scene.ts");
const { forestLightSources } = await vite.ssrLoadModule("/features/world/environment/lighting/forest-lighting.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const authoredForest = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
const square = (x, y, size) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
const caster = (id = "oak", x = 80) => ({ id, points: square(x, 80, 15), height: 45, baseHeight: 0, opacity: .6, softness: 3 });
const scene = () => ({ schemaVersion: 1, id: "shadow-test", width: 1254, height: 1254, terrain: [], sites: [], paths: [],
  focus: { x: 0, y: 0, width: 300, height: 300 }, shadowCasters: [caster()],
  shadowReceivers: [{ id: "ground", points: square(0, 0, 400), height: 0 }] });
const lamp = (id = "lamp", x = 40) => ({ id, position: { x, y: 90 }, height: 28, radius: 200, intensity: .8, color: "#ffd28a" });
const frame = () => ({ night: 1, azimuth: 135, elevation: 40, quality: "high", sources: [lamp()], actors: [] });

function context() {
  const calls = [], stack = [], ctx = { canvas: { width: 800, height: 800 }, globalAlpha: .7,
    imageSmoothingEnabled: false, globalCompositeOperation: "source-over", filter: "none", fillStyle: "original", strokeStyle: "original", lineWidth: 2,
    transform: [1, 0, 0, 1, 13, 25] };
  const state = () => ({ globalAlpha: ctx.globalAlpha, globalCompositeOperation: ctx.globalCompositeOperation,
    imageSmoothingEnabled: ctx.imageSmoothingEnabled, filter: ctx.filter, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, transform: [...ctx.transform] });
  ctx.save = () => { stack.push(state()); calls.push({ method: "save" }); };
  ctx.restore = () => { Object.assign(ctx, stack.pop()); calls.push({ method: "restore" }); };
  ctx.setTransform = (...args) => { ctx.transform = args; calls.push({ method: "setTransform", args }); };
  ctx.getTransform = () => ({ a: ctx.transform[0], b: ctx.transform[1], c: ctx.transform[2], d: ctx.transform[3], e: ctx.transform[4], f: ctx.transform[5] });
  ctx.createRadialGradient = (...args) => {
    const gradient = { stops: [], addColorStop(...stop) { this.stops.push(stop); } };
    calls.push({ method: "gradient", args, gradient }); return gradient;
  };
  for (const method of ["drawImage", "fillRect", "clearRect", "beginPath", "moveTo", "lineTo", "closePath", "fill", "clip", "stroke", "arc"])
    ctx[method] = (...args) => calls.push({ method, args, ...state() });
  // Rendering must never copy or read CPU pixels from the painted background.
  ctx.getImageData = ctx.putImageData = () => assert.fail("No pixel readback or pixel loops in the lighting pipeline");
  return { ctx, calls, state, stack };
}
function withCanvas(run) {
  const previous = globalThis.document, surfaces = [];
  globalThis.document = { createElement(tag) {
    assert.equal(tag, "canvas"); const paint = context();
    const canvas = { width: 0, height: 0, getContext: () => paint.ctx }; paint.ctx.canvas = canvas;
    surfaces.push({ canvas, ...paint }); return canvas;
  } };
  try { run(surfaces); } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
}
const fills = surface => surface.calls.filter(call => call.method === "fill");
const pools = surfaces => surfaces.filter(surface => fills(surface).some(call => call.globalCompositeOperation === "destination-out"));

test("missing receivers and unsupported canvas retain the legacy fallback without side effects", () => {
  const paint = context(), original = paint.state();
  assert.equal(drawForestOccludedLighting(paint.ctx, { ...scene(), shadowReceivers: [] }, frame()), false);
  const previous = globalThis.document; delete globalThis.document;
  try {
    assert.equal(drawForestOccludedLighting(paint.ctx, scene(), frame()), false);
    drawForestDirectionalShadows(paint.ctx, scene(), frame());
  } finally { if (previous !== undefined) globalThis.document = previous; }
  assert.deepEqual(paint.state(), original); assert.equal(paint.calls.length, 0);
});

test("each lamp erases only its own contribution and the field screens both contributions independently", () => withCanvas(surfaces => {
  const map = scene(), options = { ...frame(), sources: [lamp("left", 40), lamp("right", 150)] };
  const paint = context(), original = paint.state();
  assert.equal(drawForestOccludedLighting(paint.ctx, map, options), true);
  const erased = pools(surfaces); assert.equal(erased.length, 2);
  for (const light of erased) {
    assert.equal(fills(light).length, 1, "one nonzero fill per prism, not one alpha fill per projected triangle");
    assert.equal(fills(light)[0].globalAlpha, .6);
    assert.ok(light.calls.findIndex(call => call.method === "clip") < light.calls.findIndex(call => call.method === "fill"), "receiver clips all shadow removal");
    assert.ok(light.calls.filter(call => call.method === "lineTo").length > 10, "full projected prism is composed before filling");
  }
  const field = surfaces[1], contributions = field.calls.filter(call => call.method === "drawImage" && call.globalCompositeOperation === "screen");
  assert.equal(contributions.length, 2, "the right lamp can fill a shadow from the left lamp");
  assert.ok(contributions.every(call => call.globalAlpha === .8));
  assert.equal(paint.calls.filter(call => call.method === "drawImage").length, 1);
  assert.equal(paint.calls.find(call => call.method === "drawImage").globalCompositeOperation, "multiply");
  assert.deepEqual(paint.state(), original); assert.equal(paint.stack.length, 0);
}));

test("camera, intensity, night transition and actor movement reuse static geometry and lamp textures", () => withCanvas(surfaces => {
  const map = scene(), options = frame(), paint = context(); drawForestOccludedLighting(paint.ctx, map, options);
  const count = surfaces.length, mask = pools(surfaces)[0], staticFills = fills(mask).length;
  paint.ctx.setTransform(3, 0, 0, 3, -300, -180);
  drawForestOccludedLighting(paint.ctx, map, { ...options, night: .5,
    sources: [{ ...lamp(), intensity: .35 }], actors: [caster("mochlik", 110)] });
  drawForestOccludedLighting(paint.ctx, map, { ...options, actors: [caster("mochlik", 115)] });
  assert.equal(surfaces.length, count); assert.equal(fills(mask).length, staticFills);
  const moving = fills(surfaces[2]); assert.equal(moving.length, 2);
  assert.ok(moving.every(call => call.filter === "none"), "moving actor uses cheap geometry without a per-frame blur");
  const contributions = surfaces[1].calls.filter(call => call.method === "drawImage" && call.globalCompositeOperation === "screen");
  assert.equal(contributions.at(-2).globalAlpha, .35);
  assert.equal(paint.calls.filter(call => call.method === "drawImage").at(-2).globalAlpha, .35);
}));

test("bright flame pulses add light energy without rebuilding their shadow texture", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), options = frame();
  drawForestOccludedLighting(paint.ctx, map, options); const count = surfaces.length;
  drawForestOccludedLighting(paint.ctx, map, { ...options, sources: [{ ...lamp(), intensity: 1.2 }] });
  assert.equal(surfaces.length, count);
  const contributions = surfaces[1].calls.filter(call => call.method === "drawImage" && call.globalCompositeOperation === "screen");
  assert.equal(contributions.at(-2).globalAlpha, 1);
  assert.ok(Math.abs(contributions.at(-1).globalAlpha - .2) < 1e-12);
}));

test("moving a source rebuilds its projection while unchanged sources remain cached", () => withCanvas(surfaces => {
  const map = scene(), options = { ...frame(), sources: [lamp("left"), lamp("right", 150)] }, paint = context();
  drawForestOccludedLighting(paint.ctx, map, options); const count = surfaces.length;
  const [left, right] = pools(surfaces), previousCalls = left.calls.length, rightCalls = right.calls.length;
  const before = left.calls.filter(call => call.method === "lineTo").map(call => call.args);
  drawForestOccludedLighting(paint.ctx, map, { ...options, sources: [{ ...lamp("left"), position: { x: 55, y: 60 } }, lamp("right", 150)] });
  assert.equal(surfaces.length, count, "moving a source repaints the existing buffer");
  assert.equal(right.calls.length, rightCalls, "the other source stays cached");
  const after = left.calls.slice(previousCalls).filter(call => call.method === "lineTo").map(call => call.args);
  assert.notDeepEqual(after, before);
}));

test("edits to authored geometry invalidate masks; legacy Occluders do not participate", () => withCanvas(surfaces => {
  const map = scene(), options = frame(), paint = context();
  drawForestOccludedLighting(paint.ctx, map, options); const count = surfaces.length;
  map.occluders = [{ id: "unrelated", points: square(1, 1, 120), frontY: 130 }];
  drawForestOccludedLighting(paint.ctx, map, options); assert.equal(surfaces.length, count);
  map.shadowCasters[0].height += 20; drawForestOccludedLighting(paint.ctx, map, options);
  assert.ok(surfaces.length > count, "height edits rebuild projections without replacing the scene object");
}));

test("same-height receiver polygons form one union so overlaps do not erase a caster twice", () => withCanvas(surfaces => {
  const map = scene(); map.shadowReceivers.push({ id: "other", points: square(20, 20, 250).reverse(), height: 0 });
  drawForestOccludedLighting(context().ctx, map, frame());
  const mask = pools(surfaces)[0]; assert.equal(fills(mask).length, 1);
  assert.equal(mask.calls.filter(call => call.method === "clip").length, 1);
}));

test("raised receivers get their own projection while a lamp outside its own building remains visible", () => withCanvas(surfaces => {
  const map = scene(); map.shadowReceivers.push({ id: "roof", points: square(0, 0, 250), height: 20 });
  map.shadowCasters.push({ ...caster("house", 45), when: { siteId: "home", level: 1 } });
  const options = { ...frame(), sources: [{ ...lamp(), ownerSiteId: "home" }] };
  drawForestOccludedLighting(context().ctx, map, options);
  assert.equal(fills(pools(surfaces)[0]).length, 2, "oak projects on both receiver heights; house never blocks its own exterior lamp");
}));

test("directional geometry is reused across night and camera changes; angle changes its shadow", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), options = frame(), original = paint.state();
  drawForestDirectionalShadows(paint.ctx, map, options); const count = surfaces.length;
  const before = fills(surfaces.at(-1)); assert.equal(before.length, 1);
  drawForestDirectionalShadows(paint.ctx, map, { ...options, night: 0, actors: [caster("actor", 110)] });
  assert.equal(surfaces.length, count); assert.equal(fills(surfaces.at(-1)).length, 1);
  const draws = paint.calls.filter(call => call.method === "drawImage");
  assert.ok(Math.abs(draws[0].globalAlpha - .049) < 1e-12); assert.ok(Math.abs(draws[1].globalAlpha - .126) < 1e-12);
  drawForestDirectionalShadows(paint.ctx, map, { ...options, azimuth: 240 }); assert.equal(surfaces.length, count + 1);
  assert.deepEqual(paint.state(), original); assert.equal(paint.stack.length, 0);
}));

test("quality and lamp-history budgets cap every allocation and evict old lamp masks", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), options = { ...frame(), quality: "low" };
  for (let index = 0; index < 20; index++) drawForestOccludedLighting(paint.ctx, map, { ...options, sources: [lamp(`lamp-${index}`)] });
  assert.ok(surfaces.every(surface => surface.canvas.width <= 512 && surface.canvas.height <= 512));
  let count = surfaces.length;
  drawForestOccludedLighting(paint.ctx, map, { ...options, sources: [lamp("lamp-19")] }); assert.equal(surfaces.length, count);
  drawForestOccludedLighting(paint.ctx, map, { ...options, sources: [lamp("lamp-0")] }); assert.equal(surfaces.length, count + 1, "evicted geometry is rebuilt");
  count = surfaces.length; drawForestOccludedLighting(paint.ctx, map, frame());
  assert.ok(surfaces.slice(count).every(surface => surface.canvas.width <= 768 && surface.canvas.height <= 768));
}));

test("daytime, disabled sources and distant actors perform no unnecessary shadow removal", () => withCanvas(surfaces => {
  const paint = context(), map = scene(), options = frame();
  assert.equal(drawForestOccludedLighting(paint.ctx, map, { ...options, night: 0 }), true);
  assert.equal(paint.calls.length, 0); const count = surfaces.length;
  drawForestOccludedLighting(paint.ctx, map, { ...options, sources: [{ ...lamp(), intensity: 0 }] }); assert.equal(surfaces.length, count);
  drawForestOccludedLighting(paint.ctx, map, { ...options, actors: [caster("distant", 900)] });
  assert.equal(fills(surfaces[2]).length, 0);
}));

test("debug overlay restores drawing state and shows independent bases, heights and receiver contours", () => {
  const paint = context(), original = paint.state(); drawForestShadowDebug(paint.ctx, scene(), frame());
  assert.ok(paint.calls.some(call => call.method === "stroke" && call.strokeStyle === "#56d5ec"));
  assert.ok(paint.calls.some(call => call.method === "stroke" && call.strokeStyle === "#d187ff"));
  assert.ok(paint.calls.some(call => call.method === "arc" && call.strokeStyle === "#ffce73"));
  assert.deepEqual(paint.state(), original); assert.equal(paint.stack.length, 0);
});


test("building shadows toggle preserves building lamps and receiver surfaces", () => withCanvas(surfaces => {
  const map = scene(); map.shadowCasters.push({ ...caster("house", 50), when: { siteId: "home", level: 1 } });
  map.shadowReceivers[0].when = { siteId: "home", level: 1 };
  const options = { ...frame(), sources: [{ ...lamp(), ownerSiteId: "workshop" }], showBuildings: true };
  const paint = context(); drawForestOccludedLighting(paint.ctx, map, options);
  assert.equal(fills(pools(surfaces)[0]).length, 2);
  const previous = surfaces.length;
  assert.equal(drawForestOccludedLighting(paint.ctx, map, { ...options, buildingShadows: false }), true);
  const next = surfaces.slice(previous), mask = pools(next)[0];
  assert.equal(fills(mask).length, 1, "only the unconditional tree blocks light");
  assert.equal(next[1].calls.filter(call => call.method === "drawImage" && call.globalCompositeOperation === "screen").length, 1,
    "visible workshop lamp still illuminates the building receiver");
  drawForestDirectionalShadows(paint.ctx, map, { ...options, buildingShadows: false });
  assert.equal(fills(surfaces.at(-1)).length, 1, "directional building shadows share the same independent toggle");
}));

test("both final lighting fields smooth their upscaling and restore the pixel-art drawing state", () => withCanvas(() => {
  const paint = context(), initial = paint.state(), map = scene();
  drawForestDirectionalShadows(paint.ctx, map, { ...frame(), quality: "low" });
  drawForestOccludedLighting(paint.ctx, map, { ...frame(), quality: "low" });
  const draws = paint.calls.filter(call => call.method === "drawImage");
  assert.equal(draws.length, 2); assert.ok(draws.every(call => call.imageSmoothingEnabled === true));
  assert.deepEqual(paint.state(), initial); assert.equal(paint.ctx.imageSmoothingEnabled, false);
}));

test("lamps with no nearby actor screen cached pools directly without clearing or copying scratch", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), options = { ...frame(), sources: [lamp("near"), lamp("far", 700)] };
  drawForestOccludedLighting(paint.ctx, map, { ...options, actors: [caster("far-away", 1050)] });
  const scratch = surfaces[2], field = surfaces[1];
  assert.equal(scratch.calls.length, 0, "no actor intersects either lamp: scratch is entirely unused");
  let contributions = field.calls.filter(call => call.method === "drawImage" && call.globalCompositeOperation === "screen");
  assert.ok(contributions.every(call => call.args[0] !== scratch.canvas));
  const count = surfaces.length;
  drawForestOccludedLighting(paint.ctx, map, { ...options, actors: [caster("inside-near-light", 110)] });
  assert.equal(surfaces.length, count, "moving into a light never regenerates static pools");
  assert.equal(scratch.calls.filter(call => call.method === "clearRect").length, 1, "only the nearby lamp needs a dynamic mask");
  contributions = field.calls.filter(call => call.method === "drawImage" && call.globalCompositeOperation === "screen").slice(-2);
  assert.equal(contributions[0].args[0], scratch.canvas); assert.notEqual(contributions[1].args[0], scratch.canvas);
  drawForestOccludedLighting(paint.ctx, map, { ...options, actors: [{ ...caster("wide-body", -30), points: square(-30, 80, 100) }] });
  assert.equal(scratch.calls.filter(call => call.method === "clearRect").length, 2, "a body's bounds crossing the light still needs a shadow");
}));

test("runtime geometry revisions avoid serialization and invalidate every edited shape or visibility state", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), options = { ...frame(), geometryRevision: 0 };
  // Hot-path geometry serialization would invoke this callback. Source keys
  // contain only scalar values and must remain independent of this object.
  map.shadowCasters[0].toJSON = () => assert.fail("revisioned geometry must not be serialized during rendering");
  drawForestDirectionalShadows(paint.ctx, map, options);
  drawForestOccludedLighting(paint.ctx, map, options);
  let count = surfaces.length;
  drawForestDirectionalShadows(paint.ctx, map, options);
  drawForestOccludedLighting(paint.ctx, map, { ...options, night: .4 });
  assert.equal(surfaces.length, count);
  map.shadowCasters[0].height += 20;
  drawForestOccludedLighting(paint.ctx, map, { ...options, geometryRevision: 1 });
  assert.ok(surfaces.length > count, "a height edit with a new revision rebuilds masks");
  count = surfaces.length;
  map.shadowCasters = [{ ...map.shadowCasters[0], points: square(95, 85, 19) }];
  drawForestOccludedLighting(paint.ctx, map, { ...options, geometryRevision: 1 });
  assert.ok(surfaces.length > count, "replacing contours invalidates even the same explicit revision");
  count = surfaces.length;
  drawForestOccludedLighting(paint.ctx, map, { ...options, geometryRevision: 1, buildingShadows: false });
  assert.ok(surfaces.length > count, "visibility flags participate in the revision cache");
}));

test("each cached actor mask clears only its own cropped lamp area", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), body = caster("near", 90);
  const small = { ...lamp("small", 70), radius: 50 }, large = { ...lamp("large", 100), radius: 160 };
  const options = { ...frame(), geometryRevision: 0, sources: [large, small], actors: [body] };
  drawForestOccludedLighting(paint.ctx, map, options);
  const actorMasks = surfaces.filter(surface => surface.calls.some(call => call.method === "drawImage")
    && fills(surface).some(call => call.globalCompositeOperation === "destination-out"));
  assert.equal(actorMasks.length, 2);
  for (const mask of actorMasks) {
    assert.ok(mask.canvas.width < 768 && mask.canvas.height < 768);
    assert.deepEqual(mask.calls.find(call => call.method === "clearRect").args, [0, 0, mask.canvas.width, mask.canvas.height]);
  }
  const count = surfaces.length;
  drawForestOccludedLighting(paint.ctx, map, options);
  assert.equal(surfaces.length, count, "unchanged actor masks allocate no new buffers");
  assert.ok(actorMasks.every(mask => mask.calls.filter(call => call.method === "clearRect").length === 1));
  const contributions = surfaces[1].calls.filter(call => call.method === "drawImage" && call.globalCompositeOperation === "screen");
  const smallPool = actorMasks.find(surface => surface.canvas.width < 100);
  assert.deepEqual(contributions.at(-1).args.slice(1, 5), [0, 0, smallPool.canvas.width, smallPool.canvas.height]);
}));

test("exact brightness and night changes reuse actor masks while paused frames reuse both completed fields", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), options = { ...frame(), geometryRevision: 0, actors: [caster("body", 110)] };
  drawForestDirectionalShadows(paint.ctx, map, options);
  drawForestOccludedLighting(paint.ctx, map, options);
  const directionalClears = surfaces[3].calls.filter(call => call.method === "clearRect").length;
  const actorClears = surfaces[2].calls.filter(call => call.method === "clearRect").length;
  const fieldClears = surfaces[1].calls.filter(call => call.method === "clearRect").length;
  drawForestDirectionalShadows(paint.ctx, map, { ...options, actors: structuredClone(options.actors), night: .4 });
  drawForestOccludedLighting(paint.ctx, map, { ...options, actors: structuredClone(options.actors), night: .4 });
  assert.equal(surfaces[3].calls.filter(call => call.method === "clearRect").length, directionalClears);
  assert.equal(surfaces[1].calls.filter(call => call.method === "clearRect").length, fieldClears);
  drawForestOccludedLighting(paint.ctx, map, { ...options, sources: [{ ...lamp(), intensity: .800123 }] });
  assert.equal(surfaces[2].calls.filter(call => call.method === "clearRect").length, actorClears, "flicker never recalculates an unchanged body mask");
  assert.equal(surfaces[1].calls.filter(call => call.method === "clearRect").length, fieldClears + 1);
  assert.equal(surfaces[1].calls.filter(call => call.method === "drawImage" && call.globalCompositeOperation === "screen").at(-1).globalAlpha, .800123);
}));

test("actor opacity, body height, jump lift and contour edits invalidate cached moving shadows", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), body = createForestActorShadow({ x: 110, y: 90 }, 7, "body"),
    options = { ...frame(), geometryRevision: 0, actors: [body] };
  drawForestDirectionalShadows(paint.ctx, map, options); drawForestOccludedLighting(paint.ctx, map, options);
  let clears = surfaces[2].calls.filter(call => call.method === "clearRect").length;
  for (const mutate of [() => body.opacity -= .1, () => body.height += 4, () => body.baseHeight += 2,
    () => { body.points[0].x -= 2; }]) {
    mutate(); drawForestDirectionalShadows(paint.ctx, map, options); drawForestOccludedLighting(paint.ctx, map, options);
    assert.equal(surfaces[2].calls.filter(call => call.method === "clearRect").length, ++clears);
  }
}));

test("lamp-only scene clones share geometry caches and source edits repaint their own reusable pools", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), options = { ...frame(), geometryRevision: 0 };
  drawForestDirectionalShadows(paint.ctx, map, options); drawForestOccludedLighting(paint.ctx, map, options);
  const count = surfaces.length;
  const cloned = { ...map, lights: [] };
  drawForestDirectionalShadows(paint.ctx, cloned, options); drawForestOccludedLighting(paint.ctx, cloned, options);
  assert.equal(surfaces.length, count, "unchanged immutable geometry shares masks through a lamp draft scene clone");
  const poolCanvas = surfaces.at(-1).canvas;
  for (const change of [{ height: 35 }, { radius: 180 }, { color: "#ffaa22" }, { ownerSiteId: "home" },
    { position: { x: 50, y: 70 } }]) {
    drawForestOccludedLighting(paint.ctx, cloned, { ...options, sources: [{ ...lamp(), ...change }] });
    assert.equal(surfaces.length, count, "editing a source reuses its canvas rather than retaining previous positions");
    assert.equal(surfaces.at(-1).canvas, poolCanvas);
  }
}));

test("a dragged lamp reuses static and actor buffers while invalidating both masks for every new position", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), body = caster("near-light", 110),
    options = { ...frame(), geometryRevision: 0, actors: [body] };
  drawForestOccludedLighting(paint.ctx, map, options);
  const count = surfaces.length, light = surfaces.at(-1), moving = surfaces[2];
  const staticFills = fills(light).length, dynamicFills = fills(moving).length;
  for (let step = 1; step <= 120; step++) {
    const source = { ...lamp(), position: { x: 40 + step / 2, y: 90 + step / 4 } };
    drawForestOccludedLighting(paint.ctx, { ...map, lights: [] }, { ...options, sources: [source] });
  }
  assert.equal(surfaces.length, count, "120 drag frames allocate no additional canvas, including moving actor masks");
  assert.equal(fills(light).length, staticFills + 120, "static occlusion follows every accepted source position");
  assert.equal(fills(moving).length, dynamicFills + 120, "an unchanged actor still needs a new projection from the moving light");
  const clears = moving.calls.filter(call => call.method === "clearRect").length;
  drawForestOccludedLighting(paint.ctx, map, { ...options, sources: [{ ...lamp(), position: { x: 100, y: 120 } }] });
  assert.equal(moving.calls.filter(call => call.method === "clearRect").length, clears, "the final unchanged frame remains cached");
}));

test("geometry sharing retains only two recent contour variants instead of every editor undo state", () => withCanvas(surfaces => {
  const base = scene(), paint = context(), options = { ...frame(), geometryRevision: 0 };
  const variants = [80, 90, 100].map(x => ({ ...base, shadowCasters: [caster(`shape-${x}`, x)] }));
  for (const variant of variants) drawForestOccludedLighting(paint.ctx, variant, options);
  let count = surfaces.length;
  drawForestOccludedLighting(paint.ctx, { ...variants[2], lights: [] }, options);
  assert.equal(surfaces.length, count, "the current contour variant shares its existing buffers");
  drawForestOccludedLighting(paint.ctx, { ...variants[0], lights: [] }, options);
  assert.ok(surfaces.length > count, "a new clone of the oldest contour must rebuild evicted shared buffers");
  count = surfaces.length;
  drawForestOccludedLighting(paint.ctx, { ...variants[2], lights: [] }, options);
  assert.equal(surfaces.length, count, "the two most recent variants remain reusable");
}));

test("offscreen point sources are omitted until camera movement exposes their complete footprint", () => withCanvas(surfaces => {
  const map = scene(), paint = context(), options = { ...frame(), geometryRevision: 0, sources: [lamp("outside", 700)] };
  paint.ctx.canvas.width = paint.ctx.canvas.height = 200;
  paint.ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawForestOccludedLighting(paint.ctx, map, options);
  assert.equal(pools(surfaces).length, 0, "offscreen lamp creates no gradient or shadow mask");
  paint.ctx.setTransform(1, 0, 0, 1, -600, 0);
  drawForestOccludedLighting(paint.ctx, map, options);
  assert.equal(surfaces.filter(surface => surface.calls.some(call => call.method === "gradient")).length, 2,
    "ambient and newly visible lamp gradients are created");
  assert.equal(surfaces[1].calls.filter(call => call.method === "drawImage" && call.globalCompositeOperation === "screen").length, 1);
}));

test("directional culling keeps an offscreen body whose long shadow enters the viewport", () => withCanvas(surfaces => {
  const map = scene(), paint = context(); paint.ctx.canvas.width = paint.ctx.canvas.height = 100;
  paint.ctx.setTransform(1, 0, 0, 1, 0, 0);
  const entering = { ...caster("outside-but-casting", 110), height: 100 };
  drawForestDirectionalShadows(paint.ctx, map, { ...frame(), geometryRevision: 0, azimuth: 0, elevation: 45,
    actors: [entering, caster("too-far", 800)] });
  assert.equal(fills(surfaces[3]).length, 1, "only the swept shadow intersecting the viewport is rendered");
  drawForestDirectionalShadows(paint.ctx, map, { ...frame(), geometryRevision: 0, azimuth: 180, elevation: 45,
    actors: [entering, caster("too-far", 800)] });
  assert.equal(fills(surfaces[3]).length, 1, "changing the sun to point away from the viewport culls both bodies");
}));

test("directional shadows use the static mask directly when no moving actor contributes", () => withCanvas(surfaces => {
  const map = scene(), paint = context();
  drawForestDirectionalShadows(paint.ctx, map, frame());
  assert.equal(surfaces[3].calls.length, 0, "no full-map copy or clear without actors");
  assert.equal(paint.calls.find(call => call.method === "drawImage").args[0], surfaces.at(-1).canvas);
}));

test("native receiver paths are prepared once and reused by independent lamps", () => withCanvas(surfaces => {
  const previous = globalThis.Path2D, paths = [];
  globalThis.Path2D = class {
    constructor() { this.calls = []; paths.push(this); }
    moveTo(...args) { this.calls.push(["moveTo", ...args]); }
    lineTo(...args) { this.calls.push(["lineTo", ...args]); }
    closePath() { this.calls.push(["closePath"]); }
  };
  try {
    const map = scene(), paint = context(), options = { ...frame(), geometryRevision: 0,
      sources: [lamp("left", 40), lamp("right", 150)], actors: [caster("moving", 100)] };
    drawForestOccludedLighting(paint.ctx, map, options);
    drawForestDirectionalShadows(paint.ctx, map, options);
    assert.equal(paths.length, 1, "one same-height receiver union is prepared once");
    assert.ok(paths[0].calls.some(call => call[0] === "lineTo"));
    const clips = surfaces.flatMap(surface => surface.calls.filter(call => call.method === "clip"));
    assert.ok(clips.length >= 6);
    assert.ok(clips.every(call => call.args[0] === paths[0]));
  } finally {
    if (previous === undefined) delete globalThis.Path2D; else globalThis.Path2D = previous;
  }
}));

function receiverContours(surface) {
  const clipIndex = surface.calls.findIndex(call => call.method === "clip");
  assert.ok(clipIndex >= 0);
  const nativePath = surface.calls[clipIndex].args[0];
  const calls = nativePath?.calls ?? surface.calls.slice(0, clipIndex).map(call => [call.method, ...call.args ?? []]);
  let contours = [], current = [];
  for (const [method, x, y] of calls) {
    if (method === "beginPath") { contours = []; current = []; }
    if (method === "moveTo") current = [{ x, y }];
    if (method === "lineTo") current.push({ x, y });
    if (method === "closePath") { contours.push(current); current = []; }
  }
  return contours;
}
// Independent nonzero winding evaluation of the actual paths sent to Canvas.
function windingAt(point, contours) {
  let winding = 0;
  for (const contour of contours) for (let index = 0; index < contour.length; index++) {
    const a = contour[index], b = contour[(index + 1) % contour.length];
    const side = (b.x - a.x) * (point.y - a.y) - (point.x - a.x) * (b.y - a.y);
    if (a.y <= point.y && b.y > point.y && side > 0) winding++;
    if (a.y > point.y && b.y <= point.y && side < 0) winding--;
  }
  return winding;
}

for (const native of [false, true]) test(`receiver holes clip lamp/sun/body shadows with scoped surface union (${native ? "Path2D" : "immediate"})`, () => withCanvas(surfaces => {
  const previous = globalThis.Path2D;
  if (native) globalThis.Path2D = class {
    constructor() { this.calls = []; }
    moveTo(...args) { this.calls.push(["moveTo", ...args]); }
    lineTo(...args) { this.calls.push(["lineTo", ...args]); }
    closePath() { this.calls.push(["closePath"]); }
  }; else delete globalThis.Path2D;
  try {
    const map = scene(), options = { ...frame(), actors: [caster("moving", 110)] };
    map.shadowReceivers = [{ id: "ground", points: square(0, 0, 400).reverse(), holes: [square(60, 60, 100)], height: 0 },
      { id: "island-in-hole", points: square(100, 100, 20).reverse(), height: 0 },
      { id: "overlapping-ground", points: square(180, 180, 100).reverse(), height: 0 }];
    drawForestOccludedLighting(context().ctx, map, options);
    drawForestDirectionalShadows(context().ctx, map, options);
    const masks = surfaces.filter(surface => surface.calls.some(call => call.method === "clip"));
    assert.ok(masks.length >= 4, "static lamps, sun and both moving masks are clipped");
    for (const mask of masks) {
      const contours = receiverContours(mask);
      assert.equal(contours.length, 4, "three outer contours and one hole");
      assert.equal(windingAt({ x: 90, y: 90 }, contours), 0, "hole in its receiver excludes shadows");
      assert.equal(windingAt({ x: 110, y: 110 }, contours), 1, "another independent receiver can receive inside the first one's hole");
      assert.equal(windingAt({ x: 200, y: 200 }, contours), 2, "overlap remains in nonzero union instead of cancelling as evenodd would");
      assert.equal(windingAt({ x: 500, y: 500 }, contours), 0, "outside receiving surfaces remains excluded");
      assert.equal(mask.calls.filter(call => call.method === "clip").length, 1, "one same-height union avoids repeated shadow alpha");
    }
    const paint = context(); drawForestShadowDebug(paint.ctx, map, options);
    assert.ok(paint.calls.some(call => call.method === "moveTo" && call.args[0] === 60 && call.args[1] === 60), "debug shows the inner contour");
  } finally {
    if (previous === undefined) delete globalThis.Path2D; else globalThis.Path2D = previous;
  }
}));

// Sample the actual commands sent to Canvas rather than a second lighting
// implementation: recorded gradient stops, screen strengths, projected paths
// and receiver clips all come from the production painter.
function erasedAt(surface, point) {
  const receiver = receiverContours(surface);
  if (!windingAt(point, receiver)) return 1;
  let contours = [], current = [], transmission = 1;
  for (const call of surface.calls) {
    if (call.method === "beginPath") { contours = []; current = []; }
    if (call.method === "moveTo") current = [{ x: call.args[0], y: call.args[1] }];
    if (call.method === "lineTo") current.push({ x: call.args[0], y: call.args[1] });
    if (call.method === "closePath") { contours.push(current); current = []; }
    if (call.method === "fill" && call.globalCompositeOperation === "destination-out" && windingAt(point, contours)) {
      transmission *= 1 - call.globalAlpha;
    }
  }
  return transmission;
}
function sampledPoolRed(surfaces, surface, point) {
  const gradient = surface.calls.find(call => call.method === "gradient");
  let red;
  if (gradient) {
    const [x, y, , , , radius] = gradient.args, distance = Math.hypot(point.x - x, point.y - y) / radius;
    if (distance >= 1) return 0;
    const stops = gradient.gradient.stops.map(([at, color]) => ({ at, channels: color.match(/[\d.]+/g).map(Number) }));
    const upper = stops.findIndex(stop => stop.at >= distance), before = stops[Math.max(0, upper - 1)], after = stops[upper];
    const ratio = after.at === before.at ? 0 : (distance - before.at) / (after.at - before.at);
    const alpha = before.channels[3] + (after.channels[3] - before.channels[3]) * ratio;
    red = before.channels[0] / 255 * alpha;
  } else {
    const copy = surface.calls.find(call => call.method === "drawImage");
    assert.ok(copy, "dynamic actor mask starts from its source's static pool");
    red = sampledPoolRed(surfaces, surfaces.find(value => value.canvas === copy.args[0]), point);
  }
  return surface.calls.some(call => call.method === "clip") ? red * erasedAt(surface, point) : red;
}
function sampledFieldRed(surfaces, field, point) {
  let remaining = 1;
  for (const call of field.calls) if (call.method === "drawImage" && call.globalCompositeOperation === "screen") {
    const source = surfaces.find(value => value.canvas === call.args[0]);
    remaining *= 1 - sampledPoolRed(surfaces, source, point) * call.globalAlpha;
  }
  return 1 - remaining;
}
for (const quality of ["low", "high"]) test(`the real clearing's open fire casts the leading shadow away from the hearth (${quality})`, () => withCanvas(surfaces => {
  const levels = Object.fromEntries(authoredForest.sites.map(site => [site.id, 1]));
  const map = previewWorldScene(structuredClone(authoredForest), levels), fire = map.campfires[0];
  const actor = { ...fire.seat, id: "mochlik", size: 36 }, original = structuredClone(map);
  const options = { night: 1, elapsed: 0, reducedMotion: true, quality,
    lights: forestLightSources(map, { levels, night: 1, elapsed: 0, reducedMotion: true }),
    fires: [{ ...fire, flame: 1, embers: 1 }], actors: [actor] };
  const active = createForestShadowFrame(map, options);
  drawForestOccludedLighting(context().ctx, map, active);
  const actorField = surfaces[1], controlIndex = surfaces.length;
  drawForestOccludedLighting(context().ctx, { ...map }, { ...active, actors: [] });
  const controlField = surfaces[controlIndex + 1];
  function loss(angle, bodyField = actorField, baseField = controlField) {
    let difference = 0;
    for (let distance = 9; distance <= 24; distance++) {
      const point = { x: actor.x + Math.cos(angle * Math.PI / 180) * distance,
        y: actor.y + Math.sin(angle * Math.PI / 180) * distance };
      difference += sampledFieldRed(surfaces, baseField, point) - sampledFieldRed(surfaces, bodyField, point);
    }
    return difference;
  }
  assert.ok(loss(150) > loss(90), "fire on the right produces a stronger leftward shadow than the house lantern's downward shadow");
  assert.ok(loss(150) > .25, "the local shadow has visible contrast, rather than merely rotating a negligible mask");
  const embers = createForestShadowFrame(map, { ...options, fires: [{ ...fire, flame: 0, embers: .4 }] });
  const emberIndex = surfaces.length;
  drawForestOccludedLighting(context().ctx, { ...map }, embers);
  const emberControlIndex = surfaces.length;
  drawForestOccludedLighting(context().ctx, { ...map }, { ...embers, actors: [] });
  assert.ok(loss(90, surfaces[emberIndex + 1], surfaces[emberControlIndex + 1])
    > loss(150, surfaces[emberIndex + 1], surfaces[emberControlIndex + 1]), "after the flame goes out the house lantern naturally becomes the leading source");
  const day = context();
  drawForestOccludedLighting(day.ctx, map, { ...active, night: 0 });
  assert.equal(day.calls.length, 0, "daylight retains its existing lighting path without an extra night overlay");
  assert.deepEqual(map, original, "drawing and frame construction do not mutate authored geometry or advance campfires");
  assert.ok(surfaces.every(surface => surface.canvas.width <= (quality === "low" ? 512 : 768)
    && surface.canvas.height <= (quality === "low" ? 512 : 768)), "larger fire pool stays in the existing bounded allocation budget");
}));

test("the real hearth's shadow follows actors around the flame without reversing or moving their feet", () => {
  const map = previewWorldScene(structuredClone(authoredForest), { home: 1 }), fire = map.campfires[0];
  for (const offset of [{ x: -32, y: 10 }, { x: 32, y: 10 }, { x: 0, y: -32 }, { x: 0, y: 32 }]) {
    const actor = { x: fire.position.x + offset.x, y: fire.position.y + offset.y, size: 36, id: "mochlik" };
    const lightFrame = createForestShadowFrame(map, { night: 1, elapsed: 12, reducedMotion: false,
      lights: [], fires: [{ ...fire, flame: 1, embers: 1 }], actors: [actor] });
    const source = lightFrame.sources[0], caster = lightFrame.actors[0];
    const pieces = projectForestShadow(caster, { kind: "point", ...source });
    const length = Math.hypot(offset.x, offset.y), ray = { x: offset.x / length * 16, y: offset.y / length * 16 };
    assert.ok(windingAt({ x: actor.x + ray.x, y: actor.y + ray.y }, pieces) > 0, "shadow continues away from the ground anchor of the flame");
    assert.equal(windingAt({ x: actor.x - ray.x, y: actor.y - ray.y }, pieces), 0, "the lit space between actor and fire stays outside the shadow");
    assert.ok(Math.abs(caster.points.reduce((sum, point) => sum + point.x, 0) / caster.points.length - actor.x) < 1e-9);
    assert.ok(Math.abs(caster.points.reduce((sum, point) => sum + point.y, 0) / caster.points.length - actor.y) < 1e-9);
  }
});
