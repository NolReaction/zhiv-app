import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingReelLoopMix, fishingAudioFrame, createFishingAudioController, FISHING_AUDIO_CUES } = await vite.ssrLoadModule("/features/audio/ui/fishing-audio.ts");
const base = { sceneId: "world:owner", voyageId: "voyage", castKey: "cast", stage: "reeling", held: true, progress: 2500, inZone: true, caughtCount: 0 };
const gain = (mix, cue) => mix.find(loop => loop.cueId === cue)?.gain ?? 0;

test("hold and release crossfade the same two prepared voices, with progress and actual alignment feedback", () => {
  const wind = fishingReelLoopMix(base), release = fishingReelLoopMix({ ...base, held: false });
  assert.deepEqual(wind.map(loop => [loop.id, loop.cueId]), release.map(loop => [loop.id, loop.cueId]));
  assert.equal(wind.length, 2);
  assert.ok(gain(wind, "fishing.reel.wind") > 100 * gain(release, "fishing.reel.wind"));
  assert.ok(gain(release, "fishing.reel.slack") > 100 * gain(wind, "fishing.reel.slack"));
  for (const loop of [...wind, ...release]) assert.ok(loop.gain > .001 && loop.gain < .8, "the inactive voice stays quietly alive through rapid tapping");
  assert.ok(gain(fishingReelLoopMix({ ...base, progress: 8000 }), "fishing.reel.wind") > gain(wind, "fishing.reel.wind"));
  assert.ok(gain(fishingReelLoopMix({ ...base, inZone: false }), "fishing.reel.wind") < gain(wind, "fishing.reel.wind"));
  assert.deepEqual(fishingReelLoopMix({ ...base, progress: 2510 }), wind, "ordinary ticks inside a 5% step do not retarget the mix");
  assert.notDeepEqual(fishingReelLoopMix({ ...base, castKey: "next" }).map(loop => loop.id), wind.map(loop => loop.id));
  for (const progress of [NaN, Infinity, -1, 50000]) assert.ok(fishingReelLoopMix({ ...base, progress }).every(loop => Number.isFinite(loop.gain)));
  for (const cue of ["fishing.reel.wind", "fishing.reel.slack"]) assert.ok(FISHING_AUDIO_CUES.includes(cue));
});

test("waiting, pausing, hidden state and local results cannot leave reel tones running", () => {
  for (const stage of ["waiting", "casting", "soaking", "bite", "paused", "caught", "escaped", "expired", "pending", "landed"])
    assert.deepEqual(fishingReelLoopMix({ ...base, stage }), [], stage);
  assert.deepEqual(fishingReelLoopMix({ ...base, suspended: true }), []);
  assert.deepEqual(fishingReelLoopMix({ ...base, castKey: undefined }), []);
  const frame = fishingAudioFrame("owner", base);
  assert.equal(frame.loops.filter(loop => loop.cueId.startsWith("fishing.reel.")).length, 2);
});

test("controller keeps input voices bounded through 200 rapid changes and removes them on owner suspension", () => {
  let now = 1000, frame;
  const frames = [], events = [], cleared = [];
  const runtime = { updateFrame(next) { frame = next; frames.push(next); }, clearFrame(owner) { cleared.push(owner); frame = null; }, play(event) { events.push(event); } };
  const controller = createFishingAudioController(runtime, "fishing", { now: () => now, schedule: () => 1, cancel() {} });
  controller.update(base);
  const ids = frame.loops.filter(loop => loop.cueId.startsWith("fishing.reel.")).map(loop => loop.id);
  for (let index = 0; index < 200; index++) {
    now += 50; controller.update({ ...base, held: index % 2 === 0, progress: 2500 + index });
    assert.deepEqual(frame.loops.filter(loop => loop.cueId.startsWith("fishing.reel.")).map(loop => loop.id), ids);
    assert.equal(frame.loops.length, 6, "one music + three daylight ambience loops + two reel loops");
  }
  assert.equal(events.length, 0, "holding and releasing never floods one-shots");
  const count = frames.length; controller.update({ ...base, held: false, progress: 2699 }); assert.equal(frames.length, count);
  controller.update({ ...base, stage: "paused" }); assert.equal(frame.loops.some(loop => loop.cueId.startsWith("fishing.reel.")), false);
  controller.update({ ...base, suspended: true }); assert.equal(frame, null); assert.deepEqual(cleared, ["fishing"]);
  controller.update(base); assert.ok(frame.loops.some(loop => loop.cueId === "fishing.reel.wind"));
  controller.dispose(); assert.equal(frame, null); assert.equal(cleared.length, 2);
});

test("two short quiet original loops preserve seamless PCM joins and the 24 MiB decoded bank", () => {
  const manifest = JSON.parse(readFileSync(`${root}/art/audio/originals-v1/manifest.json`));
  const catalog = JSON.parse(readFileSync(`${root}/features/audio/catalog/audio-catalog.json`));
  for (const kind of ["wind", "slack"]) {
    const id = `fishing.reel.${kind}.01`, asset = manifest.assets.find(item => item.id === id), cue = catalog.cues.find(item => item.id === `fishing.reel.${kind}`);
    assert.equal(asset.kind, "loop"); assert.equal(asset.channels, 1); assert.equal(asset.durationSeconds, 1);
    assert.ok(asset.measurements.peakDb <= -18 && asset.measurements.rmsDb <= -28);
    assert.ok(asset.measurements.seamDelta < Math.max(.003, asset.measurements.maxAdjacentDelta * 2));
    assert.equal(asset.decodedBytes, 192000); assert.equal(asset.files[0].bytes, 96044);
    assert.equal(cue.bus, "world"); assert.equal(cue.mode, "loop"); assert.equal(cue.maxInstances, 1); assert.equal(cue.pitchVariation, 0);
    assert.ok(cue.fadeMs >= 80 && cue.fadeMs <= 160);
  }
  const loops = manifest.assets.filter(item => item.kind === "loop");
  assert.ok(loops.reduce((sum, item) => sum + item.decodedBytes, 0) < 24 * 1024 ** 2);
});

test("a slipped milestone stays consumed across hidden and paused resume, while a new cast gets its own milestones", () => {
  let now = 1000;
  const events = [];
  const runtime = { updateFrame() {}, clearFrame() {}, play(event) { events.push(event); } };
  const controller = createFishingAudioController(runtime, "fishing", { now: () => now, schedule: () => 1, cancel() {} });
  const update = extra => { now += 500; controller.update({ ...base, ...extra }); };
  const accents = () => events.filter(event => event.cueId === "fishing.reel");
  update({ stage: "bite", progress: 2500 });
  update({ progress: 5000 }); update({ progress: 7500 });
  assert.equal(accents().length, 2);
  update({ progress: 5000 });
  update({ progress: 5000, suspended: true });
  update({ progress: 5000, suspended: true });
  update({ progress: 5000 }); update({ progress: 7500 });
  assert.equal(accents().length, 2, "visibility cannot replay the earlier 75% accent after a slip");
  update({ stage: "paused", progress: 5000 });
  update({ progress: 5000 }); update({ progress: 7500 });
  assert.equal(accents().length, 2, "pausing likewise retains the highest consumed milestone");
  update({ castKey: "next", stage: "casting", progress: 0 });
  update({ castKey: "next", stage: "bite", progress: 2500 });
  update({ castKey: "next", progress: 5000 });
  assert.equal(accents().length, 3, "the next cast may sound its own new 50% milestone");
  assert.match(accents().at(-1).id, /:next:reel-2$/);
  controller.dispose();
});
