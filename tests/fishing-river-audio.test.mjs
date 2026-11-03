import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingRiverNightBlend } = await vite.ssrLoadModule("/features/audio/ui/fishing-river-mix.ts");
const { fishingAudioFrame, createFishingAudioController } = await vite.ssrLoadModule("/features/audio/ui/fishing-audio.ts");
const base = { sceneId: "river:owner", voyageId: "saved-voyage", stage: "waiting", held: false, progress: 0, inZone: false, caughtCount: 0 };
const ambience = (hour, timeZone = "UTC") => ({ now: Date.UTC(2026, 10, 3, Math.floor(hour), Math.round(hour % 1 * 60)), timeZone });

test("river wildlife follows civil profile time with a continuous twilight blend", () => {
  assert.equal(fishingRiverNightBlend(ambience(12)), 0);
  assert.equal(fishingRiverNightBlend(ambience(23)), 1);
  assert.equal(fishingRiverNightBlend(ambience(19.5)), .5);
  assert.equal(fishingRiverNightBlend(ambience(6.5)), .5);
  assert.equal(fishingRiverNightBlend(ambience(18, "Europe/Moscow")), 1);
  assert.equal(fishingRiverNightBlend(ambience(12, "invalid/zone")), 0);
  for (const time of [5, 8, 18, 21]) {
    const before = fishingRiverNightBlend(ambience(time - 1 / 60));
    const after = fishingRiverNightBlend(ambience(time + 1 / 60));
    assert.ok(Math.abs(before - after) < .002);
  }
});

test("one shared frame keeps music and restrained water/reeds with only appropriate wildlife", () => {
  const day = fishingAudioFrame("fishing", { ...base, ambience: ambience(12) });
  const night = fishingAudioFrame("fishing", { ...base, ambience: ambience(23) });
  const twilight = fishingAudioFrame("fishing", { ...base, ambience: ambience(19.5) });
  assert.equal(day.loops[0].cueId, "music.fishing"); assert.equal(day.loops[0].gain, .65);
  assert.ok(day.loops.some(loop => loop.cueId === "river" && loop.gain < .2));
  assert.ok(day.loops.some(loop => loop.cueId === "fishing.reeds"));
  assert.ok(day.loops.some(loop => loop.cueId === "forest.day")); assert.ok(!day.loops.some(loop => loop.cueId === "forest.night"));
  assert.ok(night.loops.some(loop => loop.cueId === "forest.night")); assert.ok(!night.loops.some(loop => loop.cueId === "forest.day"));
  assert.equal(twilight.loops.length, 5);
  const paused = fishingAudioFrame("fishing", { ...base, stage: "paused", ambience: ambience(12) });
  assert.equal(paused.musicDuck, .55);
  for (const loop of paused.loops.slice(1)) assert.ok(loop.gain < day.loops.find(item => item.id === loop.id).gain);
  const catalog = JSON.parse(readFileSync(`${root}/features/audio/catalog/audio-catalog.json`));
  assert.equal(catalog.cues.find(cue => cue.id === "fishing.hull").bus, "ambience");
  assert.equal(catalog.cues.find(cue => cue.id === "fishing.reeds").bus, "weather");
});

test("repeated frames never flood contacts, and stalls, pause and hidden resume cannot backfill creaks", () => {
  let time = 1000, serial = 0;
  const frames = [], events = [], timers = new Map(), cleared = [];
  const runtime = { updateFrame: frame => frames.push(frame), clearFrame: owner => cleared.push(owner), play: event => events.push(event) };
  const clock = { now: () => time, schedule(callback, delay) { timers.set(++serial, { callback, at: time + delay }); return serial; }, cancel: id => timers.delete(id) };
  const controller = createFishingAudioController(runtime, "fishing", clock);
  const update = extra => controller.update({ ...base, ambience: ambience(12), ...extra });
  update(); for (let frame = 0; frame < 200; frame++) update();
  assert.equal(frames.length, 1); assert.equal(events.length, 0); assert.equal(timers.size, 0);
  for (let second = 0; second < 80; second++) { time += 1000; update(); }
  const creaks = events.filter(event => event.cueId === "fishing.hull");
  assert.ok(creaks.length >= 2 && creaks.length <= 4);
  for (let index = 1; index < creaks.length; index++) assert.ok(creaks[index].occurredAt - creaks[index - 1].occurredAt >= 18000);
  assert.equal(frames.length, 1, "unchanged polls retain loops rather than restarting them");
  const count = events.length; time += 120000; update(); assert.equal(events.length, count);
  update({ stage: "paused" });
  for (let second = 0; second < 50; second++) { time += 1000; update({ stage: "paused" }); }
  assert.equal(events.length, count); update(); assert.equal(events.length, count);
  update({ suspended: true }); time += 120000; update({ suspended: true }); update(); assert.equal(events.length, count);
  update({ sceneId: "river:other-account", voyageId: "other-voyage" }); assert.equal(events.length, count);
  controller.dispose(); assert.ok(cleared.includes("fishing"));
  time += 60000; update(); assert.equal(events.length, count); assert.equal(timers.size, 0);
});

test("the new timber contact is a quiet short mono original and leaves the ambient bank budget unchanged", () => {
  const manifest = JSON.parse(readFileSync(`${root}/art/audio/originals-v1/manifest.json`));
  const item = manifest.assets.find(asset => asset.id === "fishing.hull.01");
  assert.equal(item.kind, "effect"); assert.equal(item.channels, 1); assert.equal(item.durationSeconds, .86);
  assert.ok(item.measurements.peakDb <= -22 && item.measurements.rmsDb < -32);
  assert.ok(item.files[0].bytes < 90000);
  const loops = manifest.assets.filter(asset => asset.kind === "loop");
  assert.equal(loops.length, 11);
  assert.ok(loops.reduce((sum, loop) => sum + loop.decodedBytes, 0) < 24 * 1024 ** 2);
});
