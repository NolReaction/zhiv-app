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

test("arrival enters from lower-right, brakes continuously, and stays at the berth until commanded", () => {
  let state = createTradeShipMotion("arriving");
  assert.ok(state.y > 1320, "starts beyond both the map and the preview's sea margin");
  assert.ok(state.x > state.berth.x);
  assert.equal(state.speed, 0);
  assert.equal(state.reverse, false);
  let previous = state;
  for (let i = 1; i <= 1800; i++) {
    state = sampleTradeShipMotion("arriving", i / 100);
    assert.ok(state.x <= previous.x + 1e-9 && state.y <= previous.y + 1e-9);
    assert.ok(state.speed < 60);
    assert.equal(state.heading, 0);
    assert.ok(state.visible);
    previous = state;
  }
  assert.equal(state.phase, "docked");
  assert.equal(state.speed, 0);
  assert.equal(state.heading, 0);
  assert.equal(state.x, state.berth.x);
  assert.equal(state.y, state.berth.y);
  assert.equal(advanceTradeShipMotion(state, 60), state);
  const before = sampleTradeShipMotion("arriving", voyage.arrivalDuration - .001);
  near(before.x, state.x); near(before.y, state.y);
  near(before.heading, state.heading, .00001);
  assert.ok(before.speed < .00001);
});

test("departure backs a little right, turns smoothly down-left, and leaves without spinning or jumping", () => {
  const docked = createTradeShipMotion(), departing = departTradeShip(docked);
  assert.equal(departing.phase, "departing");
  near(departing.x, docked.x); near(departing.y, docked.y); near(departing.heading, docked.heading);
  assert.equal(departing.speed, 0);
  assert.equal(departing.reverse, true);
  assert.equal(departTradeShip(departing), departing);
  let previous = departing, turns = 0, turned = false, rightmost = departing.x, peakSpeed = 0;
  for (let i = 1; i < voyage.departureDuration * 10; i++) {
    const t = i / 10;
    const state = sampleTradeShipMotion("departing", t);
    assert.ok(state.y > previous.y && state.velocityY > 0, "the whole departure continues toward open sea");
    if (state.velocityX < 0 && !turned) { turned = true; turns++; }
    if (turned) {
      assert.ok(state.velocityX < 0, "after clearing the berth, the ship continues down-left");
      assert.equal(state.reverse, false);
    } else {
      assert.ok(state.x > previous.x && state.velocityX > 0);
      assert.equal(state.reverse, true, "the first short move is stern-first");
    }
    assert.equal(state.heading, 0, "one fixed PNG must not pretend to rotate into another perspective");
    assert.ok(Math.hypot(state.x - previous.x, state.y - previous.y) < 5, "no frame jump or flyoff");
    rightmost = Math.max(rightmost, state.x); peakSpeed = Math.max(peakSpeed, state.speed);
    previous = state;
  }
  assert.equal(turns, 1);
  assert.ok(rightmost - docked.x > docked.width * .1);
  assert.ok(rightmost - docked.x < docked.width * .25, "backs less than a quarter ship placement width");
  assert.ok(peakSpeed < 48, "the longer departure keeps the default manoeuvre unhurried");
  assert.ok(previous.x < docked.x - docked.width * .5);
  const departed = advanceTradeShipMotion(departing, voyage.departureDuration);
  assert.equal(departed.phase, "departed");
  assert.equal(departed.visible, false);
  assert.equal(departed.speed, 0);
  assert.ok(departed.y > 1320, "becomes invisible only after leaving the full preview frame");
  assert.equal(advanceTradeShipMotion(departed, 10), departed);
});

test("horizontal direction changes once with continuous position, velocity and acceleration", () => {
  let low = 0, high = voyage.departureDuration;
  for (let n = 0; n < 60; n++) {
    const middle = (low + high) / 2;
    if (sampleTradeShipMotion("departing", middle).velocityX > 0) low = middle;
    else high = middle;
  }
  const turn = (low + high) / 2, h = .001;
  assert.ok(turn > voyage.departureDuration * .3 && turn < voyage.departureDuration * .5);
  const before = sampleTradeShipMotion("departing", turn - h);
  const current = sampleTradeShipMotion("departing", turn);
  const after = sampleTradeShipMotion("departing", turn + h);
  near(current.velocityX, 0, 1e-7);
  assert.ok(current.velocityY > 15, "the bend does not stop and launch a second animation");
  near(before.x, after.x, .001); near(before.y, after.y, .1);
  for (const axis of ["X", "Y"]) {
    near((current[`velocity${axis}`] - before[`velocity${axis}`]) / h,
      (after[`velocity${axis}`] - current[`velocity${axis}`]) / h, .01);
  }
  const start = sampleTradeShipMotion("departing", h);
  const finish = sampleTradeShipMotion("departing", voyage.departureDuration - h);
  assert.ok(start.speed < .00001 && finish.speed < .00001);
  near(start.heading, 0); near(finish.heading, 0);
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
