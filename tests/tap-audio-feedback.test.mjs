import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { playTapFeedback, TAP_AUDIO_INTERVAL_MS } = await vite.ssrLoadModule("/features/audio/ui/tap-feedback.ts");
const catalog = JSON.parse(readFileSync(new URL("../features/audio/catalog/audio-catalog.json", import.meta.url)));

test("rapid taps remain immediate and bounded instead of queueing a sound for every input", () => {
  const events = [], runtime = { play: event => events.push(event) };
  for (let index = 0; index < 1000; index++) playTapFeedback(runtime, 20, 10_000 + index);
  assert.equal(events.length, 7);
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
  for (let index = 1; index < events.length; index++)
    assert.ok(events[index].occurredAt - events[index - 1].occurredAt >= TAP_AUDIO_INTERVAL_MS);
  assert.ok(events.every(event => event.cueId === "ui.tap" && event.maxAgeMs === 120));
});

test("power raises a rounded tap gently within the mixer playback limits", () => {
  const events = [], runtime = { play: event => events.push(event) };
  for (const [index, power] of [0, 5, 10, 15, 20, 1000, NaN].entries())
    playTapFeedback(runtime, power, index * 200);
  assert.ok(events.slice(1, 5).every((event, index) => event.playbackRate > events[index].playbackRate));
  assert.equal(events[4].playbackRate, events[5].playbackRate);
  assert.equal(events[0].playbackRate, events[6].playbackRate);
  assert.ok(events.every(event => event.playbackRate >= .88 && event.playbackRate <= 1.18 && event.gain <= .9));
  playTapFeedback(runtime, 10, NaN);
  assert.equal(events.length, 7);
});

test("feedback cues use the shared UI bus, restrained overlap and dedicated boost recordings", () => {
  const cue = id => catalog.cues.find(item => item.id === id);
  for (const id of ["ui.tap", "ui.production-start", "ui.collect", "ui.boost-rise", "ui.boost-full"]) {
    assert.equal(cue(id).bus, "ui");
    assert.ok(cue(id).gainDb <= -3);
    assert.ok(cue(id).maxInstances <= 2);
  }
  assert.ok(cue("ui.tap").cooldownMs >= TAP_AUDIO_INTERVAL_MS);
  assert.equal(cue("ui.tap").assets.length, 3);
  assert.notDeepEqual(cue("ui.boost-rise").assets, cue("ui.boost-full").assets);
  assert.equal(cue("ui.boost-full").maxInstances, 1);
});
