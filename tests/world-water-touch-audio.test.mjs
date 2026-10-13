import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldAudioController } = await vite.ssrLoadModule('/features/world/audio/world-audio-controller.ts');
const { connectForestSession } = await vite.ssrLoadModule('/features/world/state/forest-session.ts');
const scene = JSON.parse(await readFile(new URL('../features/world/tiled/forest.generated.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../features/audio/catalog/audio-catalog.json', import.meta.url)));
const point = { x: 900, y: 900 };

function fixture(t) {
  const events = [], controller = createWorldAudioController({ updateFrame() {}, clearFrame() {},
    play: event => events.push(event) });
  const session = connectForestSession(undefined, scene, 'circle', 10000, 0, () => {}, { persistence: false, sync: false });
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const input = { sceneId: 'water-touch-test', now, dusk: 0, rain: 0, levels: {}, fires: [],
    camera: { x: point.x, y: point.y, zoom: 1, viewportWidth: 400, viewportHeight: 600 } };
  const control = { scope: 'world', visible: true, observationOwner: true, emitEvents: false,
    showHero: false, actorAway: false, reducedMotion: false };
  t.after(() => { controller.dispose(); session.release(); });
  return { controller, events, advance: milliseconds => { now += milliseconds; },
    update: (changes = {}, camera = input.camera) => controller.update(scene, session.state,
      { ...input, camera }, { ...control, ...changes }) };
}

test('accepted water touches are explicit, quiet and never emitted by frame observation', t => {
  const f = fixture(t);
  assert.equal(f.controller.touchWater(point), false, 'no active view');
  f.update();
  for (let index = 0; index < 20; index++) { f.advance(20); f.update(); }
  assert.equal(f.events.length, 0, 'painting and subscriptions cannot invent a tap');
  assert.equal(f.controller.touchWater(point), true);
  const event = f.events[0];
  assert.equal(event.cueId, 'action.water.touch');
  assert.equal(event.ownerId, f.controller.getFrame().ownerId);
  assert.equal(event.maxAgeMs, 180);
  assert.equal(event.gain, 1);
  assert.equal(event.pan, 0);
  assert.equal(f.controller.touchWater(point), false, 'same-tick duplicates are silent');
  f.advance(179);
  assert.equal(f.controller.touchWater(point), false);
  f.advance(1);
  assert.equal(f.controller.touchWater(point), true);
  assert.notEqual(f.events[1].id, event.id);
});

test('water touch gain is independent of zoom and its panorama stays narrow', t => {
  const f = fixture(t), gains = [];
  for (const zoom of [.1, .5, 1, 3, 8]) {
    f.update({}, { x: 900, y: 900, zoom, viewportWidth: 400, viewportHeight: 600 });
    f.advance(200);
    assert.equal(f.controller.touchWater({ x: 970, y: 900 }), true);
    const event = f.events.at(-1);
    gains.push(event.gain);
    assert.ok(event.pan >= 0 && event.pan <= .36 + Number.EPSILON);
  }
  assert.equal(new Set(gains).size, 1);
  assert.equal(f.controller.touchWater({ x: NaN, y: 0 }), false);
  assert.equal(f.controller.touchWater({ x: 0, y: Infinity }), false);
});

test('hidden, secondary, menu and disposed views cannot request a water touch', t => {
  const f = fixture(t);
  for (const control of [{ scope: 'music' }, { visible: false }, { observationOwner: false }]) {
    f.update();
    f.update(control);
    f.advance(200);
    assert.equal(f.controller.touchWater(point), false);
  }
  f.update();
  f.controller.dispose();
  assert.equal(f.controller.touchWater(point), false);
  assert.equal(f.events.length, 0);
});

test('touch cue reuses prepared original plops with independent quiet limits', () => {
  const touch = catalog.cues.find(cue => cue.id === 'action.water.touch');
  const bobber = catalog.cues.find(cue => cue.id === 'action.fish.bobber');
  assert.deepEqual(touch.assets, bobber.assets, 'no new download or decoded buffer');
  assert.equal(touch.bus, 'world', 'direct actions obey the actions slider');
  assert.equal(touch.mode, 'one-shot');
  assert.equal(touch.maxInstances, 2);
  assert.ok(touch.gainDb <= -12);
  assert.ok(touch.cooldownMs >= 180);
  assert.ok(touch.pitchVariation > 0 && touch.pitchVariation <= .04);
  assert.notEqual(touch.id, bobber.id, 'taps must not consume fishing contact cooldown');
});
