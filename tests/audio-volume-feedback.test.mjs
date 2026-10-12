import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { playVolumeFeedback, playUiCue } = await vite.ssrLoadModule("/features/audio/ui/audio-lifecycle.ts");
const { DEFAULT_AUDIO_SETTINGS } = await vite.ssrLoadModule("/features/audio/domain/settings.ts");

test("slider feedback follows the selected value without unlocking or playing at zero", () => {
  const events = [];
  let settings = { ...DEFAULT_AUDIO_SETTINGS, enabled: true, buses: { ...DEFAULT_AUDIO_SETTINGS.buses } };
  const runtime = { getSettings: () => settings, play: event => events.push(event) };
  playVolumeFeedback(runtime, "weather", .2);
  playVolumeFeedback(runtime, "weather", .8);
  assert.equal(events.length, 2);
  assert.equal(events[0].cueId, "ui.slider");
  assert.equal(events[0].feedbackBus, "weather");
  assert.ok(events[0].gain < events[1].gain);
  assert.ok(events[0].playbackRate < events[1].playbackRate);
  assert.notEqual(events[0].id, events[1].id);
  for (const value of [0, -1, NaN, Infinity]) playVolumeFeedback(runtime, "weather", value);
  settings.buses.weather = 0;
  playVolumeFeedback(runtime, "weather", .5);
  settings.buses.weather = .3;
  settings.buses.ui = 0;
  playVolumeFeedback(runtime, "weather", .5);
  settings.buses.ui = .35;
  settings.master = 0;
  playVolumeFeedback(runtime, "weather", .5);
  settings.master = .65;
  settings.enabled = false;
  playVolumeFeedback(runtime, "weather", .5);
  assert.equal(events.length, 2);
});

test("tab cue is accepted, while slider feedback cannot be emitted as a delegated click", () => {
  const events = [], runtime = { play: event => events.push(event) };
  playUiCue(runtime, "ui.tab");
  playUiCue(runtime, "ui.slider");
  assert.deepEqual(events.map(event => event.cueId), ["ui.tab"]);
});
