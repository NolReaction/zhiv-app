import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { drawBuildingDetails, buildingDetailsAnimated } = await vite.ssrLoadModule("/features/world/building-details.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const window = [{ x: 120, y: 140 }, { x: 130, y: 139 }, { x: 132, y: 154 }, { x: 121, y: 155 }];
const scene = () => ({ sites: [{ id: "home", bounds: { x: 100, y: 100, width: 145, height: 145 },
  chimney: { x: 135, y: 112 }, window }] });
const options = { night: 1, elapsed: 12, reducedMotion: false };

function context() {
  const calls = [], stack = [], ctx = { canvas: { width: 800, height: 800 },
    globalAlpha: .7, globalCompositeOperation: "source-over", fillStyle: "original",
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  const state = () => ({ globalAlpha: ctx.globalAlpha, globalCompositeOperation: ctx.globalCompositeOperation, fillStyle: ctx.fillStyle });
  ctx.save = () => stack.push(state()); ctx.restore = () => Object.assign(ctx, stack.pop());
  ctx.createRadialGradient = (...args) => {
    const gradient = { stops: [], addColorStop(...stop) { this.stops.push(stop); } };
    calls.push({ method: "gradient", args }); return gradient;
  };
  for (const method of ["beginPath", "moveTo", "lineTo", "closePath", "rect", "clip", "fillRect", "drawImage"])
    ctx[method] = (...args) => calls.push({ method, args, ...state() });
  return { ctx, calls, stack, state };
}

test("only authored details draw; window warmth is night-only, clipped and preserves canvas state", () => {
  const map = scene(); delete map.sites[0].chimney;
  const day = context(); drawBuildingDetails(day.ctx, map, { ...options, night: 0 });
  assert.equal(day.calls.length, 0);
  assert.equal(buildingDetailsAnimated(map), false, "static windows do not request animation frames");
  const night = context(), before = night.state(); drawBuildingDetails(night.ctx, map, options);
  const clip = night.calls.findIndex(call => call.method === "clip");
  const fill = night.calls.findIndex(call => call.method === "fillRect");
  assert.ok(clip >= 0 && fill > clip, "light cannot cover the facade outside the authored window");
  assert.equal(night.calls[fill].globalCompositeOperation, "screen");
  assert.ok(night.calls[fill].fillStyle.stops.every(([, color]) => Number(color.match(/,([\d.]+)\)/)[1]) < .4));
  assert.deepEqual(night.state(), before); assert.equal(night.stack.length, 0);
  const legacy = context(); drawBuildingDetails(legacy.ctx, { sites: [{ id: "legacy" }] }, options);
  assert.equal(legacy.calls.length, 0, "no guessed chimney or window positions");
});

test("chimney smoke is bounded and deterministic, freezes with time, and disappears for reduced motion", () => {
  const map = scene(); delete map.sites[0].window;
  assert.equal(buildingDetailsAnimated(map), true);
  const render = elapsed => { const paint = context(); drawBuildingDetails(paint.ctx, map, { ...options, elapsed }); return paint; };
  const first = render(12), same = render(12), later = render(13);
  // Gradient objects contain functions; compare recorded geometry and blending instead.
  const signature = paint => paint.calls.map(({ method, args, globalAlpha }) => ({ method, args, globalAlpha }));
  assert.deepEqual(signature(first), signature(same));
  assert.notDeepEqual(signature(first), signature(later));
  assert.equal(first.stack.length, 0);
  assert.equal(first.ctx.globalAlpha, .7);
  for (let elapsed = 0; elapsed < 16; elapsed += .13) {
    const fills = render(elapsed).calls.filter(call => call.method === "fillRect");
    assert.equal(fills.length, 6);
    for (const { args: [x, y, width, height], globalAlpha } of fills) {
      assert.ok([x, y, width, height, globalAlpha].every(Number.isFinite));
      assert.ok(globalAlpha >= 0 && globalAlpha <= .13);
      assert.ok(x > 120 && x < 155 && y > 55 && y < 115);
      assert.ok(width > 0 && width < 22 && height <= 27);
    }
  }
  for (const overrides of [{ reducedMotion: true }, { showBuildings: false }]) {
    const paint = context(); drawBuildingDetails(paint.ctx, map, { ...options, ...overrides });
    assert.equal(paint.calls.length, 0);
  }
  const offscreen = context(); offscreen.ctx.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 10000, f: 10000 });
  drawBuildingDetails(offscreen.ctx, scene(), options); assert.equal(offscreen.calls.length, 0);
});

test("the plume stays attached to its mouth, overlaps continuously and disperses upward without particle resets", () => {
  const map = scene(); delete map.sites[0].window;
  let previous;
  for (let elapsed = 0; elapsed < 16; elapsed += .01) {
    const paint = context(); drawBuildingDetails(paint.ctx, map, { ...options, elapsed });
    const [{ args: [clipX, clipY, clipWidth, clipHeight] }] = paint.calls.filter(call => call.method === "rect");
    assert.equal(clipY + clipHeight, map.sites[0].chimney.y, "soft plume tails never cover the pipe below its mouth");
    assert.ok(clipX < map.sites[0].chimney.x && clipX + clipWidth > map.sites[0].chimney.x);
    const segments = paint.calls.filter(call => call.method === "fillRect");
    const first = segments[0], last = segments.at(-1);
    assert.ok(first.globalAlpha > .04, "the narrow base never disappears between particles");
    assert.equal(first.args[0] + first.args[2] / 2, map.sites[0].chimney.x);
    assert.ok(first.args[1] < map.sites[0].chimney.y && first.args[1] + first.args[3] > map.sites[0].chimney.y);
    assert.ok(last.globalAlpha < first.globalAlpha * .25, "the upper plume dissolves into the background");
    assert.ok(last.args[2] > first.args[2] * 4, "smoke spreads as it rises");
    for (let index = 1; index < segments.length; index++) {
      const lower = segments[index - 1].args, upper = segments[index].args;
      assert.ok(upper[1] + upper[3] > lower[1] + lower[3] * .3, "adjacent soft segments overlap without bead gaps");
    }
    if (previous) for (let index = 0; index < segments.length; index++) {
      const before = previous[index], current = segments[index];
      assert.ok(Math.abs(before.args[0] - current.args[0]) < .04, "shape remains continuous across the old particle reset times");
      assert.ok(Math.abs(before.globalAlpha - current.globalAlpha) < .001);
    }
    previous = segments;
  }
});

test("window and smoke respect incoming transparency and restore it after drawing", () => {
  const opaque = context(), faded = context(); opaque.ctx.globalAlpha = 1; faded.ctx.globalAlpha = .25;
  drawBuildingDetails(opaque.ctx, scene(), options); drawBuildingDetails(faded.ctx, scene(), options);
  const full = opaque.calls.filter(call => call.method === "fillRect"), quarter = faded.calls.filter(call => call.method === "fillRect");
  assert.equal(full.length, quarter.length);
  for (let index = 0; index < full.length; index++) assert.equal(quarter[index].globalAlpha, full[index].globalAlpha * .25);
  assert.equal(opaque.ctx.globalAlpha, 1); assert.equal(faded.ctx.globalAlpha, .25);
});

test("switching to an earlier building cannot retain the later chimney or window", () => {
  const map = scene(), home = map.sites[0];
  home.initialLevel = 5;
  home.states = [{ level: 1, geometry: { bounds: home.bounds } },
    { level: 5, geometry: { bounds: home.bounds, chimney: home.chimney, window: home.window } }];
  const earlier = previewWorldScene(map, { home: 1 });
  assert.equal(earlier.sites[0].chimney, undefined); assert.equal(earlier.sites[0].window, undefined);
  assert.equal(buildingDetailsAnimated(earlier), false);
  const paint = context(); drawBuildingDetails(paint.ctx, earlier, options); assert.equal(paint.calls.length, 0);
  const later = previewWorldScene(map, { home: 5 });
  assert.deepEqual(later.sites[0].chimney, home.chimney); assert.deepEqual(later.sites[0].window, window);
});

test("smoke reuses one small texture across frames and buildings", () => {
  const beforeDocument = globalThis.document, canvases = [];
  globalThis.document = { createElement() {
    const paint = context(), canvas = { width: 0, height: 0, getContext: () => paint.ctx };
    canvases.push(canvas); return canvas;
  } };
  try {
    const map = scene(), first = context(), second = context();
    drawBuildingDetails(first.ctx, map, options);
    drawBuildingDetails(second.ctx, map, { ...options, elapsed: 99 });
    assert.equal(canvases.length, 1);
    assert.equal(canvases[0].width, 64); assert.equal(canvases[0].height, 64);
    const firstPuff = first.calls.find(call => call.method === "drawImage");
    assert.equal(firstPuff.args[0], second.calls.find(call => call.method === "drawImage").args[0]);
    assert.equal(first.calls.filter(call => call.method === "drawImage").length, 6);
  } finally {
    if (beforeDocument === undefined) delete globalThis.document; else globalThis.document = beforeDocument;
  }
});
