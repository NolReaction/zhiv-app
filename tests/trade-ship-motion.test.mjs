import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TRADE_SHIP_VOYAGE: voyage, createTradeShipMotion, sampleTradeShipMotion,
  advanceTradeShipMotion, departTradeShip } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");
const near = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);

test("clockwise-tilted arrival levels continuously at the horizontal berth", () => {
  let state = createTradeShipMotion("arriving"), previous = state;
  assert.ok(state.y > 1320 && state.x > state.berth.x);
  assert.equal(state.speed, 0);
  assert.equal(state.heading, voyage.arrivalHeading);
  assert.ok(state.heading > 0, "Canvas-positive gives the incoming clockwise tilt");
  for (let i = 1; i <= 1800; i++) {
    state = sampleTradeShipMotion("arriving", i / 100);
    assert.ok(state.x <= previous.x + 1e-9 && state.y <= previous.y + 1e-9);
    assert.ok(state.heading >= 0 && state.heading <= previous.heading + 1e-9);
    assert.ok(state.speed < 60 && state.visible);
    previous = state;
  }
  assert.equal(state.phase, "docked");
  assert.equal(state.heading, 0);
  assert.equal(state.speed, 0);
  assert.equal(state.x, state.berth.x); assert.equal(state.y, state.berth.y);
  assert.equal(advanceTradeShipMotion(state, 60), state);
  const before = sampleTradeShipMotion("arriving", voyage.arrivalDuration - .001);
  near(before.x, state.x); near(before.y, state.y); near(before.heading, state.heading);
  assert.ok(before.speed < .00001);
});

test("departure first slides strictly right, then drifts slightly left/down while turning counterclockwise", () => {
  const docked = createTradeShipMotion(), departing = departTradeShip(docked);
  near(departing.x, docked.x); near(departing.y, docked.y); near(departing.heading, docked.heading);
  assert.equal(departing.speed, 0); assert.equal(departing.reverse, true);
  assert.equal(departTradeShip(departing), departing);
  let previous = departing, peakSpeed = 0;
  for (let time = .1; time <= voyage.backingDuration; time += .1) {
    const state = sampleTradeShipMotion("departing", Math.min(time, voyage.backingDuration));
    assert.ok(state.x >= previous.x);
    assert.equal(state.y, docked.y, "initial clearance is a pure horizontal translation");
    assert.equal(state.velocityY, 0);
    assert.equal(state.heading, 0, "the picture stays level during the entire rightward slide");
    peakSpeed = Math.max(peakSpeed, state.speed); previous = state;
  }
  const cleared = sampleTradeShipMotion("departing", voyage.backingDuration);
  assert.ok(cleared.x - docked.x > docked.width * .3 && cleared.x - docked.x < docked.width * .45);
  previous = cleared;
  for (let time = voyage.backingDuration + .1; time < voyage.departureDuration; time += .1) {
    const state = sampleTradeShipMotion("departing", time);
    assert.ok(state.x < previous.x && state.y > previous.y);
    assert.ok(state.velocityX < 0 && state.velocityY > 0);
    assert.ok(state.heading <= previous.heading && state.heading >= voyage.departureHeading);
    assert.equal(state.reverse, false);
    assert.ok(Math.hypot(state.x - previous.x, state.y - previous.y) < 6, "no flyoff");
    peakSpeed = Math.max(peakSpeed, state.speed); previous = state;
  }
  assert.ok(peakSpeed < 60);
  const turned = sampleTradeShipMotion("departing", voyage.backingDuration + voyage.turnDuration);
  assert.equal(turned.heading, voyage.departureHeading);
  assert.ok(turned.y < docked.y + docked.width * .1, "the picture turns before the downward exit takes it off the map");
  assert.ok(cleared.x - previous.x < docked.width * .4, "only a small leftward drift after clearing");
  const departed = advanceTradeShipMotion(departing, voyage.departureDuration);
  assert.equal(departed.phase, "departed"); assert.equal(departed.visible, false);
  assert.equal(departed.speed, 0);
  assert.equal(departed.heading, voyage.departureHeading);
  assert.ok(departed.y > 1320);
  assert.equal(advanceTradeShipMotion(departed, 10), departed);
});

test("backing/turning join has no position, angle, velocity or acceleration jump", () => {
  const h = .00001, join = voyage.backingDuration;
  const before = sampleTradeShipMotion("departing", join - h);
  const current = sampleTradeShipMotion("departing", join);
  const after = sampleTradeShipMotion("departing", join + h);
  near(before.x, current.x); near(after.x, current.x);
  near(before.y, current.y); near(after.y, current.y);
  near(before.heading, 0); near(after.heading, 0);
  assert.equal(current.speed, 0);
  for (const state of [before, after]) assert.ok(state.speed < .0001);
  for (const axis of ["X", "Y"]) near((current[`velocity${axis}`] - before[`velocity${axis}`]) / h,
    (after[`velocity${axis}`] - current[`velocity${axis}`]) / h, .001);
  const finish = sampleTradeShipMotion("departing", voyage.departureDuration - h);
  near(finish.heading, voyage.departureHeading);
  assert.ok(finish.speed < .00001);
});

test("route and velocity are independent of FPS and frame partition, including a late large frame", () => {
  for (const phase of ["arriving", "departing"]) {
    const initial = phase === "arriving" ? createTradeShipMotion("arriving") : departTradeShip(createTradeShipMotion());
    const expected = sampleTradeShipMotion(phase, 7);
    for (const fps of [30, 60, 144]) {
      let state = initial;
      for (let n = 0; n < 7 * fps; n++) state = advanceTradeShipMotion(state, 1 / fps);
      for (const key of ["x", "y", "heading", "velocityX", "velocityY", "speed", "progress"]) near(state[key], expected[key]);
      const finished = advanceTradeShipMotion(state, 1e300);
      assert.equal(finished.phase, phase === "arriving" ? "docked" : "departed");
      assert.equal(finished.speed, 0);
    }
  }
});

test("reported velocity matches motion; invalid deltas freeze and premature departure is ignored", () => {
  const state = createTradeShipMotion("arriving");
  for (const dt of [0, -1, NaN, Infinity, -Infinity]) assert.equal(advanceTradeShipMotion(state, dt), state);
  assert.equal(departTradeShip(state), state);
  const h = .0001;
  for (const phase of ["arriving", "departing"]) for (const t of [1, 5, 10, 15]) {
    const before = sampleTradeShipMotion(phase, t - h), current = sampleTradeShipMotion(phase, t), after = sampleTradeShipMotion(phase, t + h);
    near((after.x - before.x) / (2 * h), current.velocityX, .00001);
    near((after.y - before.y) / (2 * h), current.velocityY, .00001);
  }
  const berth = { x: 730, y: 1050, width: 280 };
  const custom = advanceTradeShipMotion(createTradeShipMotion("arriving", berth), 100);
  assert.equal(custom.x, berth.x); assert.equal(custom.y, berth.y); assert.equal(custom.width, berth.width);
  const invalid = createTradeShipMotion("arriving", { x: NaN, y: Infinity, width: -1 });
  assert.deepEqual(invalid, state);
});
