import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({ appType: "custom", configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createEarthSceneClock, EARTH_SCENE_INTERVAL_MS } = await vite.ssrLoadModule("/features/earth/scene-clock.ts");

function fixture(step) {
  let time = 0; let nextId = 0;
  const pending = new Map();
  const clock = createEarthSceneClock({ now: () => time, step,
    schedule(callback, delay) { const id = ++nextId; pending.set(id, { callback, at: time + delay }); return id; },
    cancel: id => pending.delete(id) });
  return { clock, pending, advance(duration) {
    const end = time + duration;
    while (pending.size) {
      const [id, next] = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
      if (next.at > end) break;
      time = next.at; pending.delete(id); next.callback();
    }
    time = end;
  } };
}

test("clock is dormant until ready and has exactly one bounded tick while running", () => {
  const frames = []; const { clock, pending, advance } = fixture(time => frames.push(time));
  advance(10_000); assert.deepEqual(frames, []);
  clock.setRunning(true); clock.setRunning(true);
  assert.equal(pending.size, 1);
  advance(1_000);
  assert.equal(frames.length, 1_000 / EARTH_SCENE_INTERVAL_MS);
  assert.equal(pending.size, 1);
  clock.dispose(); assert.equal(pending.size, 0);
});

test("hidden/reduced-motion/street pauses cannot accumulate time or restart after disposal", () => {
  const frames = []; const { clock, pending, advance } = fixture(time => frames.push(time));
  clock.setRunning(true); advance(500); clock.setRunning(false);
  assert.equal(pending.size, 0);
  advance(86_400_000); clock.setRunning(true); advance(125);
  assert.equal(frames.at(-1), 625, "returning after a day continues the scene without a leap");
  clock.dispose(); clock.dispose(); clock.setRunning(true); advance(1_000);
  assert.equal(frames.at(-1), 625); assert.equal(pending.size, 0);
});

test("a scene disposed by its own frame cannot leave another timeout behind", () => {
  let clock; const instance = fixture(() => clock.dispose()); clock = instance.clock;
  clock.setRunning(true); instance.advance(1_000);
  assert.equal(instance.pending.size, 0);
});

test("adaptive cadence keeps one timer, wall-time motion and pause semantics", () => {
  const frames = [], { clock, pending, advance } = fixture(time => frames.push(time));
  clock.setIntervalMs(250); assert.equal(pending.size, 0);
  clock.setRunning(true); advance(1_000);
  assert.deepEqual(frames, [250, 500, 750, 1_000]);
  advance(100); clock.setIntervalMs(125); assert.equal(pending.size, 1);
  advance(125); assert.equal(frames.at(-1), 1_225, "cadence changes cannot discard pending elapsed time");
  clock.setRunning(false); advance(50_000); clock.setIntervalMs(250); clock.setRunning(true); advance(250);
  assert.equal(frames.at(-1), 1_475, "hidden time never advances the decorative scene");
  clock.dispose(); clock.setIntervalMs(125); assert.equal(pending.size, 0);
});

test("a cadence change inside a frame cannot double-schedule the clock", () => {
  let clock;
  const s = fixture(() => clock.setIntervalMs(250)); clock = s.clock;
  clock.setRunning(true); s.advance(1_000);
  assert.equal(s.pending.size, 1);
  clock.dispose();
});
