import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createAudioParameterSmoother } = await vite.ssrLoadModule("/features/audio/runtime/audio-parameter-smoother.ts");

// A browser owns the rendered envelope. Reading .value or manually anchoring a
// value would use a stale/rounded main-thread sample, so this fixture rejects it.
function parameter(clock) {
  let start = 0, from = 0, target = 0, tau = 1;
  const events = [];
  const valueAt = time => target + (from - target) * Math.exp(-Math.max(0, time - start) / tau);
  return {
    events, valueAt,
    get value() { throw new Error("continuous retargeting cannot read a stale parameter value"); },
    cancelScheduledValues() { throw new Error("continuous retargeting cannot cancel the live envelope"); },
    linearRampToValueAtTime() { throw new Error("continuous retargeting cannot rebuild a linear endpoint"); },
    setValueAtTime() { throw new Error("continuous retargeting cannot manually reanchor the envelope"); },
    setTargetAtTime(next, when, timeConstant) {
      const time = Math.max(clock.actual, when);
      from = valueAt(time); start = time; target = next; tau = timeConstant;
      events.push({ target, time, tau, from });
    },
  };
}

test("rapid camera and flame changes retain continuous gain with a coarse browser clock", () => {
  for (const precision of [.001, .1]) {
    const clock = { actual: 0, get currentTime() { return Math.floor(this.actual / precision) * precision; } };
    const smoother = createAudioParameterSmoother(clock), gain = parameter(clock);
    smoother.smooth(gain, .6, 1.1 / 3);
    for (let index = 1; index <= 480; index++) {
      clock.actual = index / 120;
      const before = gain.valueAt(clock.actual);
      smoother.smooth(gain, .6 + .3 * Math.sin(clock.actual * 3) + .03 * Math.sin(clock.actual * 47), 1.1 / 3);
      assert.ok(Math.abs(gain.valueAt(clock.actual) - before) < 1e-12, "each drag frame continues from the rendered value");
    }
    assert.ok(gain.events.length > 450);
    assert.ok(gain.valueAt(clock.actual) > .2 && gain.valueAt(clock.actual) < 1);
  }
});

test("unchanged targets finish their envelope and independent parameters keep independent targets", () => {
  const clock = { actual: 0, currentTime: 0 }, smoother = createAudioParameterSmoother(clock);
  const gain = parameter(clock), pan = parameter(clock);
  assert.equal(smoother.has(gain), false);
  smoother.smooth(gain, .6, .3); smoother.smooth(pan, -.4, .03);
  for (let index = 1; index <= 360; index++) {
    clock.actual = clock.currentTime = index / 120;
    smoother.smooth(gain, .6, .3); smoother.smooth(pan, -.4, .03);
  }
  assert.equal(smoother.has(gain), true);
  assert.equal(gain.events.length, 1); assert.equal(pan.events.length, 1);
  assert.ok(Math.abs(gain.valueAt(3) - .6) < .00003);
  assert.equal(pan.valueAt(3), -.4);
});

test("proximity release becomes inaudible before cleanup and a returning camera can reclaim its envelope", () => {
  const clock = { actual: 0, currentTime: 0 }, smoother = createAudioParameterSmoother(clock), gain = parameter(clock);
  smoother.smooth(gain, 1, .1);
  clock.actual = clock.currentTime = 2;
  const beforeRelease = gain.valueAt(2);
  smoother.smooth(gain, 0, 1.1 / 8);
  assert.ok(Math.abs(gain.valueAt(2) - beforeRelease) < 1e-12);
  assert.ok(gain.valueAt(3.1) < .00034, "bounded cleanup occurs below −69 dB of the old level");
  clock.actual = clock.currentTime = 2.2;
  const beforeReturn = gain.valueAt(2.2);
  smoother.smooth(gain, .8, 1.1 / 3);
  assert.ok(Math.abs(gain.valueAt(2.2) - beforeReturn) < 1e-12);
  assert.ok(gain.valueAt(3.1) > .7, "no old release endpoint silences the reclaimed voice");
});

test("forced release can shorten an existing zero target without invalid automation", () => {
  const clock = { actual: 0, currentTime: 0 }, smoother = createAudioParameterSmoother(clock), gain = parameter(clock);
  for (const [target, tau] of [[NaN, .1], [Infinity, .1], [0, NaN], [0, 0], [0, -1]]) smoother.smooth(gain, target, tau);
  assert.equal(smoother.has(gain), false);
  smoother.smooth(gain, 0, .3); smoother.smooth(gain, 0, .01, true);
  assert.equal(gain.events.length, 2); assert.equal(gain.events[1].tau, .01);
  smoother.smooth(gain, .1, .0001);
  assert.equal(gain.events.at(-1).tau, .001);
  clock.currentTime = NaN; smoother.smooth(gain, .4, .1);
  assert.equal(gain.events.length, 3);
});
