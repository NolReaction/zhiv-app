import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
after(() => vite.close());
const { fishingWaterWave, fishingBoatMotion, createFishingBoatInertia, advanceFishingBoatInertia,
  disturbFishingBoat, fishingBoatInertiaMotion } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-buoyancy.ts");
const { fishingSceneGeometry } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-painter.ts");
const zero = { bob: 0, roll: 0, surge: 0 };

function run(rate) {
  const state = createFishingBoatInertia();
  advanceFishingBoatInertia(state, 0, { time: 0 });
  for (let tick = 1; tick <= rate * 12; tick++) {
    if (tick - 1 === rate * 2) disturbFishingBoat(state, "cast");
    if (tick - 1 === rate * 5) disturbFishingBoat(state, "bite");
    advanceFishingBoatInertia(state, 1 / rate, { time: tick / rate,
      effort: tick - 1 >= rate * 7 && tick - 1 < rate * 9 ? 1 : 0 });
  }
  return fishingBoatInertiaMotion(state);
}

test("the shared wave sampler has a consistent slope, finite bounded output and a static accessibility pose", () => {
  for (const time of [0, .2, 3.7, 20, 99999]) for (const x of [0, 170, 500, 1000, 1800]) {
    const wave = fishingWaterWave(x, time);
    const derivative = (fishingWaterWave(x + .01, time).height - fishingWaterWave(x - .01, time).height) / .02;
    assert.ok(Math.abs(wave.slope - derivative) < 1e-7);
    assert.ok(Math.abs(wave.height) <= 11.9 && Math.abs(wave.drift) <= 3.6);
    assert.ok(Object.values(wave).every(Number.isFinite));
    assert.deepEqual(fishingWaterWave(x, time, true), { height: 0, slope: 0, drift: 0 });
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(fishingWaterWave(value, 1), { height: 0, slope: 0, drift: 0 });
    assert.deepEqual(fishingWaterWave(500, value), { height: 0, slope: 0, drift: 0 });
    assert.deepEqual(fishingBoatMotion(value, false), zero);
  }
  const time = 3.5, center = 700, span = 440;
  const left = fishingWaterWave(center - span / 2, time), right = fishingWaterWave(center + span / 2, time);
  const boat = fishingBoatMotion(time, false, center, span);
  assert.equal(boat.bob, (left.height + right.height) / 2);
  assert.equal(boat.surge, (left.drift + right.drift) / 2);
  assert.equal(boat.roll, Math.atan2(right.height - left.height, span) * .7);
});

test("buoyancy follows the same physical duration at 15/30/60/120 Hz including action impulses and held effort", () => {
  const reference = run(120);
  for (const rate of [15, 30, 60]) {
    const result = run(rate);
    assert.ok(Math.abs(result.bob - reference.bob) < .03, `${rate} Hz heave remains time based`);
    assert.ok(Math.abs(result.roll - reference.roll) < .00015, `${rate} Hz roll remains time based`);
    assert.ok(Math.abs(result.surge - reference.surge) < .02, `${rate} Hz surge remains time based`);
  }
});

test("an action changes velocity first, then overshoots gently and dissipates without snapping the hull", () => {
  const state = createFishingBoatInertia();
  const equilibrium = advanceFishingBoatInertia(state, 0, { time: 0 });
  disturbFishingBoat(state, "cast");
  assert.deepEqual(fishingBoatInertiaMotion(state), equilibrium, "an impulse cannot teleport the current transform");
  const samples = [];
  for (let tick = 0; tick < 600; tick++) samples.push(advanceFishingBoatInertia(state, 1 / 120, { time: 0 }));
  const heaves = samples.map(sample => sample.bob - equilibrium.bob);
  assert.ok(Math.max(...heaves) > .5 && Math.max(...heaves) < 3);
  assert.ok(Math.min(...heaves) < -.005, "a little inertia carries the hull through equilibrium");
  assert.ok(Math.abs(heaves.at(-1)) < .003, "the impulse settles instead of creating a permanent extra oscillation");
  assert.ok(Math.abs(samples.at(-1).roll - equilibrium.roll) < .00005);
  assert.ok(Math.abs(samples.at(-1).surge - equilibrium.surge) < .005);
  for (let index = 1; index < samples.length; index++) {
    assert.ok(Math.abs(samples[index].bob - samples[index - 1].bob) < .06);
    assert.ok(Math.abs(samples[index].roll - samples[index - 1].roll) < .0005);
  }
});

test("held effort eases into a small load offset and relaxes again while visual clocks can stay frozen", () => {
  const state = createFishingBoatInertia();
  const equilibrium = advanceFishingBoatInertia(state, 0, { time: 0 });
  const first = advanceFishingBoatInertia(state, 1 / 30, { time: 0, effort: 1 });
  assert.ok(first.bob > equilibrium.bob && first.bob < equilibrium.bob + .1);
  assert.ok(first.roll > equilibrium.roll && first.roll < equilibrium.roll + .0005);
  for (let tick = 0; tick < 150; tick++) advanceFishingBoatInertia(state, 1 / 30, { time: 0, effort: 1 });
  const loaded = fishingBoatInertiaMotion(state);
  assert.ok(Math.abs(loaded.bob - equilibrium.bob - 1.1) < .002);
  assert.ok(Math.abs(loaded.roll - equilibrium.roll - .0045) < .00005);
  assert.ok(Math.abs(loaded.surge - equilibrium.surge - 1.8) < .005);
  for (let tick = 0; tick < 180; tick++) advanceFishingBoatInertia(state, 1 / 30, { time: 0, effort: 0 });
  const released = fishingBoatInertiaMotion(state);
  assert.ok(Math.abs(released.bob - equilibrium.bob) < .002);
  assert.ok(Math.abs(released.surge - equilibrium.surge) < .002);
});

test("zero or invalid duration and reduced motion preserve the stored state, while repeated kicks remain bounded", () => {
  const state = createFishingBoatInertia();
  advanceFishingBoatInertia(state, 0, { time: 0 });
  disturbFishingBoat(state, "bite");
  const before = structuredClone(state);
  for (const duration of [0, -3, NaN, Infinity]) {
    advanceFishingBoatInertia(state, duration, { time: 1000, effort: 1 });
    assert.deepEqual(state, before, "stopping a visual clock cannot catch up hidden seconds");
  }
  assert.deepEqual(advanceFishingBoatInertia(state, .1, { time: 1000, still: true }), zero);
  assert.deepEqual(state, before, "reduced motion does not leave hidden physical movement running");
  for (let tick = 0; tick < 200; tick++) {
    disturbFishingBoat(state, tick % 2 ? "cast" : "bite");
    const motion = advanceFishingBoatInertia(state, 4, { time: tick / 10, effort: 100 });
    assert.ok(Math.abs(motion.bob) <= 14 && Math.abs(motion.roll) <= .045 && Math.abs(motion.surge) <= 9);
    assert.ok(Object.values(motion).every(Number.isFinite));
  }
});

test("the complete authored rig accepts one inertial transform without changing public fishing inputs", () => {
  const frame = { stage: "reeling", held: true, castKey: "one", sceneKey: "voyage", boat: { repaired: true, upgrades: [] },
    reel: { bar: 4000, fish: 5000, progress: 3000, zoneWidth: 2000 } };
  const before = structuredClone(frame), visual = { elapsed: 4, castElapsed: 4, stageElapsed: 4, still: false };
  for (const [width, height] of [[320, 568], [390, 844], [820, 390], [1600, 900]]) {
    const base = fishingSceneGeometry(width, height, frame, { ...visual, boatMotion: zero });
    const moved = fishingSceneGeometry(width, height, frame, { ...visual, boatMotion: { bob: 2, surge: 3, roll: .012 } });
    assert.ok(Math.abs(moved.boat.x - base.boat.x - 3) < 1e-8);
    assert.ok(Math.abs(moved.boat.y - base.boat.y - 2) < 1e-8);
    assert.ok(Math.abs(moved.boat.roll - base.boat.roll - .012) < 1e-8);
    assert.deepEqual(moved.grip, moved.onBoat(moved.actorRig.nearArm.hand));
    const still = fishingSceneGeometry(width, height, frame, { ...visual, still: true, boatMotion: { bob: 14, surge: 9, roll: .045 } });
    const resting = fishingSceneGeometry(width, height, frame, { ...visual, still: true, boatMotion: zero });
    assert.deepEqual(still.boat, resting.boat, "accessibility ignores every periodic inertial offset");
  }
  assert.deepEqual(frame, before);
});
