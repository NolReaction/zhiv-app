import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createMusicLoopEnvelope } = await vite.ssrLoadModule("/features/audio/runtime/music-loop-envelope.ts");

class Param {
  value = 0;
  points = [{ time: 0, value: 0 }];
  calls = 0;
  level(time) {
    let previous = this.points[0];
    for (const point of this.points.slice(1)) {
      if (time <= point.time) {
        const fraction = Math.max(0, Math.min(1, (time - previous.time) / (point.time - previous.time)));
        return previous.value + (point.value - previous.value) * fraction;
      }
      previous = point;
    }
    return previous.value;
  }
  cancelScheduledValues(time) { this.points = this.points.filter(point => point.time < time); }
  cancelAndHoldAtTime(time) {
    const value = this.level(time);
    this.cancelScheduledValues(time); this.points.push({ time, value });
  }
  setValueAtTime(value, time) { this.points.push({ time, value }); }
  linearRampToValueAtTime(value, time) { this.calls++; this.points.push({ time, value }); }
}
function fixture(overrides = {}) {
  const context = { currentTime: 0 };
  const gain = new Param();
  const media = { paused: false, duration: 120, currentTime: 0, playbackRate: 1, readyState: 4, ...overrides };
  const envelope = createMusicLoopEnvelope(context, gain, media, () => true);
  return { context, gain, media, envelope };
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ~= ${expected}`);

test("native loop has a 2.5-second release and attack even without boundary callbacks", () => {
  const f = fixture();
  try {
    f.envelope.refresh();
    close(f.gain.level(0), 0); close(f.gain.level(1.25), .5); close(f.gain.level(2.5), 1);
    close(f.gain.level(60), 1); close(f.gain.level(117.5), 1);
    close(f.gain.level(118.75), .5); close(f.gain.level(120), 0);
    close(f.gain.level(121.25), .5); close(f.gain.level(122.5), 1);
    for (let time = 117.5; time <= 122.5; time += .025) {
      assert.ok(Math.abs(f.gain.level(time + .025) - f.gain.level(time)) < .011, "the loop boundary never jumps in level");
    }
  } finally { f.envelope.dispose(); }
});

test("regular media clock updates retain the scheduled fade instead of postponing it", () => {
  const f = fixture();
  try {
    f.envelope.refresh(); const count = f.gain.calls;
    for (let index = 1; index < 600; index++) {
      f.context.currentTime = f.media.currentTime = index / 5;
      f.envelope.refresh();
    }
    assert.equal(f.gain.calls, count);
    close(f.gain.level(120), 0);
  } finally { f.envelope.dispose(); }
});

test("a pause or buffering stall holds the current fade and resumes from the actual playhead", () => {
  for (const reason of ["pause", "buffering"]) {
    const f = fixture();
    try {
      f.envelope.refresh();
      f.context.currentTime = f.media.currentTime = 118.75;
      if (reason === "pause") f.media.paused = true;
      else f.media.readyState = 2;
      f.envelope.refresh();
      close(f.gain.level(130), .5);
      f.context.currentTime = 130; f.media.paused = false; f.media.readyState = 4;
      f.envelope.refresh();
      close(f.gain.level(130), .5); close(f.gain.level(131.25), 0); close(f.gain.level(133.75), 1);
    } finally { f.envelope.dispose(); }
  }
});

test("clock drift and seeks reschedule the boundary without a discontinuity", () => {
  const f = fixture();
  try {
    f.envelope.refresh();
    f.context.currentTime = 118.75; f.media.currentTime = 30;
    f.envelope.refresh();
    close(f.gain.level(118.75), .5);
    close(f.gain.level(118.775), .75);
    close(f.gain.level(118.8), 1);
    close(f.gain.level(208.75), 0); close(f.gain.level(211.25), 1);
  } finally { f.envelope.dispose(); }
});

test("short tracks scale both fades and non-unit playback rate follows media time", () => {
  const f = fixture({ duration: 4, playbackRate: 2 });
  try {
    f.envelope.refresh();
    close(f.gain.level(.25), .5); close(f.gain.level(.5), 1);
    close(f.gain.level(1.5), 1); close(f.gain.level(1.75), .5);
    close(f.gain.level(2), 0); close(f.gain.level(2.25), .5); close(f.gain.level(2.5), 1);
  } finally { f.envelope.dispose(); }
});

test("unknown metadata stays audible and the watchdog picks up the next finite loop", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ duration: NaN });
  try {
    f.envelope.refresh(); close(f.gain.level(.25), 1);
    f.context.currentTime = .3; f.media.currentTime = .3; f.media.duration = 120;
    t.mock.timers.tick(200);
    close(f.gain.level(120), 0); close(f.gain.level(122.5), 1);
    f.context.currentTime = 120.2; f.media.currentTime = .2;
    t.mock.timers.tick(200);
    close(f.gain.level(120.2), .08); close(f.gain.level(240), 0); close(f.gain.level(242.5), 1);
  } finally { f.envelope.dispose(); }
});

test("browsers without cancelAndHoldAtTime preserve the audible level during a pause", () => {
  const f = fixture(); f.gain.cancelAndHoldAtTime = undefined;
  try {
    f.envelope.refresh();
    f.context.currentTime = f.media.currentTime = 118.75; f.media.paused = true;
    f.envelope.refresh();
    close(f.gain.level(118.75), .5); close(f.gain.level(120), .5);
  } finally { f.envelope.dispose(); }
});
