import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({ appType: "custom", configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createEarthQualityPolicy, EARTH_QUALITY_PROFILES } = await vite.ssrLoadModule("/features/earth/quality-policy.ts");
const { createEarthQualityController } = await vite.ssrLoadModule("/features/earth/quality-controller.ts");

function policyFixture() {
  let time = 0;
  const changes = [], policy = createEarthQualityPolicy((...value) => changes.push(value));
  return { policy, changes, run(interval, duration) {
    const end = time + duration;
    while (time <= end) { policy.observeFrame(time); time += interval; }
  }, pause(duration) { time += duration; }, get time() { return time; } };
}

test("decor eases only after sustained slow camera frames and preserves all image dimensions", () => {
  const s = policyFixture();
  s.run(16, 5_000); assert.deepEqual(s.changes, []);
  s.run(50, 1_000); assert.deepEqual(s.changes, [], "a single bad window cannot switch quality");
  s.run(50, 1_100);
  assert.deepEqual(s.changes, [["calm", EARTH_QUALITY_PROFILES.calm]]);
  assert.deepEqual(Object.keys(EARTH_QUALITY_PROFILES.calm).sort(), ["intervalMs", "oceanIntervalMs", "precipitationScale"]);
  assert.ok(EARTH_QUALITY_PROFILES.calm.intervalMs > EARTH_QUALITY_PROFILES.full.intervalMs);
  assert.ok(EARTH_QUALITY_PROFILES.calm.oceanIntervalMs > EARTH_QUALITY_PROFILES.full.oceanIntervalMs);
});

test("recovery needs sustained healthy observations plus cooldown and neutral frames do not oscillate", () => {
  const s = policyFixture(); s.run(50, 2_100); assert.equal(s.policy.getLevel(), "calm");
  s.run(16, 7_000); assert.equal(s.policy.getLevel(), "calm", "six healthy seconds cannot bypass ten-second cooldown");
  s.run(16, 3_100); assert.equal(s.policy.getLevel(), "full");
  assert.deepEqual(s.changes.map(([level]) => level), ["calm", "full"]);
  s.run(33, 20_000); assert.equal(s.changes.length, 2, "a stable 30 Hz camera is not a decorative failure");
});

test("one stall, duplicate/invalid callbacks and inactive gaps never become slow frame evidence", () => {
  const s = policyFixture();
  s.policy.observeFrame(NaN); s.policy.observeFrame(-1); s.policy.observeFrame(Infinity);
  s.run(16, 1_100); s.pause(5_000); s.run(16, 1_100);
  s.policy.observeFrame(s.time); s.policy.observeFrame(s.time);
  assert.deepEqual(s.changes, []);
  s.run(50, 1_050); s.pause(16_000); s.run(50, 1_050);
  assert.deepEqual(s.changes, [], "stale partial evidence expires before a later slow gesture");
  s.policy.reset(); s.run(16, 2_000); assert.deepEqual(s.changes, []);
});

test("short repeated gestures can contribute real frame time without measuring the pauses between them", () => {
  const s = policyFixture();
  for (let gesture = 0; gesture < 6; gesture++) {
    s.run(50, 400); s.policy.breakSequence(); s.pause(500);
  }
  assert.deepEqual(s.changes.map(([level]) => level), ["calm"]);
  s.policy.reset(); assert.equal(s.policy.getLevel(), "calm", "visibility resets evidence, not the chosen profile");
});

function controllerFixture() {
  let time = 0;
  const changes = [], listeners = new Map();
  const map = {
    on(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    off(type, callback) { listeners.get(type)?.delete(callback); if (!listeners.get(type)?.size) listeners.delete(type); },
  };
  const controller = createEarthQualityController(map, { now: () => time, onChange: (...value) => changes.push(value) });
  const emit = (type, event) => { for (const callback of [...listeners.get(type) ?? []]) callback(event); };
  return { controller, changes, listeners, emit, run(interval, duration, inputType = "mousemove", age = 0) {
    const end = time + duration;
    while (time <= end) {
      emit("move", inputType === null ? {} : { originalEvent: { type: inputType, timeStamp: time - age } });
      emit("render"); time += interval;
    }
  }, idle(interval, duration) {
    const end = time + duration;
    while (time <= end) { emit("render"); time += interval; }
  } };
}

test("SDK idle decor, programmatic flights, stale wheel input and inertia are never device FPS samples", () => {
  const s = controllerFixture(); s.controller.setEnabled(true);
  s.idle(125, 20_000);
  for (const input of [null, "mouseup", "touchend", "click", "keydown"]) s.run(50, 3_000, input);
  s.run(125, 20_000, "wheel", 500);
  assert.deepEqual(s.changes, []);
  s.run(50, 2_100, "touchmove"); assert.equal(s.controller.getLevel(), "calm");
  s.controller.dispose(); assert.equal(s.listeners.size, 0);
});

test("very slow active gestures still ease decor, while one short stall among healthy frames does not", () => {
  for (const interval of [300, 500]) {
    const s = controllerFixture(); s.controller.setEnabled(true);
    s.run(interval, interval * 18, "touchmove");
    assert.deepEqual(s.changes.map(([level]) => level), ["calm"], `${interval}ms active frames must not be discarded as idle`);
    s.controller.dispose();
  }
  const s = policyFixture(); s.run(16, 1_100); s.pause(500); s.run(16, 5_000);
  assert.deepEqual(s.changes, []);
});

test("disabled and disposed scenes have no samples or scheduling and own exactly three listeners", () => {
  const s = controllerFixture(); assert.equal(s.listeners.size, 3);
  s.run(50, 5_000); assert.deepEqual(s.changes, []);
  s.controller.setEnabled(true); s.run(50, 1_050);
  s.controller.setEnabled(false); s.run(50, 5_000);
  s.controller.setEnabled(true); s.run(50, 1_050);
  assert.deepEqual(s.changes, [], "hidden/reduced-motion evidence must not leak into a new foreground period");
  const queued = [...s.listeners.get("render")][0];
  s.controller.dispose(); s.controller.dispose(); queued(); s.controller.setEnabled(true); s.run(50, 5_000);
  assert.equal(s.listeners.size, 0); assert.deepEqual(s.changes, []);
});

test("one render is consumed once and moveend prevents a decor frame from completing the sample", () => {
  const s = controllerFixture(); s.controller.setEnabled(true);
  for (let index = 0; index < 200; index++) {
    s.emit("move", { originalEvent: { type: "mousemove", timeStamp: 0 } });
    s.emit("moveend"); s.emit("render"); s.emit("render");
  }
  s.idle(125, 3_000); assert.deepEqual(s.changes, []);
  s.run(50, 2_100, "wheel"); assert.equal(s.controller.getLevel(), "calm");
  s.controller.dispose();
});
