import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createAudioReleaseClock, AUDIO_VISIBILITY_CLEANUP_MS } = await vite.ssrLoadModule("/features/audio/runtime/audio-release-clock.ts");

function fixture({ constant = true, fail = false } = {}) {
  const output = {}, sources = [], buffers = [];
  const context = { state: "running", currentTime: 10, sampleRate: 48_000,
    createBuffer(channels, length, rate) {
      const buffer = { channels, length, rate, samples: new Float32Array(length) };
      buffers.push(buffer); return buffer;
    },
    createBufferSource: source,
  };
  function source() {
    if (fail) throw new Error("Unavailable native source");
    const node = { offset: { value: 1 }, onended: null, connected: null, started: 0, stopped: [], disconnected: 0,
      connect(target) { this.connected = target; },
      start() { this.started++; },
      stop(at) { this.stopped.push(at); },
      disconnect() { this.disconnected++; },
    };
    sources.push(node); return node;
  }
  if (constant) context.createConstantSource = source;
  let completed = 0;
  const clock = createAudioReleaseClock(context, output, 10.18, () => { completed++; });
  return { clock, context, output, sources, buffers, get completed() { return completed; } };
}

test("release clock is exactly silent and schedules one native end at the envelope deadline", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), source = f.sources[0], ended = source.onended;
  assert.equal(f.sources.length, 1);
  assert.equal(source.offset.value, 0, "ConstantSource defaults to DC 1, so zero is mandatory");
  assert.equal(source.connected, f.output); assert.equal(source.started, 1);
  assert.deepEqual(source.stopped, [10.18]);
  f.context.currentTime = 10.18; ended();
  assert.equal(f.completed, 1); assert.equal(source.disconnected, 1);
  assert.equal(source.onended, null);
  t.mock.timers.tick(60_000); ended(); f.clock.check(); f.clock.cancel();
  assert.equal(f.completed, 1, "native, timer and stale callbacks cannot finish twice");
});

test("elapsed wall time never completes a still-audible stalled native clock and creates no polling", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timer = t.mock.method(globalThis, "setTimeout");
  const f = fixture(), source = f.sources[0];
  f.context.currentTime = 10.005;
  t.mock.timers.tick(AUDIO_VISIBILITY_CLEANUP_MS);
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 100; i++) assert.equal(f.clock.check(), false);
  assert.equal(f.completed, 0); assert.equal(source.disconnected, 0);
  assert.deepEqual(source.stopped, [10.18]);
  assert.equal(f.sources.length, 1); assert.equal(timer.mock.callCount(), 1);
  f.context.currentTime = 10.18; source.onended();
  assert.equal(f.completed, 1); assert.equal(source.disconnected, 1);
});

test("a confirmed inactive audio device allows cleanup before the scheduled deadline", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const state of ["suspended", "interrupted", "closed"]) {
    const f = fixture(); f.context.state = state;
    assert.equal(f.clock.check(), true, state);
    assert.equal(f.completed, 1); assert.equal(f.sources[0].disconnected, 1);
  }
});

test("native scheduled completion remains authoritative when exposed currentTime is rounded", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.context.currentTime = 10.1;
  t.mock.timers.tick(AUDIO_VISIBILITY_CLEANUP_MS); assert.equal(f.completed, 0);
  f.sources[0].onended();
  assert.equal(f.completed, 1, "the source itself reached the scheduled native stop");
});

test("cancelling an old clock fences already queued native end callbacks", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = fixture(), queuedEnd = old.sources[0].onended;
  old.clock.cancel();
  const current = fixture(); old.context.currentTime = 20; queuedEnd();
  t.mock.timers.tick(AUDIO_VISIBILITY_CLEANUP_MS);
  assert.equal(old.completed, 0); assert.equal(current.completed, 0);
  current.context.currentTime = 10.18; current.sources[0].onended();
  assert.equal(current.completed, 1); assert.equal(old.completed, 0);
});

test("older implementations use a bounded zero buffer rather than an immediately ended null buffer", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ constant: false }), source = f.sources[0];
  assert.equal(f.buffers.length, 1); assert.equal(source.buffer, f.buffers[0]);
  assert.equal(source.buffer.length, 128); assert.equal(source.buffer.channels, 1);
  assert.equal(source.buffer.rate, 48_000); assert.ok(source.buffer.samples.every(value => value === 0));
  assert.equal(source.loop, true); assert.deepEqual(source.stopped, [10.18]);
  t.mock.timers.tick(AUDIO_VISIBILITY_CLEANUP_MS);
  assert.equal(f.completed, 0);
  f.context.currentTime = 10.18; source.onended(); assert.equal(f.completed, 1);
});

test("unavailable scheduled sources keep the same native-time guard with one fallback timer", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ fail: true });
  t.mock.timers.tick(60_000); assert.equal(f.completed, 0);
  f.context.currentTime = 10.18;
  assert.equal(f.clock.check(), true); assert.equal(f.completed, 1);
});
