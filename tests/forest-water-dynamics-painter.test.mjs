import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { drawForestWaterDynamics } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-dynamics-painter.ts");
const { createDynamicsGeometry } = await vite.ssrLoadModule("/features/world/environment/water/water-dynamics-geometry.ts");

const rectangle = (x, y, width, height) => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];
const polygon = points => ({ points });
const scene = () => ({ width: 100, height: 100, water: {
  surfaces: [polygon(rectangle(5, 5, 65, 90)), polygon(rectangle(40, 10, 55, 80).reverse())],
  exclusions: [polygon(rectangle(20, 20, 20, 20)), polygon(rectangle(30, 30, 20, 20).reverse()),
    polygon(rectangle(85.02, 60, .04, .04))],
} });

function state() {
  const columns = 20, rows = 20, length = columns * rows, neighbours = new Int32Array(length * 4);
  const heights = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const x = index % columns, y = Math.floor(index / columns);
    neighbours.set([x ? index - 1 : index, x < columns - 1 ? index + 1 : index,
      y ? index - columns : index, y < rows - 1 ? index + columns : index], index * 4);
    heights[index] = Math.sin(x * .7) * Math.cos(y * .9);
  }
  return { columns, rows, cellSize: 5, scale: 1, origin: { x: 0, y: 0 },
    heights, neighbours, active: Uint32Array.from({ length }, (_, index) => index),
    leaves: [], touches: [], elapsed: 8, revision: 10 };
}

// An independent winding-number evaluator checks the resulting clip geometry
// at world coordinates, including exclusions much smaller than a texture pixel.
function winding(points, sample) {
  let sum = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    const side = (b.x - a.x) * (sample.y - a.y) - (sample.x - a.x) * (b.y - a.y);
    if (a.y <= sample.y && b.y > sample.y && side > 0) sum++;
    if (a.y > sample.y && b.y <= sample.y && side < 0) sum--;
  }
  return sum;
}

class Path {
  polygons = [];
  moveTo(x, y) { this.polygons.push([{ x, y }]); }
  lineTo(x, y) { this.polygons.at(-1).push({ x, y }); }
  closePath() {}
  rect(x, y, width, height) { this.polygons.push(rectangle(x, y, width, height)); }
  contains(point, rule) {
    const total = this.polygons.reduce((sum, points) => sum + winding(points, point), 0);
    return rule === "evenodd" ? Math.abs(total) % 2 === 1 : total !== 0;
  }
}

function browser(run) {
  const previousPath = globalThis.Path2D, previousCanvas = globalThis.OffscreenCanvas;
  const metrics = { allocations: [], updates: [] };
  globalThis.Path2D = Path;
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; metrics.allocations.push([width, height]); }
    getContext() { return {
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: image => metrics.updates.push(image.data.slice()),
    }; }
  };
  try { run(metrics); } finally {
    if (previousPath === undefined) delete globalThis.Path2D; else globalThis.Path2D = previousPath;
    if (previousCanvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = previousCanvas;
  }
}

function context(transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) {
  const clips = [], draws = [], paints = [], operations = [], stack = [];
  let path = [];
  return { clips, draws, vectorPaints: paints, operations, globalAlpha: 1,
    canvas: { width: 100, height: 100 }, imageSmoothingEnabled: false,
    getTransform: () => transform,
    save() { stack.push({ imageSmoothingEnabled: this.imageSmoothingEnabled, globalAlpha: this.globalAlpha }); },
    restore() { Object.assign(this, stack.pop()); },
    clip(path, rule) { clips.push({ path, rule }); },
    drawImage(...args) { draws.push(args); },
    beginPath() { path = []; }, closePath() { path.push(["close"]); },
    moveTo(...args) { path.push(["move", ...args]); }, lineTo(...args) { path.push(["line", ...args]); },
    quadraticCurveTo(...args) { path.push(["quadratic", ...args]); }, bezierCurveTo(...args) { path.push(["bezier", ...args]); },
    ellipse(...args) { path.push(["ellipse", ...args]); },
    translate(...args) { operations.push(["translate", ...args]); },
    scale(...args) { operations.push(["scale", ...args]); }, rotate(...args) { operations.push(["rotate", ...args]); },
    stroke() { paints.push({ kind: "stroke", path: path.slice(), alpha: this.globalAlpha, colour: this.strokeStyle, clips: clips.length }); },
    fill() { paints.push({ kind: "fill", path: path.slice(), alpha: this.globalAlpha, colour: this.fillStyle, clips: clips.length }); },
    paints: point => clips.every(({ path, rule }) => path.contains(point, rule)),
  };
}

test("surface clips the union of reversed overlapping Water polygons and every exclusion exactly", () => browser(() => {
  const ctx = context(); drawForestWaterDynamics(ctx, scene(), state(), { dusk: 0 });
  assert.equal(ctx.draws.length, 1);
  for (const point of [{ x: 10, y: 10 }, { x: 92, y: 50 }, { x: 55, y: 55 }]) {
    assert.equal(ctx.paints(point), true, `water at ${JSON.stringify(point)}`);
  }
  for (const point of [{ x: 2, y: 50 }, { x: 50, y: 98 }, { x: 25, y: 25 },
    { x: 35, y: 35 }, { x: 45, y: 45 }, { x: 85.04, y: 60.02 }]) {
    assert.equal(ctx.paints(point), false, `dry at ${JSON.stringify(point)}`);
  }
  assert.equal(ctx.paints({ x: 85.04, y: 60.06 }), true, "the tiny exclusion does not erase its neighbours");
  assert.equal(ctx.imageSmoothingEnabled, false, "drawing restores caller settings");
}));

test("both views share one bounded texture, drawing is pure, and a new solver revision refreshes it", () => browser(metrics => {
  const world = scene(), water = state(), before = water.heights.slice();
  drawForestWaterDynamics(context(), world, water, { dusk: 0 });
  drawForestWaterDynamics(context({ a: 2, b: 0, c: 0, d: 2, e: -40, f: -40 }), world, water, { dusk: 0 });
  assert.deepEqual(metrics.allocations, [[20, 20]]);
  assert.equal(metrics.updates.length, 1);
  assert.deepEqual(water.heights, before); assert.equal(water.revision, 10); assert.equal(water.elapsed, 8);
  assert.ok(metrics.updates[0].some((value, index) => index % 4 === 3 && value > 0), "simulated slopes are visible");
  assert.ok(metrics.updates[0].every((value, index) => index % 4 !== 3 || value <= 77), "the artwork stays visible through the surface");
  water.revision++; water.elapsed += .03;
  drawForestWaterDynamics(context(), world, water, { dusk: 0 });
  assert.equal(metrics.updates.length, 2);
  drawForestWaterDynamics(context(), world, water, { dusk: 1 });
  assert.equal(metrics.updates.length, 3);
  assert.notDeepEqual(metrics.updates[1], metrics.updates[2], "night has quieter, cooler surface light");
}));

test("offscreen and reduced-motion views do not allocate or paint a dynamics surface", () => browser(metrics => {
  const world = scene(), water = state(), hidden = context({ a: 1, b: 0, c: 0, d: 1, e: -1000, f: -1000 });
  drawForestWaterDynamics(hidden, world, water, { dusk: 0 });
  const reduced = context(); drawForestWaterDynamics(reduced, world, water, { dusk: 0, reducedMotion: true });
  assert.deepEqual(metrics.allocations, []); assert.deepEqual(metrics.updates, []);
  assert.deepEqual(hidden.draws, []); assert.deepEqual(reduced.draws, []);
}));

test("module and painter remain safe without browser canvas or Path2D", () => {
  assert.equal(typeof globalThis.Path2D, "undefined");
  const ctx = context(); drawForestWaterDynamics(ctx, scene(), state(), { dusk: 0 });
  assert.deepEqual(ctx.draws, []);
});

test("a touch has a brief depression and droplets, then fading crests shared by both cameras", () => browser(() => {
  const world = { width: 100, height: 100, water: { surfaces: [polygon(rectangle(0, 0, 100, 100))], exclusions: [] } };
  const water = state(); water.geometry = createDynamicsGeometry(world);
  water.touches = [{ id: 2, x: 50, y: 50, startedAt: 8, strength: 1 }];
  const paint = age => {
    water.elapsed = 8 + age;
    const before = structuredClone(water), first = context(), second = context();
    drawForestWaterDynamics(first, world, water, { dusk: 0 });
    drawForestWaterDynamics(second, world, water, { dusk: 0 });
    assert.deepEqual(first.vectorPaints, second.vectorPaints, "both cameras see the same impact phase");
    assert.deepEqual(water, before, "paint cannot consume or age a touch");
    assert.ok(first.vectorPaints.every(paint => paint.clips > 0), "every splash part is inside the exact water clip");
    assert.equal(first.globalAlpha, 1, "caller opacity is restored");
    return first.vectorPaints;
  };
  const contact = paint(.055), spreading = paint(.32), late = paint(.9);
  assert.ok(contact.some(paint => paint.kind === "fill" && paint.colour === "#205c68"), "contact visibly depresses the surface");
  assert.ok(contact.filter(paint => paint.kind === "fill").length >= 5, "contact has separate droplets");
  assert.ok(spreading.some(paint => paint.kind === "stroke" && paint.alpha > .25), "the ripple remains readable after the initial impact");
  assert.ok(late.every(paint => paint.kind === "stroke"), "only calm crests survive the splash");
  assert.ok(Math.max(...late.map(paint => paint.alpha)) < Math.max(...spreading.map(paint => paint.alpha)), "crests fade");
  assert.deepEqual(paint(1.21), [], "expired touches are invisible even before the next solver update");
  assert.deepEqual(paint(-.01), [], "future timestamps do not flash");
}));

test("touch crests cannot reappear across a thin strip of dry land", () => browser(() => {
  const world = { width: 100, height: 100, water: { surfaces: [polygon(rectangle(0, 0, 100, 100))],
    exclusions: [polygon(rectangle(43, 0, 5, 100))] } };
  const water = state(); water.geometry = createDynamicsGeometry(world); water.elapsed = 8.8;
  water.touches = [{ id: 0, x: 30, y: 50, startedAt: 8, strength: 1 }];
  const ctx = context(); drawForestWaterDynamics(ctx, world, water, { dusk: 0 });
  const arcs = ctx.vectorPaints.flatMap(paint => paint.path.filter(part => part[0] === "ellipse"));
  assert.ok(arcs.length > 0);
  for (const [, x, , radius, , , start, end] of arcs) {
    assert.ok(x + radius * Math.cos((start + end) / 2) < 43, "no far-bank highlight can jump through the land");
  }
  assert.equal(ctx.paints({ x: 45, y: 50 }), false);
}));

test("leaf artwork follows physical lift and submersion without changing physics or caller opacity", () => browser(() => {
  const world = scene(), water = state();
  const leaf = { id: 0, x: 65, y: 65, size: 3, rotation: .8, opacity: .8, shape: 1,
    vx: 0, vy: 0, angularVelocity: 0, bob: 1.1, submersion: 0, submersionVelocity: 0 };
  water.leaves = [leaf];
  const before = structuredClone(water), floating = context();
  drawForestWaterDynamics(floating, world, water, { dusk: .3 });
  assert.deepEqual(water, before);
  assert.ok(floating.operations.some(([kind, x, y]) => kind === "translate" && x === leaf.x && y === leaf.y - leaf.bob), "wave height lifts the visible blade");
  assert.ok(floating.vectorPaints.some(paint => paint.path.filter(part => part[0] === "quadratic").length >= 6), "veins and a curved stem are present");
  assert.ok(floating.clips.length > 0 && floating.vectorPaints.every(paint => paint.clips === floating.clips.length),
    "leaf, veins and shadow share the complete shoreline and exclusion mask");
  assert.equal(floating.globalAlpha, 1);
  leaf.submersion = .8;
  const dipped = context(); drawForestWaterDynamics(dipped, world, water, { dusk: .3 });
  assert.ok(Math.max(...dipped.vectorPaints.map(paint => paint.alpha)) < Math.max(...floating.vectorPaints.map(paint => paint.alpha)), "water veils a submerged leaf");
  assert.ok(dipped.operations.some(([kind, x, y]) => kind === "translate" && x === leaf.x && y > leaf.y - leaf.bob), "submersion lowers the blade");
}));

test("replacing authored Water on a scene invalidates its exact render mask", () => browser(() => {
  const world = scene(), water = state(), before = context();
  drawForestWaterDynamics(before, world, water, { dusk: 0 });
  assert.equal(before.paints({ x: 55, y: 55 }), true);
  world.water = { ...world.water, exclusions: [...world.water.exclusions, polygon(rectangle(52, 52, 6, 6))] };
  const after = context(); drawForestWaterDynamics(after, world, water, { dusk: 0 });
  assert.equal(after.paints({ x: 55, y: 55 }), false);
}));
