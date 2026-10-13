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
  disturbForestWater: disturb, sampleForestWater: sample, WATER_DYNAMICS_LIMITS: limits } =
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
