import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createMenuAudioController, menuAudioFrame } = await vite.ssrLoadModule("/features/audio/ui/menu-audio.ts");
const { buildWorldAudioFrame } = await vite.ssrLoadModule("/features/world/audio/world-audio-frame.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");

const sceneId = `zhiv:mochlik:presence:PLAYER:${TILED_WORLD.id}`;
function fixture() {
  let frame = null;
  const updates = [], clears = [];
  const runtime = {
    updateFrame(next) { frame = next; updates.push(next); },
    clearFrame(ownerId) { clears.push(ownerId); if (frame?.ownerId === ownerId) frame = null; },
  };
  return { runtime, updates, clears, get frame() { return frame; }, controller: createMenuAudioController(runtime, "menu") };
}

test("ordinary menu rerenders and clock ticks publish once; no scene is acquired while inactive or anonymous", () => {
  const f = fixture();
  f.controller.update({ active: false, sceneId, night: false });
  f.controller.update({ active: true, sceneId: null, night: false });
  assert.equal(f.updates.length + f.clears.length, 0);
  for (let tick = 0; tick < 1000; tick++) f.controller.update({ active: true, sceneId, night: false });
  assert.equal(f.updates.length, 1, "React/polling must not retarget the sound every render");
  assert.deepEqual(f.frame.loops.map(loop => loop.cueId), ["music.day"]);
  assert.equal(f.frame.loops[0].gain, .65);
  assert.deepEqual(f.clears, []);
  f.controller.dispose();
});

test("day/night and account changes update the frame without an intermediate clear", () => {
  const f = fixture();
  f.controller.update({ active: true, sceneId, night: false });
  f.controller.update({ active: true, sceneId, night: true });
  assert.equal(f.frame.loops[0].cueId, "music.night");
  const nextScene = sceneId.replace("PLAYER", "OTHER");
  f.controller.update({ active: true, sceneId: nextScene, night: true });
  assert.equal(f.frame.sceneId, nextScene);
  assert.equal(f.updates.length, 3);
  assert.deepEqual(f.clears, []);
  f.controller.dispose();
});

test("menu and forest reuse the same music identity at a softer menu level", () => {
  for (const night of [false, true]) {
    const menu = menuAudioFrame("menu", sceneId, night);
    const forest = buildWorldAudioFrame(TILED_WORLD, { ownerId: "forest", sceneId, now: Date.now(), dusk: Number(night), rain: 0, levels: {}, fires: [] });
    const music = forest.loops.find(loop => loop.cueId === menu.loops[0].cueId);
    assert.ok(music);
    assert.equal(menu.loops[0].id, music.id, "the handoff preserves the existing music deck");
    assert.equal(menu.sceneId, forest.sceneId, "a screen switch is not an account/scene reset");
    assert.equal(menu.soundscape, false, "the menu also fades any previously playing scene events");
    assert.equal(forest.soundscape, true);
    assert.ok(menu.loops[0].gain < music.gain);
    assert.equal(menu.loops.length, 1, "menu does not leak forest effects or voices");
  }
});

test("circle day/night blends keep both existing forest music deck keys without spatial layers", () => {
  const menu = menuAudioFrame("circle", sceneId, .4);
  const forest = buildWorldAudioFrame(TILED_WORLD, { ownerId: "forest", sceneId, now: Date.now(), dusk: .4, rain: 1, levels: {}, fires: [] });
  assert.equal(menu.loops.length, 2);
  assert.equal(menu.musicDuck, 1);
  for (const loop of menu.loops) {
    const original = forest.loops.find(candidate => candidate.id === loop.id);
    assert.ok(original, "entering the map reuses the existing deck during a daylight transition");
    assert.equal(loop.gain, original.gain * .65);
  }
});

test("menu release cannot clear a newer forest owner; returning reacquires only once", () => {
  const f = fixture();
  f.controller.update({ active: true, sceneId, night: false });
  const forest = { ...menuAudioFrame("forest", sceneId, false), loops: [] };
  f.runtime.updateFrame(forest);
  f.controller.update({ active: false, sceneId, night: false });
  f.controller.update({ active: false, sceneId, night: false });
  assert.equal(f.frame, forest);
  assert.deepEqual(f.clears, ["menu"]);
  f.controller.update({ active: true, sceneId, night: false });
  assert.equal(f.frame.ownerId, "menu");
  assert.equal(f.updates.length, 3);
  f.controller.dispose();
  assert.equal(f.frame, null);
  f.controller.dispose();
  f.controller.update({ active: true, sceneId, night: true });
  assert.equal(f.updates.length, 3);
  assert.deepEqual(f.clears, ["menu", "menu"]);
});

test("a slow forest load keeps menu music until its first ready frame takes over", () => {
  const f = fixture();
  f.controller.update({ active: true, sceneId, night: false });
  const menu = f.frame;
  for (let tick = 0; tick < 100; tick++) f.controller.update({ active: false, handoff: true, sceneId, night: false });
  assert.equal(f.frame, menu, "loading cannot start a clear-frame timeout or pause the music");
  assert.deepEqual(f.clears, []);
  const forest = menuAudioFrame("forest", sceneId, false);
  f.runtime.updateFrame(forest);
  f.controller.update({ active: false, handoff: true, sceneId, night: true });
  assert.equal(f.frame, forest, "menu must never retake ownership on a clock or DEV change");
  f.controller.dispose();
  assert.equal(f.frame, forest);
});

test("logout, inactivity and a different account clear music retained for a pending forest", () => {
  for (const stop of [
    { active: false, handoff: false, sceneId, night: false },
    { active: false, handoff: true, sceneId: null, night: false },
    { active: false, handoff: true, sceneId: "OTHER", night: false },
  ]) {
    const f = fixture();
    f.controller.update({ active: true, sceneId, night: false });
    f.controller.update({ active: false, handoff: true, sceneId, night: false });
    f.controller.update(stop);
    assert.equal(f.frame, null);
    assert.deepEqual(f.clears, ["menu"]);
    f.controller.dispose();
    assert.deepEqual(f.clears, ["menu"]);
  }
});
