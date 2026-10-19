import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createMarketAudioController, marketAudioFrame } = await vite.ssrLoadModule("/features/audio/ui/market-audio.ts");
const { menuAudioFrame } = await vite.ssrLoadModule("/features/audio/ui/menu-audio.ts");
const sceneId = "zhiv:mochlik:presence:host:forest";
const flush = () => new Promise(resolve => queueMicrotask(resolve));

function fixture() {
  let frame = null;
  const updates = [], events = [], clears = [];
  const runtime = {
    updateFrame(next) { frame = next; updates.push(next); },
    clearFrame(owner) { clears.push(owner); if (frame?.ownerId === owner) frame = null; },
    play(event) { events.push(event); },
  };
  return { runtime, updates, events, clears, get frame() { return frame; },
    controller: createMarketAudioController(runtime, "counter") };
}

test("both trading counters retain the exact map music decks, with a softer mix and no permanent extra loop", () => {
  for (const night of [false, true]) {
    const original = menuAudioFrame("forest", sceneId, night), market = marketAudioFrame("counter", sceneId, night);
    assert.equal(market.sceneId, original.sceneId);
    assert.deepEqual(market.loops, original.loops, "no second song, rewind or ambient allocation");
    assert.equal(market.soundscape, false, "spatial events fade while choosing a trade");
    assert.equal(market.musicDuck, .3);
    assert.ok(market.sources.every(source => source.reason === "market"));
  }
});

test("market openings, polls and day/night changes never play an entrance sound", async () => {
  const f = fixture();
  f.controller.update({ active: false, sceneId, night: false });
  f.controller.update({ active: true, sceneId: null, night: false });
  assert.equal(f.updates.length, 0);
  for (let tick = 0; tick < 100; tick++) f.controller.update({ active: true, sceneId, night: false });
  await flush();
  assert.equal(f.updates.length, 1); assert.equal(f.events.length, 0);
  f.controller.update({ active: true, sceneId, night: true }); await flush();
  assert.equal(f.updates.length, 2); assert.equal(f.events.length, 0);
  f.controller.update({ active: false, sceneId, night: true });
  f.controller.update({ active: true, sceneId, night: true }); await flush();
  assert.equal(f.events.length, 0, "reopening remains silent");
  f.controller.dispose();
});

test("closing, account replacement and Strict Mode stay silent without clearing a newer map", async () => {
  const f = fixture();
  f.controller.update({ active: true, sceneId, night: false });
  f.controller.update({ active: false, sceneId, night: false }); await flush();
  assert.equal(f.events.length, 0);
  f.controller.update({ active: true, sceneId, night: false }); f.controller.dispose();
  const next = createMarketAudioController(f.runtime, "counter");
  next.update({ active: true, sceneId, night: false }); await flush();
  assert.equal(f.events.length, 0, "effect probes and committed openings remain silent");
  const forest = menuAudioFrame("forest-return", sceneId, false);
  f.runtime.updateFrame(forest); next.dispose();
  assert.equal(f.frame, forest);
  next.update({ active: true, sceneId, night: false }); await flush();
  assert.equal(f.events.length, 0, "disposed controllers stay inert");
  const remounted = createMarketAudioController(f.runtime, "counter");
  remounted.update({ active: true, sceneId, night: false }); await flush();
  assert.equal(f.events.length, 0, "remounting never produces a coin sound");
  remounted.dispose();
  const changed = createMarketAudioController(f.runtime, "other-counter");
  changed.update({ active: true, sceneId, night: false });
  changed.update({ active: true, sceneId: "other-player", night: false }); await flush();
  assert.equal(f.events.length, 0, "changing host remains silent");
  assert.equal(f.frame.sceneId, "other-player"); changed.dispose();
});

test("background suspension releases playback and resumes the same quiet counter", async () => {
  const f = fixture();
  f.controller.update({ active: true, sceneId, night: false }); await flush();
  assert.equal(f.events.length, 0);
  f.controller.update({ active: true, suspended: true, sceneId, night: false });
  assert.equal(f.frame, null);
  f.controller.update({ active: true, suspended: true, sceneId, night: true });
  f.controller.update({ active: true, suspended: false, sceneId, night: true }); await flush();
  assert.equal(f.frame.loops[0].cueId, "music.night");
  assert.equal(f.events.length, 0, "returning to a counter stays silent");
  f.controller.dispose();
  const hiddenOpen = fixture();
  hiddenOpen.controller.update({ active: true, suspended: true, sceneId, night: false });
  hiddenOpen.controller.update({ active: true, suspended: false, sceneId, night: false }); await flush();
  assert.equal(hiddenOpen.events.length, 0, "an invisible entrance is never played later");
  hiddenOpen.controller.dispose();
});
