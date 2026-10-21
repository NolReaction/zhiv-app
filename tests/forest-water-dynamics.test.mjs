import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestWaterDynamics: create, advanceForestWaterDynamics: advance,
  disturbForestWater: disturb, touchForestWater: touch, sampleForestWater: sample,
  createForestWaterPointSampler: pointSampler, WATER_DYNAMICS_LIMITS: limits } =
  await vite.ssrLoadModule("/features/world/environment/water/forest-water-dynamics.ts");
const { dynamicsFootprintFits, containsDynamicsWater } = await vite.ssrLoadModule("/features/world/environment/water/water-dynamics-geometry.ts");
const actual = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url)));
const rectangle = (x, y, width, height) => ({ id: `${x}:${y}`, points: [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
] });
const scene = (surfaces = [rectangle(0, 0, 240, 240)], exclusions = []) => ({ width: 1254, height: 1254, water: { surfaces, exclusions } });
const calm = { rain: 0, wind: 0 };
const run = (state, seconds, options = calm, dt = 1 / 60) => {
  for (let index = 0; index < Math.round(seconds / dt); index++) advance(state, dt, options);
};
const amplitude = state => state.heights.reduce((value, height) => value + height * height, 0);
const pointAt = (state, index) => ({ x: state.origin.x + (index % state.columns + .5) * state.cellSize,
  y: state.origin.y + (Math.floor(index / state.columns) + .5) * state.cellSize });

test("a touch propagates beyond its footprint, reflects at shores and decays in calm water", () => {
  const state = create(scene());
  assert.equal(disturb(state, { x: 70, y: 110 }), true);
  assert.equal(sample(state, { x: 112, y: 110 }).height, 0);
  run(state, 1.1);
  assert.ok(Math.abs(sample(state, { x: 112, y: 110 }).height) > .0001, "wave travels beyond touch radius");
  assert.ok(state.active.some(index => state.neighbours[index * 4] === index), "shore uses reflective no-flux neighbour");
  const early = amplitude(state);
  run(state, 18);
  assert.ok(amplitude(state) < early * .01, "energy dissipates instead of leaving an endless disturbance");
  assert.ok(state.heights.every(Number.isFinite));
  assert.ok(state.heights.every((value, index) => state.mask[index] || value === 0));
});

test("opposite waves superpose and can cancel rather than existing as independent decorative rings", () => {
  const a = create(scene()), b = create(scene()), combined = create(scene());
  const first = { x: 82, y: 114 }, second = { x: 148, y: 114 };
  disturb(a, first, { strength: .6 }); disturb(b, second, { strength: -.6 });
  disturb(combined, first, { strength: .6 }); disturb(combined, second, { strength: -.6 });
  run(a, 1); run(b, 1); run(combined, 1);
  assert.ok(combined.heights.every((value, index) => Math.abs(value - a.heights[index] - b.heights[index]) < .000001));
  const zero = create(scene());
  disturb(zero, first, { strength: .6 }); disturb(zero, first, { strength: -.6 });
  run(zero, .5);
  assert.ok(amplitude(zero) < 1e-12);
});

test("union and exclusions respect winding, overlapping polygons and tiny barriers between grid centres", () => {
  const lower = rectangle(0, 0, 120, 160), upper = rectangle(80, 0, 120, 160);
  upper.points.reverse();
  const world = scene([lower, upper], [rectangle(62, 0, .2, 160), rectangle(135, 30, 18, 35), rectangle(142, 40, 20, 35)]);
  const state = create(world);
  for (const index of state.active) assert.ok(containsDynamicsWater(state.geometry, pointAt(state, index)));
  assert.equal(disturb(state, { x: 62.1, y: 80 }), false);
  assert.equal(disturb(state, { x: 150, y: 50 }), false);
  disturb(state, { x: 52, y: 80 }, { radius: 24 });
  run(state, 4);
  const across = [...state.active].filter(index => pointAt(state, index).x > 62.2);
  assert.ok(across.every(index => state.heights[index] === 0), "sub-grid barrier blocks impulse and later propagation");
});

test("disconnected ponds never exchange waves, including a wide touch spanning both", () => {
  const state = create(scene([rectangle(0, 0, 80, 120), rectangle(90, 0, 80, 120)]));
  disturb(state, { x: 72, y: 62 }, { radius: 48 }); run(state, 4);
  assert.ok([...state.active].filter(index => pointAt(state, index).x >= 90).every(index => state.heights[index] === 0));
  assert.ok(amplitude(state) > 0);
});

test("overlapping and touching water polygons transmit waves through their internal authored edges", () => {
  for (const right of [80, 120]) {
    const first = rectangle(0, 0, 120, 160), second = rectangle(right, 0, 120, 160);
    second.points.reverse();
    const state = create(scene([first, second]));
    disturb(state, { x: 66, y: 78 }); run(state, 2);
    assert.ok(Math.abs(sample(state, { x: 140, y: 78 }).height) > .00001, "the union does not introduce invisible walls");
    assert.ok(dynamicsFootprintFits(state.geometry, { x: right, y: 78 }, 5), "floating leaves can cross internal polygon seams");
  }
});

test("fixed steps give identical results at 30, 60 and 120 fps with deterministic weather and leaves", () => {
  const states = [create(actual), create(actual), create(actual)];
  for (const state of states) disturb(state, pointAt(state, state.active[Math.floor(state.active.length / 2)]));
  for (let i = 0; i < states.length; i++) run(states[i], 2, { rain: .8, wind: .7 }, 1 / [30, 60, 120][i]);
  for (const state of states.slice(1)) {
    assert.deepEqual(state.heights, states[0].heights); assert.deepEqual(state.velocities, states[0].velocities);
    assert.deepEqual(state.leaves, states[0].leaves); assert.equal(state.elapsed, states[0].elapsed);
  }
});

test("calm water stays flat, rain and wind each create bounded physical disturbances", () => {
  const flat = create(scene()); run(flat, 3);
  assert.equal(amplitude(flat), 0);
  for (const weather of [{ rain: 1, wind: 0 }, { rain: 0, wind: 1 }, { rain: 1, wind: 1 }]) {
    const state = create(scene()); run(state, 12, weather);
    assert.ok(amplitude(state) > 0);
    assert.ok(state.heights.every(value => Number.isFinite(value) && Math.abs(value) <= 4));
    assert.ok(state.velocities.every(value => Number.isFinite(value) && Math.abs(value) <= 32));
  }
});

test("reduced motion freezes the surface and leaves; bad and suspended frame times add no backlog", () => {
  const state = create(scene()); disturb(state, { x: 122, y: 122 }); advance(state, 1 / 120, calm);
  const frozen = structuredClone(state);
  advance(state, 20, { rain: 1, wind: 1, reducedMotion: true });
  assert.deepEqual(state.heights, frozen.heights); assert.deepEqual(state.leaves, frozen.leaves);
  assert.equal(state.elapsed, 0); assert.equal(state.accumulator, 0);
  for (const dt of [NaN, Infinity, -1, 0]) advance(state, dt, calm);
  assert.equal(state.elapsed, 0);
  advance(state, 3600, calm);
  assert.ok(state.elapsed <= limits.fixedStep * limits.catchUpSteps + 1e-9);
  advance(state, 1 / 60, calm);
  assert.ok(state.elapsed <= limits.fixedStep * (limits.catchUpSteps + 1) + 1e-9);
});

test("new floating leaves drift and rotate while their complete footprints avoid authored land", () => {
  const state = create(actual), initial = structuredClone(state.leaves);
  assert.ok(state.leaves.length > 0 && state.leaves.length <= limits.leaves);
  for (let tick = 0; tick < 900; tick++) {
    advance(state, 1 / 30, { rain: .7, wind: .6 });
    for (const leaf of state.leaves) assert.ok(dynamicsFootprintFits(state.geometry, leaf, leaf.size + .6 * state.scale));
  }
  assert.ok(state.leaves.some((leaf, index) => Math.hypot(leaf.x - initial[index].x, leaf.y - initial[index].y) > 10));
  assert.ok(state.leaves.some((leaf, index) => Math.abs(leaf.rotation - initial[index].rotation) > .1));
});

test("maps with no water and extremely long maps have bounded arrays; simulation mutates no shared geometry", () => {
  const empty = create({ width: 1254, height: 1254 }); advance(empty, 1, { rain: 1, wind: 1 });
  assert.equal(empty.heights.length, 0); assert.equal(disturb(empty, { x: 0, y: 0 }), false);
  assert.deepEqual(sample(empty, { x: 0, y: 0 }), { height: 0, slopeX: 0, slopeY: 0, flowX: 0, flowY: 0 });
  const huge = create(scene([rectangle(0, 0, 125400, 1254)]));
  assert.ok(huge.columns <= limits.side && huge.rows <= limits.side);
  assert.ok(huge.heights.length <= limits.side ** 2);
  const first = create(actual), second = create(actual), mask = first.mask.slice(), neighbours = first.neighbours.slice();
  const arrays = [first.heights, first.velocities, first.flowX, first.flowY];
  disturb(first, pointAt(first, first.active[100])); run(first, .25, { rain: 1, wind: 1 });
  assert.equal(amplitude(second), 0); assert.deepEqual(first.mask, mask); assert.deepEqual(first.neighbours, neighbours);
  assert.deepEqual(arrays, [first.heights, first.velocities, first.flowX, first.flowY]);
});

test("sampling is read-only, returns finite height/slope/current and rejects dry or invalid coordinates", () => {
  const state = create(scene()); disturb(state, { x: 100, y: 100 }); run(state, .2);
  const before = structuredClone(state), wet = sample(state, { x: 102, y: 100 });
  assert.ok(Object.values(wet).every(Number.isFinite));
  assert.ok(Math.abs(wet.height) > .001); assert.ok(Math.hypot(wet.flowX, wet.flowY) > 0);
  for (const point of [{ x: -100, y: -100 }, { x: NaN, y: 20 }, { x: 20, y: Infinity }]) {
    assert.equal(disturb(state, point), false); assert.equal(sample(state, point).height, 0);
  }
  assert.deepEqual(state, before);
});

const soloLeaf = (state, point = { x: 100, y: 100 }) => {
  const leaf = { ...state.leaves[0], ...point, size: 3, vx: 0, vy: 0, angularVelocity: 0, rotation: 0 };
  state.leaves = [leaf]; state.flowX.fill(0); state.flowY.fill(0); return leaf;
};

test("player touches depress water and keep a bounded visual history on active simulation time", () => {
  const state = create(scene()), point = { x: 102, y: 102 };
  assert.equal(touch(state, point), true);
  assert.ok(sample(state, point).height < -.8, "initial contact presses into the water");
  assert.deepEqual(state.touches[0], { id: 1, ...point, startedAt: 0, strength: 1 });
  disturb(state, point); assert.equal(state.touches.length, 1, "weather and fishing do not add tap crowns");
  for (let index = 0; index < 50; index++) touch(state, point);
  assert.equal(state.touches.length, 12); assert.equal(state.touchSequence, 51);
  assert.equal(new Set(state.touches.map(contact => contact.id)).size, 12);
  const frozen = structuredClone(state);
  advance(state, 120, { ...calm, reducedMotion: true });
  assert.deepEqual(state, frozen, "reduced motion freezes contact ages and submerged leaves too");
  run(state, 1.3); assert.equal(state.touches.length, 0);
  const after = structuredClone(state);
  for (const point of [{ x: -1, y: 10 }, { x: NaN, y: 10 }, { x: 10, y: Infinity }]) assert.equal(touch(state, point), false);
  assert.deepEqual(state, after);
});

test("nearby touches impart bounded inertia while direct leaf hits sink and resurface with one ripple", () => {
  const state = create(scene()), leaf = soloLeaf(state);
  touch(state, { x: 85, y: 100 });
  assert.ok(leaf.vx > 3); assert.equal(leaf.submersion, 0);
  run(state, .2); assert.ok(leaf.x > 100.4, "momentum continues after the input call");
  touch(state, leaf);
  assert.ok(leaf.submersion > 0); assert.ok(leaf.submersionVelocity > 0);
  let resurfaced = 0, maximumDepth = 0;
  for (let tick = 0; tick < 90; tick++) {
    const previous = leaf.submersion;
    state.heights.fill(0); state.velocities.fill(0);
    advance(state, 1 / 60, calm);
    maximumDepth = Math.max(maximumDepth, leaf.submersion);
    if (previous > 0 && leaf.submersion === 0) { resurfaced++; assert.ok(amplitude(state) > 0); }
    else assert.equal(amplitude(state), 0, "no repeated automatic ripple while the leaf is already afloat");
    assert.ok(Math.hypot(leaf.vx, leaf.vy) <= 18 + 1e-8);
  }
  assert.ok(maximumDepth > .3 && maximumDepth < 1);
  assert.equal(resurfaced, 1); assert.equal(leaf.submersionVelocity, 0);
  assert.doesNotThrow(() => structuredClone(state));
});

test("surface slope and wind alter leaf motion, and wave height drives finite bobbing", () => {
  const flat = create(scene()), tilted = create(scene()), windy = create(scene());
  soloLeaf(flat); soloLeaf(tilted); soloLeaf(windy);
  for (const index of tilted.active) tilted.heights[index] = (pointAt(tilted, index).x - 60) * .012;
  advance(flat, 1 / 60, calm); advance(tilted, 1 / 60, calm); advance(windy, 1 / 60, { rain: 0, wind: 1 });
  assert.ok(tilted.leaves[0].vx < flat.leaves[0].vx, "slope accelerates a floating leaf down the wave");
  assert.ok(tilted.leaves[0].bob > 0, "height raises the leaf for the painter");
  assert.ok(windy.leaves[0].vx > flat.leaves[0].vx, "wind adds a drift independently of artistic current");
  assert.ok(Object.values(tilted.leaves[0]).every(Number.isFinite));
});

test("overlapping leaves separate softly instead of passing through one another", () => {
  const state = create(scene()), first = soloLeaf(state);
  const second = { ...first, id: first.id + 1, x: first.x + 3 };
  state.leaves.push(second);
  run(state, .6);
  assert.ok(Math.hypot(first.x - second.x, first.y - second.y) > 4.8);
  for (const leaf of state.leaves) {
    assert.ok(Math.hypot(leaf.vx, leaf.vy) < 18);
    assert.ok(dynamicsFootprintFits(state.geometry, leaf, leaf.size + .6 * state.scale));
  }
});

test("tap forces and moving leaf footprints cannot cross a sub-grid island or separate ponds", () => {
  const state = create(scene(undefined, [rectangle(120, 0, .2, 240)]));
  const leaf = soloLeaf(state, { x: 116.1, y: 100 });
  const before = structuredClone(leaf);
  touch(state, { x: 126, y: 100 });
  assert.deepEqual(leaf, before, "a touch on the other bank cannot push or submerge this leaf");
  leaf.vx = 18;
  for (let tick = 0; tick < 300; tick++) {
    advance(state, 1 / 60, { rain: 0, wind: 1 });
    assert.ok(leaf.x < 116.4, "the full leaf stays on its original side");
    assert.ok(dynamicsFootprintFits(state.geometry, leaf, leaf.size + .6 * state.scale));
  }
});

test("cached fixed-point sampling matches checked water samples across live waves and independent sessions", () => {
  const state = create(actual), other = create(actual);
  const stride = Math.max(4, Math.ceil(Math.max(state.columns, state.rows) / 48));
  const size = state.cellSize * stride, radius = size * Math.SQRT1_2 + 1.5 * state.scale;
  const probes = [];
  for (let row = 0; row < state.rows; row += stride) for (let column = 0; column < state.columns; column += stride) {
    const point = { x: state.origin.x + column * state.cellSize + size / 2,
      y: state.origin.y + row * state.cellSize + size / 2 };
    if (dynamicsFootprintFits(state.geometry, point, radius)) probes.push({ point, read: pointSampler(state.geometry, point) });
  }
  assert.ok(probes.length > 250, "cover both river arms using the refraction's certified centers");
  disturb(state, probes[0].point, { strength: 2 });
  disturb(other, probes.at(-1).point, { strength: -2 });
  for (let phase = 0; phase < 5; phase++) {
    run(state, .2, { rain: .5, wind: .6 });
    run(other, .2, { rain: 0, wind: .2 });
    for (const { point, read } of probes) {
      assert.deepEqual(read(state), sample(state, point));
      assert.deepEqual(read(other), sample(other, point), "shared geometry never caches another session's wave values");
    }
  }
});

test("cached point samplers retain exact boundaries, tiny exclusions, and checked replacement geometry", () => {
  const world = scene([rectangle(0, 0, 240, 240)], [rectangle(111.1, 70, .2, 100)]);
  const state = create(world), changed = create(scene([rectangle(0, 0, 240, 240)], [rectangle(50, 50, 50, 50)]));
  for (const point of [{ x: 0, y: 120 }, { x: 240, y: 120 }, { x: -.000001, y: 120 },
    { x: 111.1, y: 100 }, { x: 111.2, y: 100 }, { x: 111.3, y: 100 },
    { x: 111.09, y: 100 }, { x: 111.31, y: 100 }, { x: 70, y: 70 },
    { x: NaN, y: 100 }, { x: Infinity, y: 100 }]) {
    const read = pointSampler(state.geometry, point);
    assert.deepEqual(read(state), sample(state, point));
    assert.deepEqual(read(changed), sample(changed, point), "new shoreline rechecks the saved world point");
  }
  const anchor = { x: 70, y: 70 }, fixed = pointSampler(state.geometry, anchor);
  anchor.x = 111.2;
  disturb(state, { x: 70, y: 70 });
  assert.deepEqual(fixed(state), sample(state, { x: 70, y: 70 }), "external mutation cannot move the fixed painter point");
  assert.equal(fixed(changed).height, 0, "a formerly wet anchor becomes dry after geometry replacement");
});

test("a certified fixed point skips repeated polygon membership without weakening ordinary samples", () => {
  const state = create(scene()), geometry = state.geometry, surfaces = geometry.surfaces;
  let reads = 0;
  Object.defineProperty(geometry, "surfaces", { configurable: true, get() { reads++; return surfaces; } });
  try {
    const point = { x: 70, y: 110 }, read = pointSampler(geometry, point);
    assert.ok(reads > 0, "certify exact water membership once");
    reads = 0;
    for (let frame = 0; frame < 100; frame++) read(state);
    assert.equal(reads, 0, "fixed draws read current grid arrays without polygon walks");
    sample(state, point);
    assert.ok(reads > 0, "the public arbitrary-point sampler still checks exact water geometry");
  } finally { Object.defineProperty(geometry, "surfaces", { configurable: true, writable: true, value: surfaces }); }
});
