import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createFishingAudioController, fishingAudioFrame } = await vite.ssrLoadModule("/features/audio/ui/fishing-audio.ts");
const base = { sceneId: "world:owner", voyageId: "voyage-1", stage: "waiting", held: false, progress: 0, inZone: false, caughtCount: 0 };
function fixture() {
  let time = 1000, serial = 0, frame = null;
  const events = [], frames = [], pending = new Map();
  const runtime = { play: event => events.push(event), updateFrame: next => { frame = next; frames.push(next); }, clearFrame: owner => { if (frame?.ownerId === owner) frame = null; } };
  const clock = { now: () => time, schedule: (callback, delay) => { pending.set(++serial, { callback, at: time + delay }); return serial; }, cancel: id => pending.delete(id) };
  return { events, frames, pending, runtime, get frame() { return frame; },
    controller: createFishingAudioController(runtime, "fishing", clock),
    advance(ms) { time += ms; for (const [id, timer] of [...pending]) if (timer.at <= time) { pending.delete(id); timer.callback(); } } };
}

test("entering a saved voyage and ordinary state updates preserve one music deck without replaying a cast", () => {
  const f = fixture(); const saved = { ...base, castKey: "saved", stage: "paused", progress: 4200, caughtCount: 2 };
  f.controller.update(saved);
  for (let n = 0; n < 40; n++) f.controller.update(saved);
  assert.equal(f.frames.length, 1); assert.equal(f.events.length, 0); assert.equal(f.pending.size, 0);
  assert.equal(f.frame.sceneId, base.sceneId); assert.equal(f.frame.loops[0].cueId, "music.fishing");
  f.controller.update({ ...saved, stage: "reeling" });
  assert.equal(f.frame.musicDuck, 1); assert.equal(f.events.length, 0);
  f.controller.dispose();
});

test("a new accepted cast has one launch and one delayed water contact; pause cancels contact instead of queuing it", () => {
  const f = fixture(); f.controller.update(base);
  const cast = { ...base, castKey: "cast-1", stage: "casting" };
  f.controller.update(cast); f.controller.update(cast);
  assert.deepEqual(f.events.map(e => e.cueId), ["fishing.cast"]);
  f.advance(1199); assert.equal(f.events.length, 1); f.advance(1);
  assert.deepEqual(f.events.map(e => e.cueId), ["fishing.cast", "action.fish.splash"]);
  f.controller.update({ ...cast, castKey: "cast-2" });
  f.controller.update({ ...cast, castKey: "cast-2", stage: "paused" });
  f.advance(5000); assert.equal(f.events.length, 3); assert.equal(f.pending.size, 0);
  f.controller.update({ ...cast, castKey: "cast-2" }); f.advance(5000); assert.equal(f.events.length, 3);
  f.controller.dispose();
});

test("local success is silent until the confirmed catch count increases, and snapshot repeats stay silent", () => {
  const f = fixture(); f.controller.update(base);
  const played = { ...base, castKey: "cast", stage: "reeling" };
  f.controller.update(played); f.advance(1200); f.events.length = 0;
  f.controller.update({ ...played, progress: 10000, stage: "caught" });
  f.controller.update({ ...played, progress: 10000, stage: "pending" });
  assert.equal(f.events.length, 0);
  f.controller.update({ ...base, caughtCount: 1 }); f.controller.update({ ...base, caughtCount: 1 });
  assert.deepEqual(f.events.map(e => e.cueId), ["fishing.catch"]);
  assert.equal(f.events[0].ownerId, "fishing"); assert.equal(f.events[0].maxAgeMs, 250);
  f.controller.dispose();
});

test("reel accents reward new progress only, with a time cap and no repeated threshold after a slip", () => {
  const f = fixture(); f.controller.update(base);
  const playing = { ...base, castKey: "cast", stage: "reeling", held: true, inZone: true };
  f.controller.update(playing); f.advance(1200); f.events.length = 0;
  f.controller.update({ ...playing, progress: 1000 });
  f.controller.update({ ...playing, progress: 2000 });
  f.advance(500); f.controller.update({ ...playing, progress: 3000 });
  f.controller.update({ ...playing, progress: 2000 }); f.advance(500); f.controller.update({ ...playing, progress: 3000 });
  assert.deepEqual(f.events.map(e => e.cueId), ["fishing.reel", "fishing.reel"]);
  f.controller.dispose();
});

test("hidden updates consume transitions without replay, and closing releases only this owner's frame", () => {
  const f = fixture(); f.controller.update(base);
  f.controller.update({ ...base, suspended: true, castKey: "hidden", stage: "bite" });
  assert.equal(f.frame, null); f.advance(5000);
  f.controller.update({ ...base, castKey: "hidden", stage: "caught", caughtCount: 1 });
  assert.equal(f.events.length, 0); assert.equal(f.pending.size, 0);
  const forest = { ...fishingAudioFrame("forest", base), loops: [] }; f.runtime.updateFrame(forest); f.controller.dispose();
  assert.equal(f.frame, forest); f.controller.update(base); assert.equal(f.frame, forest);
});

test("the new river score is an original acoustic groove with versioned browser codecs and gentle fades", () => {
  const manifest = JSON.parse(readFileSync(`${root}/art/audio/originals-v1/manifest.json`));
  const catalog = JSON.parse(readFileSync(`${root}/features/audio/catalog/audio-catalog.json`));
  const track = manifest.assets.find(item => item.id === "music.fishing.01");
  assert.ok(Math.abs(track.durationSeconds - 24 * 4 * 60 / 76) < .001); assert.equal(track.channels, 2);
  assert.equal(track.composition.meter, "4/4"); assert.equal(track.composition.bars, 24);
  assert.equal(track.composition.bpm, 76); assert.equal(track.composition.revision, "riverside-v2");
  assert.deepEqual(track.composition.instruments, ["nylon-string plucks", "marimba", "rounded bass", "brushes", "shaker"]);
  assert.ok(track.files.every(file => file.src.includes("riverside-v2")));
  assert.ok(track.measurements.peakDb <= -3 && track.measurements.rmsDb <= -20);
  assert.ok(track.measurements.seamDelta < Math.max(.003, track.measurements.maxAdjacentDelta * 2));
  assert.equal(track.files.length, 2); assert.ok(track.files.reduce((sum, file) => sum + file.bytes, 0) < 3 * 1024 ** 2);
  const cue = catalog.cues.find(item => item.id === "music.fishing"); assert.equal(cue.bus, "music"); assert.ok(cue.fadeMs >= 1500);
  for (const cue of catalog.cues.filter(item => item.id.startsWith("fishing.") && item.id !== "fishing.hull" && item.mode === "one-shot")) assert.equal(cue.bus, "world");
});


test("the bite is heard after soaking, not when reeling starts, and hidden transitions stay consumed", () => {
  const f = fixture(); f.controller.update(base);
  const cast = { ...base, castKey: "cast-1", stage: "casting" };
  f.controller.update(cast); f.advance(1200);
  f.controller.update({ ...cast, stage: "soaking" });
  assert.equal(f.events.filter(event => event.cueId === "fishing.bite").length, 0);
  f.controller.update({ ...cast, stage: "bite" }); f.controller.update({ ...cast, stage: "bite" });
  assert.equal(f.events.filter(event => event.cueId === "fishing.bite").length, 1);
  f.controller.update({ ...cast, stage: "reeling" });
  assert.equal(f.events.filter(event => event.cueId === "fishing.bite").length, 1);
  f.controller.update({ ...cast, castKey: "cast-2", stage: "casting" });
  f.controller.update({ ...cast, castKey: "cast-2", stage: "soaking", suspended: true });
  f.controller.update({ ...cast, castKey: "cast-2", stage: "bite", suspended: true });
  f.controller.update({ ...cast, castKey: "cast-2", stage: "bite" }); f.advance(5000);
  assert.equal(f.events.filter(event => event.cueId === "fishing.bite").length, 1);
  assert.equal(f.events.filter(event => event.cueId === "fishing.cast").length, 2);
  assert.equal(f.pending.size, 0); f.controller.dispose();
});
